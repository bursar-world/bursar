import { canonicalStringify, commitCanonical, hashRequest, requestCommit, requestDocument, requestURI, toDataUri } from '@bursar/core';
import { encodeEvidence, signDeliveryEvidence, signPayerStatement } from '@bursar/sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { DisputeStatus, LockStatus } from '../src/chain.js';
import { NO_VALIDATORS } from '../src/evidence.js';
import { MAX_SUBMISSIONS, createHandler } from '../src/http.js';
import { openMemoryJournal } from '../src/journal.js';
import type { Journal } from '../src/journal.js';
import { V3_IN_FORCE_FROM } from '../src/policy.js';
import { createVoter } from '../src/voter.js';
import type { Voter } from '../src/voter.js';
import { ESCROW, FakeChain, HOUR, REGISTRY, SERVED, SERVED_V2, SERVED_V3, tableFetcher } from './support/fake-chain.js';
import { captureAlerts, silentLogger, testKeys } from './support/keys.js';

const payee = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const PAYER: Address = '0x877c349EFb5926082C413833E8055F0991185c61';
const OPERATOR: Address = '0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4';
const MINUTE = 60n;

const JOB = { task: 'Render three frames', input: { frames: 3 } };
const OUTPUT = { frames: ['a', 'b', 'c'] };

type Rig = {
  chain: FakeChain;
  journal: Journal;
  voter: Voter;
  alerts: ReturnType<typeof captureAlerts>;
  keys: ReturnType<typeof testKeys>;
  handle: ReturnType<typeof createHandler>;
};

async function rig(options: { journal?: Journal; chain?: FakeChain; operator?: Address[] | null } = {}): Promise<Rig> {
  const chain = options.chain ?? new FakeChain();
  const keys = testKeys(3);
  if (options.chain === undefined) for (const key of keys) chain.bond(key.address);
  const journal = options.journal ?? (await openMemoryJournal());
  const alerts = captureAlerts();
  const logger = silentLogger();
  const operatorAddresses = options.operator === undefined ? [OPERATOR] : options.operator;
  const voter = createVoter({
    chain,
    journal,
    alerts,
    logger,
    keys,
    chainId: 4663,
    fetcher: tableFetcher({}),
    validators: NO_VALIDATORS,
    operatorAddresses,
  });
  const handle = createHandler({
    chain,
    journal,
    voter,
    served: [SERVED],
    chainId: 4663,
    operatorToken: 'o'.repeat(40),
    operatorAddresses,
    health: () => ({ lastPollAt: Date.now(), lastError: null, consecutiveFailures: 0, open: 0, served: [] }),
    pollMs: 30_000,
    logger,
  });
  return { chain, journal, voter, alerts, keys, handle };
}

function openJob(chain: FakeChain, patch: { payer?: Address; payee?: Address; inputURI?: string } = {}) {
  return chain.openDispute({
    payer: patch.payer ?? PAYER,
    payee: patch.payee ?? payee.address,
    inputCommit: commitCanonical(JOB),
    inputURI: patch.inputURI ?? toDataUri(canonicalStringify(JOB)),
  });
}

/** Steps the dispute every `every` seconds of chain time until `until`, as the watcher would. */
async function drive(r: Rig, disputeId: bigint, until: bigint, every = 5n * MINUTE): Promise<'open' | 'done'> {
  let result: 'open' | 'done' = 'open';
  while (r.chain.time < until && result === 'open') {
    result = await r.voter.step(SERVED, disputeId, await r.chain.head());
    r.chain.advance(every);
  }
  return result;
}

async function deliver(r: Rig, escrowId: bigint, output: unknown = OUTPUT) {
  const submission = await signDeliveryEvidence(payee, ESCROW, 4663, {
    escrowId,
    inputCommit: commitCanonical(JOB),
    outputCommit: commitCanonical(output),
    outputURI: toDataUri(canonicalStringify(output)),
    deliveredAt: r.chain.time,
  });
  return r.handle({ method: 'POST', path: '/evidence', query: new URLSearchParams(), body: encodeEvidence(submission), token: null });
}

