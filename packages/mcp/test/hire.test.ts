import { RHC_MAINNET, capabilityId, commitCanonical, createRhcClient } from '@bursar/core';
import { toFunctionSelector } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeIndex } from './blockscout.js';
import { createChainGateway } from '../src/gateway.js';
import { jobDocument } from '../src/commit.js';
import type { SpendRelay } from '../src/relay.js';
import type { MandateGateway } from '../src/types.js';
import { ACCOUNT, ASSET, ESCROW, PROVIDER, createFakeNode, defaultState, lock } from './node.js';
import type { FakeNode, NodeState } from './node.js';

const CAPABILITY = 'research.summarize:1';

const SPEC = {
  task: 'Summarize the 10-K risk factors into ten bullets.',
  input: { filing: 'https://sec.example/10-K/2026' },
  acceptance: ['Ten bullets or fewer', 'Each bullet cites a page'],
};

type Spend = { inputCommit: string; inputURI: string; amount: string; merchant: string; capabilityId: string };

function relayDouble(): SpendRelay & { spends: Spend[] } {
  const spends: Spend[] = [];

  return {
    spends,
    async spend(request) {
      spends.push(request as unknown as Spend);

      return { escrowId: 42n, txHash: `0x${'cd'.repeat(32)}` };
    },
    async dispute() {
      return { txHash: `0x${'ef'.repeat(32)}` };
    },
  };
}

function gatewayFor(node: FakeNode, relay: SpendRelay | null = relayDouble()): MandateGateway {
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
    escrow: ESCROW,
    settlementAsset: ASSET,
    relay,
    index: createFakeIndex(node.state).index,
  });
}

function hireArgs(overrides: Record<string, unknown> = {}) {
  return {
    provider: PROVIDER,
    capability: CAPABILITY,
    spec: { task: SPEC.task, input: SPEC.input, acceptance: SPEC.acceptance },
    budget: 1_000_000n as never,
    ttlSeconds: 300,
    providerProof: [],
    approval: null,
    ...overrides,
  };
}

describe('the document a hire commits to', () => {
  it('holds the work and nothing the settlement already carries', () => {
    expect(Object.keys(jobDocument({ task: 'Do it', input: null, acceptance: [] })).sort()).toEqual([
      'input',
      'task',
    ]);
  });

  it('reads an absent input and an empty one as the same job', () => {
    expect(commitCanonical(jobDocument({ task: 'Do it', input: null, acceptance: [] }))).toBe(
      commitCanonical(jobDocument({ task: 'Do it', input: {}, acceptance: [] })),
    );
  });

  /**
   * `@bursar/sdk` builds this document for an agent hiring without this server. The two are
   * separate implementations of one agreement, so both are pinned to the same hash: either drifting
   * turns a lock into one the other half cannot answer.
   */
  it('hashes to the value the SDK pins for the same brief', () => {
    expect(commitCanonical(jobDocument({ task: 'Do it', input: null, acceptance: [] }))).toBe(
      commitCanonical({ task: 'Do it', input: {} }),
    );
  });

  it('refuses a hire with no brief, because a payment with no terms is a tip', () => {
    expect(() => jobDocument({ task: '   ', input: null, acceptance: [] })).toThrow(/one line saying what/u);
  });

  it('refuses an acceptance line that says nothing but still changes the commitment', () => {
    expect(() => jobDocument({ task: 'Do it', input: null, acceptance: ['fine', ' '] })).toThrow(
      /refused rather than dropped/u,
    );
  });
});

