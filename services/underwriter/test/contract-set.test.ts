import type { Abi, Hex } from 'viem';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  toFunctionSelector,
} from 'viem';
import { describe, expect, it } from 'vitest';

import { RHC_MAINNET, deployment, mandateAccountAbi, mandateAccountAbiV1, viemChain } from '@bursar/core';
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

/**
 * `limits` is eight words on a v1 account and eleven on a v2 one. Decoding a v1 answer with the v2
 * ABI fails outright, so every v1 account read as unreachable until the read followed the escrow.
 */
function accountNode(set: 'v1' | 'v2'): RhcPublicClient {
  const abi = (set === 'v1' ? mandateAccountAbiV1 : mandateAccountAbi) as Abi;
  const escrow = deployment(set === 'v1' ? 'rhc-mainnet' : 'rhc-mainnet-v2').contracts.Escrow;
  const window = { cap: 500_000n, spent: 0n, duration: 86_400n, start: 1n, epoch: 0n };
  const answers: Record<string, unknown> = {
    principal: MERCHANT,
    agent: MERCHANT,
    settlementAsset: RHC_MAINNET.usdg,
    escrow,
    paused: false,
    revoked: false,
    version: 1n,
    nonce: 0n,
    documentHash: CAPABILITY,
    limits: {
      perCallCap: 100_000n,
      dailyCap: 500_000n,
      monthlyCap: 2_000_000n,
      dailyWindow: 86_400n,
      monthlyWindow: 2_592_000n,
      approvalThreshold: 100_000n,
      validFrom: 0n,
      validUntil: 0n,
      ...(set === 'v2' ? { classMask: 7, totalCap: 1_000_000n, lane: 0 } : {}),
    },
    window,
    remaining: [100_000n, 500_000n, 2_000_000n],
    merchantGate: 0,
    merchantRoot: CAPABILITY,
  };

  return createPublicClient({
    chain: viemChain(RHC_MAINNET),
    transport: custom(
      {
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          if (method === 'eth_chainId') return `0x${RHC_MAINNET.chainId.toString(16)}`;
          if (method === 'eth_call') {
            const { to, data } = (params as [{ to: string; data: Hex }])[0];
            if (to.toLowerCase() === RHC_MAINNET.usdg.toLowerCase()) {
              return encodeAbiParameters([{ type: 'uint256' }], [79_952n]);
            }
            const { functionName } = decodeFunctionData({ abi, data });
            return encodeFunctionResult({ abi, functionName, result: answers[functionName] } as never);
          }
          throw new Error(`this node does not answer ${method}`);
        },
      },
      { retryCount: 0 },
    ),
  });
}

describe('readAccount by contract set', () => {
  it('reads a v1 account, whose limits carry no class, total or lane', async () => {
    const state = await createMandateChain(accountNode('v1')).readAccount(ACCOUNT);

    expect(state.contractSet).toBe('v1');
    expect(state.limits.perCallCapMicros).toBe(100_000n);
    expect(state.limits).not.toHaveProperty('classMask');
    expect(state.limits).not.toHaveProperty('totalCapMicros');
    expect(state.limits).not.toHaveProperty('lane');
  });

  it('reads a v2 account with its class mask, lifetime total and lane', async () => {
    const state = await createMandateChain(accountNode('v2')).readAccount(ACCOUNT);

    expect(state.contractSet).toBe('v2');
    expect(state.limits).toMatchObject({ perCallCapMicros: 100_000n, classMask: 7, totalCapMicros: 1_000_000n, lane: 0 });
    expect(state.balanceMicros).toBe(79_952n);
  });
});