const ruling = (r: Rig, disputeId: bigint) =>
  r.handle({ method: 'GET', path: `/rulings/${disputeId}`, query: new URLSearchParams(), body: undefined, token: null });

describe('voter', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  it('rules 0 with no evidence, commits from the primary pair at T+3h30, reveals, finalizes', async () => {
    const opened = r.chain.time;
    const { disputeId, escrowId } = openJob(r.chain);

    await drive(r, disputeId, opened + 3n * HOUR + 25n * MINUTE);
    expect(r.chain.writes).toEqual([]);

    await drive(r, disputeId, opened + 6n * HOUR);
    const commits = r.chain.writes.filter((write) => write.action === 'commit').map((write) => write.key);
    // Dispute 1: keys[1 mod 3] and keys[2 mod 3].
    expect(commits).toEqual(['resolver-2', 'resolver-3']);

    const sealed = await ruling(r, disputeId);
    expect(sealed.body).toMatchObject({ status: 'sealed' });
    expect(JSON.stringify(sealed.body)).not.toMatch(/"score"/);

    expect(await drive(r, disputeId, opened + 13n * HOUR)).toBe('done');
    expect(r.chain.disputes.get(disputeId)?.status).toBe(DisputeStatus.Finalized);
    expect(r.chain.disputes.get(disputeId)?.refundBps).toBe(10_000);
    expect(r.chain.locks.get(escrowId)?.status).toBe(LockStatus.Resolved);

    const published = await ruling(r, disputeId);
    expect(published.body).toMatchObject({ status: 'published', rule: 'P2', score: 0, policyVersion: 'v3' });
    expect((await r.journal.get(REGISTRY, disputeId))?.stage).toBe('verified');
  });

  it('finalizes in the block after the last reveal rather than waiting out the window', async () => {
    const opened = r.chain.time;
    const { disputeId } = openJob(r.chain);

    await drive(r, disputeId, opened + 6n * HOUR + 10n * MINUTE);
    expect(r.chain.disputes.get(disputeId)?.status).toBe(DisputeStatus.Finalized);
  });

  it('rules 90 on valid evidence and names its hash in the publication', async () => {
    const opened = r.chain.time;
    const { disputeId, escrowId } = openJob(r.chain);

    const accepted = await deliver(r, escrowId);
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ counted: true });

    await drive(r, disputeId, opened + 13n * HOUR);
    expect(r.chain.disputes.get(disputeId)?.medianScore).toBe(90);
    expect(r.chain.disputes.get(disputeId)?.refundBps).toBe(0);

    const published = (await ruling(r, disputeId)).body as Record<string, unknown>;
    expect(published).toMatchObject({ rule: 'P5', score: 90 });
    expect(published['evidenceHashes']).toEqual([(accepted.body as { hash: string }).hash]);
  });

  it('rules 0 on evidence whose output does not match its commitment', async () => {
    const opened = r.chain.time;
    const { disputeId, escrowId } = openJob(r.chain);

    const submission = await signDeliveryEvidence(payee, ESCROW, 4663, {
      escrowId,
      inputCommit: commitCanonical(JOB),
      outputCommit: commitCanonical({ frames: ['something else'] }),
      outputURI: toDataUri(canonicalStringify(OUTPUT)),
      deliveredAt: r.chain.time,
    });
    await r.handle({ method: 'POST', path: '/evidence', query: new URLSearchParams(), body: encodeEvidence(submission), token: null });

    await drive(r, disputeId, opened + 13n * HOUR);
    expect((await ruling(r, disputeId)).body).toMatchObject({ rule: 'P3', score: 0 });
  });

  it('does not count evidence that arrives after the cutoff, and still publishes it', async () => {
    const opened = r.chain.time;
    const { disputeId, escrowId } = openJob(r.chain);

    await drive(r, disputeId, opened + 3n * HOUR + 10n * MINUTE);
    const late = await deliver(r, escrowId);
    expect(late.body).toMatchObject({ counted: false });

    await drive(r, disputeId, opened + 13n * HOUR);
    const published = (await ruling(r, disputeId)).body as { rule: string; evidence: { counted: boolean }[] };
    expect(published.rule).toBe('P2');
    expect(published.evidence).toEqual([expect.objectContaining({ counted: false })]);
  });

  it('refuses evidence not signed by the payee', async () => {
    const { escrowId } = openJob(r.chain);
    const stranger = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
    const submission = await signDeliveryEvidence(stranger, ESCROW, 4663, {
      escrowId,
      inputCommit: commitCanonical(JOB),
      outputCommit: commitCanonical(OUTPUT),
      outputURI: toDataUri(canonicalStringify(OUTPUT)),
      deliveredAt: r.chain.time,
    });

    const answer = await r.handle({ method: 'POST', path: '/evidence', query: new URLSearchParams(), body: encodeEvidence(submission), token: null });
    expect(answer.status).toBe(403);
  });

  it('rules on the delivery when the lock names no input, so the payer is not refunded for leaving it out', async () => {
    const opened = r.chain.time;
    const { disputeId, escrowId } = openJob(r.chain, { inputURI: '' });
    expect((await deliver(r, escrowId)).body).toMatchObject({ counted: true });

    await drive(r, disputeId, opened + 13n * HOUR);
    expect(r.chain.disputes.get(disputeId)?.refundBps).toBe(0);

    const published = (await ruling(r, disputeId)).body as { rule: string; score: number; reasons: string[]; inputHash: string | null };
    expect(published).toMatchObject({ rule: 'P5', score: 90, inputHash: null });
    expect(published.reasons.join(' ')).toMatch(/names no input/);
  });

  it('checks the input against its commitment when the lock publishes one', async () => {
    const opened = r.chain.time;
    const { disputeId, escrowId } = openJob(r.chain);
    await deliver(r, escrowId);
    await drive(r, disputeId, opened + 13n * HOUR);

    const published = (await ruling(r, disputeId)).body as { rule: string; reasons: string[]; inputHash: string | null };
    expect(published).toMatchObject({ rule: 'P5' });
    expect(published.inputHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(published.reasons.join(' ')).not.toMatch(/delivery evidence alone/);

    // Bytes that do not hash to the commitment are said so, and the delivery still decides.
    const reopened = r.chain.time;
    const other = openJob(r.chain, { inputURI: toDataUri('{"other":true}') });
    await deliver(r, other.escrowId);
    await drive(r, other.disputeId, reopened + 13n * HOUR);
    const mismatch = (await ruling(r, other.disputeId)).body as { rule: string; score: number; reasons: string[] };
    expect(mismatch).toMatchObject({ rule: 'P5', score: 90 });
    expect(mismatch.reasons.join(' ')).toMatch(/does not hash to the lock's commitment/);
  });

  it('reads the call an x402 payment was opened for as the job it committed to', async () => {
    // The lock as the SDK opens one on the mandate lane: the request document inline, and the
    // commitment over its canonical bytes.
    const binding = { requestHash: hashRequest('{"prompt":"a koi"}'), salt: `0x${'5a'.repeat(32)}` as const };
    const document = requestDocument({ method: 'POST', url: 'https://api.provider.dev/render', binding });
    const inputCommit = requestCommit(document);

    const opened = r.chain.time;
    const { disputeId, escrowId } = r.chain.openDispute({ payer: PAYER, payee: payee.address, inputCommit, inputURI: requestURI(document) });
    const submission = await signDeliveryEvidence(payee, ESCROW, 4663, {
      escrowId,
      inputCommit,
      outputCommit: commitCanonical(OUTPUT),
      outputURI: toDataUri(canonicalStringify(OUTPUT)),
      deliveredAt: r.chain.time,
    });
    await r.handle({ method: 'POST', path: '/evidence', query: new URLSearchParams(), body: encodeEvidence(submission), token: null });

    await drive(r, disputeId, opened + 13n * HOUR);
    const published = (await ruling(r, disputeId)).body as { rule: string; score: number; reasons: string[]; inputHash: string | null };
    expect(published).toMatchObject({ rule: 'P5', score: 90 });
    expect(published.inputHash).toBe(keccak256(toBytes(canonicalStringify(document))));
    expect(published.reasons.join(' ')).not.toMatch(/delivery evidence alone/);
  });

  it('rules a dispute that opened before Version 3 under Version 2, as the policy promises', async () => {
    r.chain.at(V3_IN_FORCE_FROM - HOUR);
    const opened = r.chain.time;
    const { disputeId, escrowId } = openJob(r.chain, { inputURI: '' });
    await deliver(r, escrowId);

    // Its ruling lands well after Version 3 took force, and is still the one it opened under.
    await drive(r, disputeId, opened + 13n * HOUR);
    expect((await ruling(r, disputeId)).body).toMatchObject({ policyVersion: 'v2', rule: 'P1', score: 0 });
  });

  it("keeps room for the payee's evidence however many statements the payer sends", async () => {
    const payerKey = privateKeyToAccount(`0x${'c3'.repeat(32)}`);
    const { escrowId } = openJob(r.chain, { payer: payerKey.address });
    const post = (body: unknown) => r.handle({ method: 'POST', path: '/evidence', query: new URLSearchParams(), body, token: null });

    for (let index = 0; index < MAX_SUBMISSIONS; index += 1) {
      const statement = await signPayerStatement(payerKey, ESCROW, 4663, { escrowId, reason: `statement ${index}` });
      expect((await post(encodeEvidence(statement))).status).toBe(202);
    }
    const more = await signPayerStatement(payerKey, ESCROW, 4663, { escrowId, reason: 'one more' });
    expect((await post(encodeEvidence(more))).status).toBe(409);

    // The payer's room is full. The payee's is not, so the delivery still counts.
    expect((await deliver(r, escrowId)).body).toMatchObject({ counted: true });
  });

  it('reveals after a restart with an empty journal, recovering the score from the chain', async () => {
    const opened = r.chain.time;
    const { disputeId, escrowId } = openJob(r.chain);
    await deliver(r, escrowId);
    await drive(r, disputeId, opened + 6n * HOUR);
    expect(r.chain.disputes.get(disputeId)?.commitCount).toBe(2);

    const restarted = await rig({ chain: r.chain });
    await drive(restarted, disputeId, opened + 13n * HOUR);

    expect(r.chain.disputes.get(disputeId)?.status).toBe(DisputeStatus.Finalized);
    expect(r.chain.disputes.get(disputeId)?.medianScore).toBe(90);
    const published = (await ruling(restarted, disputeId)).body;
    expect(published).toMatchObject({ status: 'published', score: 90, rule: null });
    expect((published as { note: string }).note).toMatch(/recovered from the chain/);
  });

  it('seals the second key at the first key\'s score after a restart that lost the evidence', async () => {
    const opened = r.chain.time;
    const { disputeId, escrowId } = openJob(r.chain);
    await deliver(r, escrowId);
    r.chain.refuse.set('commit:resolver-3', 1_000);
    await drive(r, disputeId, opened + 4n * HOUR);
    expect(r.chain.disputes.get(disputeId)?.commitCount).toBe(1);

    // The inbox went with the journal, so this process rules P2. The chain says 90 was sealed.
    r.chain.refuse.clear();
    const restarted = await rig({ chain: r.chain });
    await drive(restarted, disputeId, opened + 13n * HOUR);

    expect(r.chain.disputes.get(disputeId)?.medianScore).toBe(90);
    const scores = [...(r.chain.disputes.get(disputeId)?.votes.values() ?? [])].map((vote) => vote.score);
    expect(scores).toEqual([90, 90]);
    expect(restarted.alerts.sent.map((alert) => alert.event)).toContain('ruling_diverged');
    expect((await ruling(restarted, disputeId)).body).toMatchObject({ rule: 'P2', score: 90 });
  });

  it('holds finalize for a third party that never reveals, then finalizes at the window end', async () => {
    const opened = r.chain.time;
    const { disputeId } = openJob(r.chain);
    r.chain.thirdPartyCommit(disputeId, '0x7062A480732EC7B0F00a3D0c968356e1671dd356');

    await drive(r, disputeId, opened + 11n * HOUR);
    expect(r.chain.disputes.get(disputeId)?.status).toBe(DisputeStatus.Revealing);
    expect(r.chain.writes.filter((write) => write.action === 'finalize')).toEqual([]);

    await drive(r, disputeId, opened + 13n * HOUR);
    expect(r.chain.disputes.get(disputeId)?.status).toBe(DisputeStatus.Finalized);
    expect(r.chain.disputes.get(disputeId)?.revealCount).toBe(2);
  });

  it('steps a standby in at once for a benched primary', async () => {
    const opened = r.chain.time;
    const { disputeId } = openJob(r.chain);
    const [, second] = r.keys;
    if (second === undefined) throw new Error('three keys');
    r.chain.bond(second.address, false);

    await drive(r, disputeId, opened + 3n * HOUR + 40n * MINUTE);
    const commits = r.chain.writes.filter((write) => write.action === 'commit').map((write) => write.key);
    expect(commits.sort()).toEqual(['resolver-1', 'resolver-3']);
    expect(r.alerts.sent.map((alert) => alert.event)).toContain('key_benched');
  });

  // The registry bars the payer's principal from voting as well as the two parties. A key that is
  // one of them is passed over before it signs anything, so the standby is not held back until 4h30.
  it('passes over a key that is a party to the dispute and steps the standby in at once', async () => {
    const opened = r.chain.time;
    const { disputeId } = openJob(r.chain);
    const [, second] = r.keys;
    if (second === undefined) throw new Error('three keys');
    r.chain.principals.set(disputeId, second.address);

    for (let at = opened; at < opened + 3n * HOUR + 40n * MINUTE; at += 5n * MINUTE) {
      r.chain.at(at);
      await r.voter.step(SERVED_V3, disputeId, await r.chain.head());
    }
    const commits = r.chain.writes.filter((write) => write.action === 'commit').map((write) => write.key);
    expect(commits.sort()).toEqual(['resolver-1', 'resolver-3']);
    const party = r.alerts.sent.filter((alert) => alert.event === 'key_is_party');
    expect(party).toHaveLength(1);
    expect(party[0]?.message).toContain('resolver-2 is a party to dispute');
  });

  it('bars nobody on a v1 registry, which has no party rule', async () => {
    const opened = r.chain.time;
    const { disputeId } = openJob(r.chain);
    const [first] = r.keys;
    if (first === undefined) throw new Error('three keys');
    r.chain.principals.set(disputeId, first.address);

    await drive(r, disputeId, opened + 3n * HOUR + 40n * MINUTE);
    expect(r.alerts.sent.map((alert) => alert.event)).not.toContain('key_is_party');
  });

  it('retries a failing commit at a rising price and brings the standby in at T+4h30', async () => {
    const opened = r.chain.time;
    const { disputeId } = openJob(r.chain);
    r.chain.refuse.set('commit:resolver-3', 1_000);

    await drive(r, disputeId, opened + 4n * HOUR + 25n * MINUTE);
    const tries = r.chain.writes.filter((write) => write.key === 'resolver-3').map((write) => write.pricing.feeBps);
    expect(tries.length).toBeGreaterThan(3);
    expect(tries.slice(0, 4)).toEqual([10_000, 12_500, 15_625, 19_531]);
    expect(r.chain.writes.some((write) => write.key === 'resolver-1')).toBe(false);

    await drive(r, disputeId, opened + 4n * HOUR + 40n * MINUTE);
    expect(r.chain.writes.some((write) => write.key === 'resolver-1' && write.action === 'commit')).toBe(true);
    expect(r.chain.disputes.get(disputeId)?.commitCount).toBe(2);
    expect(r.alerts.sent.map((alert) => alert.event)).toContain('standby_commit');
  });

  it('pages once, not every poll, when quorum is at risk', async () => {
    const opened = r.chain.time;
    const { disputeId } = openJob(r.chain);
    for (const key of r.keys) r.chain.refuse.set(`commit:${key.name}`, 1_000);

    await drive(r, disputeId, opened + 5n * HOUR + 55n * MINUTE);
    const pages = r.alerts.sent.filter((alert) => alert.event === 'quorum_at_risk');
    expect(pages).toHaveLength(1);
    expect(pages[0]?.level).toBe('CRITICAL');
  });

  it('prices the last-chance reveal at three times the estimate', async () => {
    const opened = r.chain.time;
    const { disputeId } = openJob(r.chain);
    await drive(r, disputeId, opened + 6n * HOUR - MINUTE);
    for (const key of r.keys) r.chain.refuse.set(`reveal:${key.name}`, 1_000);

    await drive(r, disputeId, opened + 11n * HOUR + 10n * MINUTE);
    const last = r.chain.writes.filter((write) => write.action === 'reveal').at(-1);
    expect(last?.pricing.feeBps).toBe(30_000);
    const events = r.alerts.sent.map((alert) => alert.event);
    expect(events).toContain('reveal_owed');
    expect(events).toContain('backup_runner_needed');
  });

  it('ignores a dispute that closed before the service first saw it', async () => {
    const { disputeId } = openJob(r.chain);
    const dispute = r.chain.disputes.get(disputeId);
    if (dispute === undefined) throw new Error('opened');
    r.chain.disputes.set(disputeId, { ...dispute, status: DisputeStatus.Failed });

    expect(await r.voter.step(SERVED, disputeId, await r.chain.head())).toBe('done');
    expect(r.alerts.sent).toEqual([]);
    expect(await r.journal.get(REGISTRY, disputeId)).toBeUndefined();
  });
});