describe('hiring an agent', () => {
  let state: NodeState;

  beforeEach(() => {
    state = defaultState();
  });

  it('locks the budget against the brief, through the same spending path as a payment', async () => {
    const relay = relayDouble();

    const view = await gatewayFor(createFakeNode(state), relay).hire(hireArgs());

    expect(view.jobId).toBe('42');
    expect(view.settlementId).toBe('42');
    expect(view.task).toBe(SPEC.task);
    expect(view.specCommit).toBe(
      commitCanonical({ task: SPEC.task, input: SPEC.input, acceptance: SPEC.acceptance }),
    );
    expect(relay.spends[0]?.inputCommit).toBe(view.specCommit);
    expect(relay.spends[0]?.merchant).toBe(PROVIDER);
    expect(relay.spends[0]?.amount).toBe('1000000');
    // A hire is made in the hire class, so a mandate that allows only services refuses it on chain.
    expect(relay.spends[0]?.capabilityId).toBe(capabilityId('hire:research.summarize:1'));
    expect(view.capability).toBe('hire:research.summarize:1');
  });

  /**
   * The provider's worker fetches the lock's input URI, hashes what it read and refuses the job
   * unless the hash matches. Publishing the brief inline is what lets it do that with a node alone.
   */
  it('publishes the brief inline, so the provider needs nothing of the payer’s to be up', async () => {
    const relay = relayDouble();

    await gatewayFor(createFakeNode(state), relay).hire(hireArgs());

    const uri = relay.spends[0]?.inputURI ?? '';

    expect(uri.startsWith('data:application/json;base64,')).toBe(true);
    expect(JSON.parse(Buffer.from(uri.split(',')[1] ?? '', 'base64').toString('utf8'))).toEqual({
      task: SPEC.task,
      input: SPEC.input,
      acceptance: SPEC.acceptance,
    });
  });

  it('says what the escrow is holding, until when, and what to check before calling it done', async () => {
    const view = await gatewayFor(createFakeNode(state)).hire(hireArgs());

    expect(view.next).toContain('holds 1.00 USDG against this brief');
    expect(view.next).toContain('committing to what it delivered');
    expect(view.next).toContain('check the delivered bytes against the commitment');
  });

  it('is refused by the same limits and in the same words as a payment', async () => {
    state.previewReason = toFunctionSelector('DailyCapExceeded()');
    const relay = relayDouble();

    await expect(gatewayFor(createFakeNode(state), relay).hire(hireArgs())).rejects.toThrow(
      /daily budget does not have room/u,
    );
    expect(relay.spends).toHaveLength(0);
  });

  it('says what is missing when the limits allow a hire the mandate cannot fund', async () => {
    state.balance = 1n;

    await expect(gatewayFor(createFakeNode(state)).hire(hireArgs())).rejects.toThrow(
      /what is missing is a deposit from the principal/u,
    );
  });

  it('refuses a delivery window the escrow would not take, before it costs a transaction', async () => {
    const relay = relayDouble();

    await expect(
      gatewayFor(createFakeNode(state), relay).hire(hireArgs({ ttlSeconds: 5 })),
    ).rejects.toThrow(/deliverWithinSeconds has to sit between/u);
    expect(relay.spends).toHaveLength(0);
  });

  it('refuses a hire with no task before it costs a transaction', async () => {
    const relay = relayDouble();

    await expect(
      gatewayFor(createFakeNode(state), relay).hire(hireArgs({ spec: { task: '', input: null, acceptance: [] } })),
    ).rejects.toThrow(/one line saying what/u);
    expect(relay.spends).toHaveLength(0);
  });

  it('refuses to hire at all when this server has no signer', async () => {
    await expect(gatewayFor(createFakeNode(state), null).hire(hireArgs())).rejects.toThrow(
      /reading the mandate only/u,
    );
  });
});

describe('following a hired job', () => {
  it('reports the brief and the delivery commitment through the settlement it opened', async () => {
    const state = defaultState();
    const commit = commitCanonical({ task: SPEC.task, input: SPEC.input, acceptance: SPEC.acceptance });

    state.locks.set(42n, lock({ inputCommit: commit, status: 2, releasedAt: 1_799_999_000n, outputCommit: `0x${'ab'.repeat(32)}` }));

    const view = await gatewayFor(createFakeNode(state)).settlement(42n);

    expect(view.inputCommit).toBe(commit);
    expect(view.outputCommit).toBe(`0x${'ab'.repeat(32)}`);
    expect(view.status).toBe('paid');
  });
});

/**
 * The same vector `@bursar/sdk` pins. Two implementations of one agreement, anchored to one hash,
 * so either side drifting by a key order, a default or a trimmed space turns both suites red
 * rather than turning a live lock into one the provider cannot answer.
 */
describe('the brief both halves have to agree on', () => {
  it('hashes to the value @bursar/sdk pins for the same brief', () => {
    expect(
      commitCanonical(
        jobDocument({
          task: 'Summarize the 10-K risk factors into ten bullets.',
          input: { filing: 'https://sec.example/10-K' },
          acceptance: ['Ten bullets or fewer'],
        }),
      ),
    ).toBe('0xf377b77c359e9a3b2e67b36bc92fe1ef676a27b79165ec0c8df8a4c84e73835b');
  });
});
