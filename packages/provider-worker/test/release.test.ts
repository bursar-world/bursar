import { escrowAbi } from '@bursar/core';
import type { Miniflare } from 'miniflare';
import { decodeFunctionData, keccak256, parseTransaction, toHex } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';

import { ENV, ESCROW, VALID, escrowPayment, facilitatorStub, offerOf, sha256Hex, worker } from './support.js';
import type { Outbound } from './support.js';

/**
 * With the provider's key the worker collects the payment itself: after the response is sent it
 * releases the lock the payment named, on that lock's escrow, with a commitment to the bytes it
 * served. The chain here is a stand-in that records the transaction the worker signed.
 */
let running: Miniflare | undefined;
afterEach(async () => {
  await running?.dispose();
  running = undefined;
});

function chainStub() {
  const sent: Hex[] = [];
  const handle: Outbound = async (request) => {
    const { id, method } = (await request.json()) as { id: number; method: string; params: unknown[] };
    const answer = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'eth_chainId':
        return answer(toHex(4663));
      case 'eth_blockNumber':
        return answer('0x10');
      case 'eth_getBlockByNumber':
        return answer({ number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', timestamp: '0x1', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'00'.repeat(32)}`, transactions: [] });
      case 'eth_maxPriorityFeePerGas':
        return answer('0x1');
      case 'eth_gasPrice':
        return answer('0x3b9aca00');
      case 'eth_estimateGas':
        return answer('0x186a0');
      case 'eth_getTransactionCount':
        return answer('0x0');
      case 'eth_sendRawTransaction': {
        const raw = (request as unknown as { _params?: unknown })._params;
        void raw;
        return answer(`0x${'ee'.repeat(32)}`);
      }
      case 'eth_getTransactionReceipt':
        return answer({ status: '0x1', transactionHash: `0x${'ee'.repeat(32)}`, blockNumber: '0x11', blockHash: `0x${'11'.repeat(32)}`, transactionIndex: '0x0', from: '0x', to: ESCROW, cumulativeGasUsed: '0x1', gasUsed: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`, effectiveGasPrice: '0x1', type: '0x2' });
      default:
        return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `unhandled ${method}` } });
    }
  };
  // The raw transaction is read before the switch above answers, so it is captured here.
  const capturing: Outbound = async (request) => {
    const clone = request.clone();
    const body = (await clone.json()) as { method: string; params: unknown[] };
    if (body.method === 'eth_sendRawTransaction') sent.push(body.params[0] as Hex);
    return handle(request);
  };
  return { sent, handle: capturing };
}

describe('releasing the lock from the worker', () => {
  it('releases on the lock’s escrow with a commitment to the served bytes', async () => {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const facilitator = facilitatorStub({ verify: () => VALID });
    const chain = chainStub();
    const outbound: Outbound = (request) => (new URL(request.url).host === 'rpc.test' ? chain.handle(request) : facilitator.handle(request));

    running = await worker(
      { ...ENV, BURSAR_PROVIDER: account.address, BURSAR_PROVIDER_KEY: key, BURSAR_RPC_URL: 'https://rpc.test' },
      outbound,
    );
    const body = JSON.stringify({ prompt: 'a koi' });
    const first = await running.dispatchFetch('http://worker/render', { method: 'POST', body });
    const offer = await offerOf(first, 'escrow');
    const paid = await running.dispatchFetch('http://worker/render', {
      method: 'POST',
      body,
      headers: { 'payment-signature': escrowPayment(offer, await sha256Hex(body)) },
    });
    expect(paid.status).toBe(200);
    const served = new Uint8Array(await paid.arrayBuffer());

    for (let waited = 0; chain.sent.length === 0 && waited < 200; waited += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chain.sent).toHaveLength(1);

    const transaction = parseTransaction(chain.sent[0]!);
    expect(transaction.to?.toLowerCase()).toBe(ESCROW.toLowerCase());
    expect(transaction.chainId).toBe(4663);
    const call = decodeFunctionData({ abi: escrowAbi, data: transaction.data! });
    expect(call.functionName).toBe('release');
    expect(call.args).toEqual([7n, keccak256(served), '']);
  });

  it('refuses a key that is not the provider’s', async () => {
    const key = generatePrivateKey();
    running = await worker({ ...ENV, BURSAR_PROVIDER_KEY: key }, async () => new Response('never', { status: 599 }));
    const response = await running.dispatchFetch('http://worker/render', { method: 'POST', body: '{}' });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ detail: expect.stringContaining('BURSAR_PROVIDER_KEY') });
  });
});