/**
 * What a dispute that missed quorum leaves behind differs by contract set. v1 refunds the payer;
 * v2 and v3 put the lock back to Locked with a later deadline and return the bond.
 */
describe('a failed dispute', () => {
  async function failed(served: typeof SERVED, lockStatus: number) {
    const r = await rig();
    const { disputeId, escrowId } = openJob(r.chain);
    await r.voter.step(served, disputeId, await r.chain.head());
    const dispute = r.chain.disputes.get(disputeId);
    const lock = r.chain.locks.get(escrowId);
    if (dispute === undefined || lock === undefined) throw new Error('opened');
    r.chain.disputes.set(disputeId, { ...dispute, status: DisputeStatus.Failed });
    r.chain.locks.set(escrowId, { ...lock, status: lockStatus });
    expect(await r.voter.step(served, disputeId, await r.chain.head())).toBe('done');
    return r.alerts.sent.map((alert) => alert.event);
  }

  it('on v1 reports the refund', async () => {
    const events = await failed(SERVED, LockStatus.Resolved);
    expect(events).toContain('dispute_failed');
    expect(events).not.toContain('dispute_failed_reopened');
  });

  it('on v2 reports the reopened lock and does not call it frozen', async () => {
    const events = await failed(SERVED_V2, LockStatus.Locked);
    expect(events).toContain('dispute_failed_reopened');
    expect(events).not.toContain('dispute_failed');
    expect(events).not.toContain('dispute_failed_lock_frozen');
  });

  it('on v3 reports the reopened lock the same way', async () => {
    const events = await failed(SERVED_V3, LockStatus.Locked);
    expect(events).toContain('dispute_failed_reopened');
    expect(events).not.toContain('dispute_failed_lock_frozen');
  });

  it('on v1 reports a lock the escrow never ruled on as still held, with no exit of its own named', async () => {
    const r = await rig();
    const { disputeId, escrowId } = openJob(r.chain);
    await r.voter.step(SERVED, disputeId, await r.chain.head());
    const dispute = r.chain.disputes.get(disputeId);
    if (dispute === undefined) throw new Error('opened');
    r.chain.disputes.set(disputeId, { ...dispute, status: DisputeStatus.Failed });
    await r.voter.step(SERVED, disputeId, await r.chain.head());

    const frozen = r.alerts.sent.find((alert) => alert.event === 'dispute_failed_lock_frozen');
    expect(frozen?.message).toContain(`lock ${escrowId} still Disputed`);
    expect(frozen?.message).not.toMatch(/timeout/i);
  });
});

