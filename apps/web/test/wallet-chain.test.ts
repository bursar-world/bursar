import { describe, expect, it } from 'vitest';

import { CHAIN_ID } from '@/chain/rhc';
import { onWrongChain, pinChain } from '@/wallet/write';
import { settledPhase } from '@/components/tx-button';

/**
 * A write signed on another network is a write to whatever lives at that address there. The
 * console refuses it twice: the button offers only the switch, and every write carries the
 * deployment's chain id so the wallet library refuses it before a wallet opens.
 */
describe('the deployment chain', () => {
  it('is pinned onto every write', () => {
    const pinned = pinChain({ address: '0x1111111111111111111111111111111111111111', functionName: 'pause' });

    expect(pinned.chainId).toBe(CHAIN_ID);
    expect(pinned.functionName).toBe('pause');
  });

  it('wins over a chain id a caller supplied', () => {
    expect(pinChain({ chainId: 1 }).chainId).toBe(CHAIN_ID);
  });

  it('blocks a wallet connected to any other network', () => {
    expect(onWrongChain({ isConnected: true, chainId: 1 })).toBe(true);
    expect(onWrongChain({ isConnected: true, chainId: 46_630 })).toBe(true);
  });

  it('blocks a connected wallet whose network is not known yet', () => {
    expect(onWrongChain({ isConnected: true, chainId: undefined })).toBe(true);
  });

  it('lets the deployment chain through, and leaves a disconnected reader to the connect prompt', () => {
    expect(onWrongChain({ isConnected: true, chainId: CHAIN_ID })).toBe(false);
    expect(onWrongChain({ isConnected: false, chainId: undefined })).toBe(false);
  });
});

/**
 * A receipt under a different hash is the wallet's doing. Only a reprice is the reader's own call
 * landing; a cancel ran nothing and a replacement ran something else.
 */
describe('a receipt for a transaction the wallet swapped', () => {
  it('counts a sped-up call as the call confirming', () => {
    expect(settledPhase({ swapped: true, reason: 'repriced', success: true })).toBe('confirmed');
    expect(settledPhase({ swapped: true, reason: 'repriced', success: false })).toBe('failed');
  });

  it('never counts a cancel or a different call as confirmed, even when it succeeded', () => {
    expect(settledPhase({ swapped: true, reason: 'cancelled', success: true })).toBe('replaced');
    expect(settledPhase({ swapped: true, reason: 'replaced', success: true })).toBe('replaced');
  });

  it('treats a swap nobody explained as a replacement', () => {
    expect(settledPhase({ swapped: true, reason: undefined, success: true })).toBe('replaced');
  });

  it("reads the reader's own receipt by its status", () => {
    expect(settledPhase({ swapped: false, reason: undefined, success: true })).toBe('confirmed');
    expect(settledPhase({ swapped: false, reason: undefined, success: false })).toBe('failed');
  });
});
