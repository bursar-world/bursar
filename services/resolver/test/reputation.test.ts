import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import type { IdentityFacts, ReputationPort, TxOutcome } from '../src/chain.js';
import type { Served } from '../src/config.js';
import { openMemoryJournal } from '../src/journal.js';
import type { DisputeRecord } from '../src/journal.js';
import { createReputation, feedbackTag2 } from '../src/reputation.js';
import type { Logger } from '../src/log.js';

/**
 * A ruling becomes ERC-8004 feedback once, for a provider whose identity the registry confirms.
 *
 * The card names the agent id; the identity registry has the last word on whether that token is
 * the payee's. The journal and the registry are both asked before a post, so neither a restart nor
 * a lost journal doubles an entry, and an operator who leaves the switch off gets no write at all.
 */
const KEY = privateKeyToAccount(`0x${'ab'.repeat(32)}` as Hex);
const PAYEE = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374' as Address;
const IDENTITY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const REPUTATION = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const SERVED: Served = {
  name: 'rhc-mainnet-v6',
  escrow: '0x11e73B5632837355e250fC236cFC2Be03aD0845A',
  registry: '0xbb628E362EceE9Ce16f2e48DD79f5ed4558596e3',
  contractSet: 'v4',
};

type Posted = { agentId: bigint; score: number; tag2: string; endpoint: string; feedbackURI: string; registry: Address };

function fakePort(identity: Record<string, IdentityFacts | null>, alreadyPosted = false) {
  const posts: Posted[] = [];
  const port: ReputationPort = {
    identity: async (registry, agentId) => (registry === IDENTITY ? (identity[agentId.toString()] ?? null) : null),
    posted: async () => alreadyPosted,
    giveFeedback: async (_key, registry, agentId, score, tag2, endpoint, feedbackURI): Promise<TxOutcome> => {
      posts.push({ agentId, score, tag2, endpoint, feedbackURI, registry });
      return { hash: `0x${'77'.repeat(32)}`, status: 'success', blockNumber: 10n, gasUsed: 90_000n };
    },
  };
  return { port, posts };
}

function finalized(disputeId: bigint, medianScore: number): DisputeRecord {
  return {
    registry: SERVED.registry,
    disputeId,
    escrow: SERVED.escrow,
    escrowId: 40n,
    openedAt: 1n,
    commitEndsAt: 2n,
    revealEndsAt: 3n,
    disputedAt: 1n,
    stage: 'verified',
    snapshot: null,
    submissions: [],
    overrides: [],
    ruling: null,
    votes: [],
    outcome: { status: 'finalized', medianScore, refundBps: 1300, lockStatus: 6 },
    finalizeTx: null,
    alerted: [],
    published: true,
  };
}

const quiet: Logger & { lines: string[] } = {
  lines: [],
  info: (event) => quiet.lines.push(event),
  warn: (event) => quiet.lines.push(event),
  error: (event) => quiet.lines.push(event),
};

const card = (ids: number[]) =>
  (async () => Response.json({ registrations: ids.map((agentId) => ({ agentId, agentRegistry: `eip155:4663:${IDENTITY.toLowerCase()}` })) })) as unknown as typeof fetch;

const locks = { lock: async () => ({ payee: PAYEE }) as never };

async function journalWith(record: DisputeRecord) {
  const journal = await openMemoryJournal();
  await journal.update(record.registry, record.disputeId, () => record);
  return journal;
}

