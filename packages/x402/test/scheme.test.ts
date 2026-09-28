import { describe, expect, test } from 'vitest';
import type { Client } from 'viem';
import { RHC_MAINNET } from '@bursar/core';
import { relayerAccount } from '../src/scheme.js';

/**
 * The relayer is the only address in the repo that writes concurrently: every /settle broadcasts
 * from it. Without a nonce manager a collision costs a settlement rejected after its ledger row and
 * its budget slot have been spent.
 */
const RELAYER_KEY = `0x${'42'.repeat(32)}` as const;

function nodeWithPendingNonce(pending: number): Client {
  return {
    async request({ method }: { method: string }): Promise<unknown> {
      if (method !== 'eth_getTransactionCount') throw new Error(`unexpected call to ${method}`);
      return `0x${pending.toString(16)}`;
    },
  } as unknown as Client;
}

describe('the relayer account', () => {
  test('two settlements in flight take consecutive nonces', async () => {
    const account = relayerAccount(RELAYER_KEY);
    const manager = account.nonceManager;

    expect(manager).toBeDefined();
    if (manager === undefined) return;

    const client = nodeWithPendingNonce(7);
    const nonces = await Promise.all([
      manager.consume({ address: account.address, chainId: RHC_MAINNET.chainId, client }),
      manager.consume({ address: account.address, chainId: RHC_MAINNET.chainId, client }),
    ]);

    expect(nonces).toEqual([7, 8]);
  });
});