/**
 * Nothing settles a dispute on its own once its vote closes, so a lock still disputed an hour after
 * the reveal window pages, and the page names the two calls that settle it.
 */
describe('the watchdog', () => {
  async function stalled() {
    const r = await rig();
    const { disputeId } = openJob(r.chain);
    for (const key of r.keys) r.chain.refuse.set(`finalize:${key.name}`, 1_000);
    const dispute = r.chain.disputes.get(disputeId);
    if (dispute === undefined) throw new Error('opened');
    return { r, disputeId, revealEndsAt: dispute.revealEndsAt };
  }

  it('stays quiet until an hour after the vote closed', async () => {
    const { r, disputeId, revealEndsAt } = await stalled();
    r.chain.at(revealEndsAt + HOUR - MINUTE);
    await r.voter.step(SERVED_V3, disputeId, await r.chain.head());
    expect(r.alerts.sent.map((alert) => alert.event)).not.toContain('dispute_watchdog');
  });

  it('pages once for a lock still disputed after that, naming finalize and failDispute', async () => {
    const { r, disputeId, revealEndsAt } = await stalled();
    r.chain.at(revealEndsAt + HOUR);
    await r.voter.step(SERVED_V3, disputeId, await r.chain.head());
    r.chain.advance(5n * MINUTE);
    await r.voter.step(SERVED_V3, disputeId, await r.chain.head());

    const pages = r.alerts.sent.filter((alert) => alert.event === 'dispute_watchdog');
    expect(pages).toHaveLength(1);
    expect(pages[0]?.level).toBe('CRITICAL');
    expect(pages[0]?.message).toContain(`closed at ${new Date(Number(revealEndsAt) * 1_000).toISOString()}`);
    expect(pages[0]?.message).toMatch(/call finalize, or failDispute if it missed quorum/);
    expect(pages[0]?.message).not.toMatch(/timeout/i);
  });
});