describe('posting a ruling', () => {
  it('posts the median score under the ruling tag, names the dispute, and records the hash', async () => {
    const { port, posts } = fakePort({ '42': { owner: PAYEE, subject: null } });
    const journal = await journalWith(finalized(7n, 87));
    const reputation = createReputation({
      enabled: true,
      chainId: 4663,
      cardBase: 'https://app.bursar.world/',
      chain: port,
      locks,
      journal,
      keys: [{ name: 'resolver-1', address: KEY.address, account: KEY }],
      logger: quiet,
      fetch: card([42]),
    });

    await reputation.after(SERVED, 7n);
    await reputation.after(SERVED, 7n);

    expect(posts).toEqual([
      {
        agentId: 42n,
        score: 87,
        tag2: 'rhc-mainnet-v6:7',
        endpoint: `https://app.bursar.world/providers/${PAYEE}`,
        feedbackURI: `https://app.bursar.world/api/rulings?dispute=7&registry=${SERVED.registry}`,
        registry: REPUTATION,
      },
    ]);
    expect((await journal.get(SERVED.registry, 7n))?.reputation).toEqual({ agentId: '42', hash: `0x${'77'.repeat(32)}` });
    expect(feedbackTag2(SERVED, 7n)).toBe('rhc-mainnet-v6:7');
  });

  it('believes the card only where the registry ties the token to the payee', async () => {
    const { port, posts } = fakePort({
      '1': { owner: '0x1111111111111111111111111111111111111111', subject: null },
      '2': { owner: '0x2222222222222222222222222222222222222222', subject: PAYEE },
    });
    const journal = await journalWith(finalized(8n, 40));
    const reputation = createReputation({
      enabled: true,
      chainId: 4663,
      cardBase: 'https://app.bursar.world',
      chain: port,
      locks,
      journal,
      keys: [{ name: 'resolver-1', address: KEY.address, account: KEY }],
      logger: quiet,
      fetch: card([1, 2]),
    });

    await reputation.after(SERVED, 8n);
    expect(posts.map((post) => post.agentId)).toEqual([2n]);
  });

  it('writes nothing for a provider without an identity, a dispute without a ruling, or a switch left off', async () => {
    const { port, posts } = fakePort({ '42': { owner: PAYEE, subject: null } });
    const keys = [{ name: 'resolver-1', address: KEY.address, account: KEY }];

    const none = await journalWith(finalized(9n, 55));
    await createReputation({ enabled: true, chainId: 4663, cardBase: 'https://app.bursar.world', chain: port, locks, journal: none, keys, logger: quiet, fetch: card([]) }).after(SERVED, 9n);
    expect(quiet.lines.at(-1)).toBe('reputation_no_identity');

    const failed = await journalWith({ ...finalized(10n, 55), outcome: { status: 'failed', medianScore: 0, refundBps: 0, lockStatus: 1 } });
    await createReputation({ enabled: true, chainId: 4663, cardBase: 'https://app.bursar.world', chain: port, locks, journal: failed, keys, logger: quiet, fetch: card([42]) }).after(SERVED, 10n);

    const off = await journalWith(finalized(11n, 55));
    await createReputation({ enabled: false, chainId: 4663, cardBase: 'https://app.bursar.world', chain: port, locks, journal: off, keys, logger: quiet, fetch: card([42]) }).after(SERVED, 11n);

    const elsewhere = await journalWith(finalized(12n, 55));
    await createReputation({ enabled: true, chainId: 1, cardBase: 'https://app.bursar.world', chain: port, locks, journal: elsewhere, keys, logger: quiet, fetch: card([42]) }).after(SERVED, 12n);

    expect(posts).toEqual([]);
  });

  it('takes the registry at its word when this key already left the dispute, and does not post again', async () => {
    const { port, posts } = fakePort({ '42': { owner: PAYEE, subject: null } }, true);
    const journal = await journalWith(finalized(13n, 70));
    await createReputation({
      enabled: true,
      chainId: 4663,
      cardBase: 'https://app.bursar.world',
      chain: port,
      locks,
      journal,
      keys: [{ name: 'resolver-1', address: KEY.address, account: KEY }],
      logger: quiet,
      fetch: card([42]),
    }).after(SERVED, 13n);

    expect(posts).toEqual([]);
    expect((await journal.get(SERVED.registry, 13n))?.reputation).toEqual({ agentId: '42', hash: null });
  });
});
