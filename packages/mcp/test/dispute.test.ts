import { RHC_MAINNET, createRhcClient, deployment } from '@bursar/core';
import type { Address } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeIndex } from './blockscout.js';
import { createChainGateway } from '../src/gateway.js';
import type { MandateGateway } from '../src/types.js';
import { ACCOUNT, ASSET, ESCROW, PROVIDER, createFakeNode, defaultState, lock } from './node.js';
import type { FakeNode, NodeState } from './node.js';

const OPENED_AT = 1_800_000_000n;

function gatewayFor(node: FakeNode, escrows: readonly Address[] = [ESCROW]): MandateGateway {
  const { client } = createRhcClient({
    chain: RHC_MAINNET,
    providers: [
      { name: 'primary', url: 'http://primary.test' },
      { name: 'fallback', url: 'http://fallback.test' },
    ],
    fetchFn: node.fetchFn,
  });

  return createChainGateway({
    client,
    account: ACCOUNT,
    escrows,
    settlementAsset: ASSET,
    relay: null,
    index: createFakeIndex(node.state).index,
  });
}

describe('reading a contested payment and its ruling', () => {
  let state: NodeState;

  beforeEach(() => {
    state = defaultState();
    state.terms.resolverFeeBps = 50;
    state.locks.set(
      42n,
      lock({ amount: 2_500_000n, status: 4, disputedAt: OPENED_AT, disputer: ACCOUNT, bond: 125_000n }),
    );
    state.oracle.disputes.set(4n, {
      escrowId: 42n,
      openedAt: OPENED_AT,
      commitEndsAt: OPENED_AT + 21_600n,
      revealEndsAt: OPENED_AT + 43_200n,
      commitCount: 3,
      revealCount: 0,
      medianScore: 0,
      refundBps: 0,
      rewardShares: 0,
      status: 1,
    });
  });

  it('reports the phase, the clock and what contesting it cost', async () => {
    const view = await gatewayFor(createFakeNode(state)).dispute(42n);

    expect(view.disputeId).toBe('4');
    expect(view.phase).toBe('committing');
    expect(view.openedBy.toLowerCase()).toBe(ACCOUNT.toLowerCase());
    expect(view.bond).toEqual({ micro: '125000', usdg: '0.125' });
    expect(view.commitEndsAt).toBe('2027-01-15T14:00:00Z');
    expect(view.revealEndsAt).toBe('2027-01-15T20:00:00Z');
    expect(view.quorum).toBe(2);
    expect(view.commitCount).toBe(3);
    // The vote closes with the reveal window, and from then anyone can settle it.
    expect(view.resolveBy).toBe(view.revealEndsAt);
    expect(view.ruling).toBeNull();
    expect(view.next).toContain('sealing their scores');
  });

  it('says anyone can settle a vote once its reveal window has shut', async () => {
    state.timestamp = OPENED_AT + 50_000n;

    const view = await gatewayFor(createFakeNode(state)).dispute(42n);

    expect(view.phase).toBe('committing');
    expect(view.next).toContain('The vote has closed. Anyone can settle it now');
    expect(view.next).toContain('puts the payment back on hold with a new deadline and returns the bond');
  });

  /**
   * The escrow zeroes the bond the moment a ruling returns or forfeits it, so a settled lock
   * reports none. What was posted is recomputed from the rate the escrow charged.
   */
  it('reads the ruling and cuts the settlement exactly as the escrow cut it', async () => {
    state.locks.set(
      42n,
      lock({ amount: 2_500_000n, status: 6, disputedAt: OPENED_AT, disputer: ACCOUNT, bond: 0n, counted: true }),
    );
    state.oracle.disputes.set(4n, {
      ...state.oracle.disputes.get(4n)!,
      status: 3,
      revealCount: 3,
      medianScore: 60,
      refundBps: 7_500,
    });

    const view = await gatewayFor(createFakeNode(state)).dispute(42n);

    expect(view.phase).toBe('finalized');
    expect(view.ruling).toEqual({
      medianScore: 60,
      refundBps: 7_500,
      refundedToMandate: { micro: '1865625', usdg: '1.865625' },
      paidToProvider: { micro: '618766', usdg: '0.618766' },
      resolverFee: { micro: '12500', usdg: '0.0125' },
      protocolFee: { micro: '3109', usdg: '0.003109' },
      bondReturned: true,
    });

    const legs = ['refundedToMandate', 'paidToProvider', 'protocolFee', 'resolverFee'] as const;
    const total = legs.reduce((sum, leg) => sum + BigInt(view.ruling?.[leg].micro ?? '0'), 0n);

    expect(total).toBe(2_500_000n);
    expect(view.bond).toEqual({ micro: '125000', usdg: '0.125' });
    expect(view.next).toContain('scored the delivery 60 out of 100');
    expect(view.next).toContain('1.865625 USDG back to the mandate');
  });

  it('keeps the bond where the ruling went against the side that opened the dispute', async () => {
    state.locks.set(
      42n,
      lock({ amount: 2_500_000n, status: 6, disputedAt: OPENED_AT, disputer: ACCOUNT, bond: 0n }),
    );
    state.oracle.disputes.set(4n, {
      ...state.oracle.disputes.get(4n)!,
      status: 3,
      revealCount: 3,
      medianScore: 95,
      refundBps: 0,
    });

    expect((await gatewayFor(createFakeNode(state)).dispute(42n)).ruling?.bondReturned).toBe(false);
  });

  /**
   * A complaint about a payment the provider already took never reaches a resolver. Reporting it as
   * a vote in progress would leave a payer waiting for a ruling nobody is going to make.
   */
  it('separates a complaint about a payment already made from a vote', async () => {
    state.locks.set(
      42n,
      lock({
        amount: 2_500_000n,
        status: 4,
        disputedAt: OPENED_AT,
        disputer: ACCOUNT,
        releasedAt: OPENED_AT - 100n,
        counted: true,
      }),
    );

    const view = await gatewayFor(createFakeNode(state)).dispute(42n);

    expect(view.recordOnly).toBe(true);
    expect(view.disputeId).toBe('0');
    expect(view.bond).toEqual({ micro: '0', usdg: '0.00' });
    expect(view.resolveBy).toBeNull();
    expect(view.next).toContain('nothing left to split');
    expect(view.next).toContain('settlement history');
  });

  it('says a failed vote put the payment back on hold rather than describing it as a ruling', async () => {
    state.locks.set(
      42n,
      lock({ amount: 2_500_000n, status: 1, disputedAt: OPENED_AT, disputer: ACCOUNT, deadline: OPENED_AT + 50_000n }),
    );
    state.oracle.disputes.set(4n, { ...state.oracle.disputes.get(4n)!, status: 4 });

    const view = await gatewayFor(createFakeNode(state)).dispute(42n);

    expect(view.phase).toBe('failed');
    expect(view.ruling).toBeNull();
    expect(view.settlementStatus).toBe('held');
    expect(view.next).toContain('put the payment back on hold with a new deadline and returned the bond');
    expect(view.next).toContain('The provider can still deliver');
  });

  it('says a failed vote on the v1 escrow refunded the mandate, which is what v1 does', async () => {
    const v1 = deployment('rhc-mainnet').contracts.Escrow;
    state.escrow = v1;
    state.terms.minLock = null;
    state.locks.set(42n, lock({ amount: 2_500_000n, status: 6, disputedAt: OPENED_AT, disputer: ACCOUNT }));
    state.oracle.disputes.set(4n, { ...state.oracle.disputes.get(4n)!, status: 4, refundBps: 10_000 });

    const view = await gatewayFor(createFakeNode(state), [ESCROW, v1]).dispute(42n);

    expect(view.phase).toBe('failed');
    expect(view.next).toContain('refunded the mandate in full');
  });

  it('reads a payment put back on hold and then delivered as a failed vote, not a complaint', async () => {
    state.locks.set(
      42n,
      lock({ amount: 2_500_000n, status: 2, disputedAt: OPENED_AT, releasedAt: OPENED_AT + 700n, disputer: ACCOUNT }),
    );
    state.oracle.disputes.set(4n, { ...state.oracle.disputes.get(4n)!, status: 4 });

    const view = await gatewayFor(createFakeNode(state)).dispute(42n);

    expect(view.recordOnly).toBe(false);
    expect(view.phase).toBe('failed');
    expect(view.next).toContain('Paid to the provider.');
  });

  it('says plainly when an escrow has nobody to hear a dispute', async () => {
    state.terms.resolver = '0x0000000000000000000000000000000000000000';

    const view = await gatewayFor(createFakeNode(state)).dispute(42n);

    expect(view.phase).toBe('none');
    expect(view.next).toContain('no dispute layer');
  });

  it('points at the settlement rather than inventing a dispute nobody opened', async () => {
    state.locks.set(42n, lock({ amount: 2_500_000n, status: 1 }));

    await expect(gatewayFor(createFakeNode(state)).dispute(42n)).rejects.toThrow(
      /Nobody has contested settlement 42/u,
    );
  });

  it('refuses an id the escrow never issued and one another payer opened', async () => {
    await expect(gatewayFor(createFakeNode(state)).dispute(99n)).rejects.toThrow(/No settlement carries id 99/u);

    state.locks.set(42n, lock({ payer: PROVIDER, status: 4, disputedAt: OPENED_AT }));

    await expect(gatewayFor(createFakeNode(state)).dispute(42n)).rejects.toThrow(
      /was not paid for by this mandate/u,
    );
  });
});
