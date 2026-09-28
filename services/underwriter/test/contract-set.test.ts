import { createPublicClient, custom, encodeAbiParameters, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';

import { RHC_MAINNET, deployment, viemChain } from '@bursar/core';
import type { RhcPublicClient } from '@bursar/core';

import { createMandateChain } from '../src/chain.js';
import type { Address, Hex32 } from '../src/document.js';

/**
 * A v1 account answers the three-argument `previewSpend` and a v2 account the four-argument one,
 * and each reverts on the other's selector. Which one is sent is decided by the escrow the
 * account was created against.
 */

const ACCOUNT: Address = '0x00000000000000000000000000000000000000a1';
const MERCHANT: Address = '0x00000000000000000000000000000000000000b2';
const CAPABILITY = `0x${'11'.repeat(32)}` as Hex32;

const ESCROW_SELECTOR = toFunctionSelector('escrow()');

function nodeFor(escrow: Address, calls: string[]): RhcPublicClient {
  return createPublicClient({
    chain: viemChain(RHC_MAINNET),
    transport: custom(
      {
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          if (method === 'eth_chainId') return `0x${RHC_MAINNET.chainId.toString(16)}`;
          if (method === 'eth_call') {
            const data = ((params as [{ data?: string; input?: string }])[0].data ??
              (params as [{ input?: string }])[0].input) as string;
            calls.push(data.slice(0, 10));
            if (data.startsWith(ESCROW_SELECTOR)) return encodeAbiParameters([{ type: 'address' }], [escrow]);
            return encodeAbiParameters([{ type: 'bool' }, { type: 'bytes4' }], [true, '0x00000000']);
          }
          throw new Error(`this node does not answer ${method}`);
        },
      },
      { retryCount: 0 },
    ),
  });
}

describe('previewSpend by contract set', () => {
  it('sends the v1 call to an account on the v1 escrow', async () => {
    const calls: string[] = [];
    const chain = createMandateChain(nodeFor(deployment('rhc-mainnet').contracts.Escrow, calls));

    expect((await chain.previewSpend(ACCOUNT, MERCHANT, CAPABILITY, 1n as never)).allowed).toBe(true);
    expect(calls).toContain(toFunctionSelector('previewSpend(address,bytes32,uint128)'));
  });

  it('sends the v2 call, with the class, to an account on the v2 escrow', async () => {
    const calls: string[] = [];
    const chain = createMandateChain(nodeFor(deployment('rhc-mainnet-v2').contracts.Escrow, calls));

    await chain.previewSpend(ACCOUNT, MERCHANT, CAPABILITY, 1n as never, undefined, 1);
    expect(calls).toContain(toFunctionSelector('previewSpend(address,bytes32,uint128,uint8)'));
  });
});