describe('operator overrides', () => {
  const override = (r: Rig, disputeId: bigint, score: number, token = 'o'.repeat(40)) =>
    r.handle({ method: 'POST', path: '/override', query: new URLSearchParams(), body: { disputeId: disputeId.toString(), score, reason: 'Checked by hand.' }, token });

  it('applies an override made before the cutoff', async () => {
    const r = await rig();
    const opened = r.chain.time;
    const { disputeId } = openJob(r.chain);

    expect((await override(r, disputeId, 72)).status).toBe(202);
    await drive(r, disputeId, opened + 13n * HOUR);
    expect(r.chain.disputes.get(disputeId)?.medianScore).toBe(72);
    expect((await ruling(r, disputeId)).body).toMatchObject({ rule: 'P6', score: 72 });
  });

  it('refuses an override after the cutoff', async () => {
    const r = await rig();
    const { disputeId } = openJob(r.chain);
    r.chain.advance(3n * HOUR + MINUTE);
    expect((await override(r, disputeId, 90)).status).toBe(409);
  });

  it('refuses an override on a dispute the operator is party to, and labels the ruling', async () => {
    const r = await rig();
    const opened = r.chain.time;
    const { disputeId } = openJob(r.chain, { payer: OPERATOR });

    const answer = await override(r, disputeId, 90);
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ error: 'operator_party' });

    await drive(r, disputeId, opened + 13n * HOUR);
    expect((await ruling(r, disputeId)).body).toMatchObject({ rule: 'P2', operatorParty: true });
  });

  it('refuses a wrong token, and refuses everything when no operator addresses are configured', async () => {
    const r = await rig();
    const { disputeId } = openJob(r.chain);
    expect((await override(r, disputeId, 90, 'x'.repeat(40))).status).toBe(401);

    const unconfigured = await rig({ operator: null });
    const other = openJob(unconfigured.chain);
    expect((await override(unconfigured, other.disputeId, 90)).status).toBe(403);
  });

  it('refuses a score outside the four the policy emits', async () => {
    const r = await rig();
    const { disputeId } = openJob(r.chain);
    expect((await override(r, disputeId, 80)).status).toBe(400);
  });
});
