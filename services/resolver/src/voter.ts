import { commitmentFor, parseEvidence } from '@bursar/sdk';
import type { Address, Hex } from 'viem';

import type { Alerter, AlertLevel } from './alert.js';
import { DisputeStatus, LockStatus, ResolverStatus, WriteFailed } from './chain.js';
import type { ChainPort, DisputeState, Head, Pricing, RegistryTerms, TxOutcome } from './chain.js';
import type { Served } from './config.js';
import { checkDelivery, isOperatorParty, takeSnapshot } from './evidence.js';
import type { Fetcher, Validators } from './evidence.js';
import type { DisputeRecord, Journal, Stage, StoredVote } from './journal.js';
import type { ResolverKey } from './keys.js';
import { describeError } from './log.js';
import type { LogFields, Logger } from './log.js';
import { rule } from './policy.js';
import type { DeliveryCheck, PolicyEvidence } from './policy.js';
import { recoverScore, saltFor } from './salt.js';
import { WATCHDOG_SECONDS, rotation, timeline } from './schedule.js';
import type { Timeline } from './schedule.js';

export type VoterOptions = {
  readonly chain: ChainPort;
  readonly journal: Journal;
  readonly alerts: Alerter;
  readonly logger: Logger;
  readonly keys: readonly ResolverKey[];
  readonly chainId: number;
  readonly fetcher: Fetcher;
  readonly validators: Validators;
  readonly operatorAddresses: readonly Address[] | null;
};

export type Voter = {
  /**
   * Carries one dispute as far as the chain and the clock allow, and says whether it still needs
   * watching. Every decision is taken from the chain as it reads now plus the journal, so running
   * it twice, or after a restart with nothing on disk, does the same thing once.
   */
  step(served: Served, disputeId: bigint, head: Head): Promise<'open' | 'done'>;
  /** The record for a dispute, created from the chain if this process has not seen it yet. */
  open(served: Served, disputeId: bigint): Promise<DisputeRecord>;
};

/** Each retry of the same write is priced a quarter higher, up to three times the estimate. */
const BUMP_BPS = 12_500;
const MAX_FEE_BPS = 30_000;
const LAST_CHANCE: Pricing = { feeBps: MAX_FEE_BPS };

const STAGES: readonly Stage[] = ['observed', 'evidence_open', 'ruled', 'committed', 'revealed', 'finalized', 'verified'];

/** Forward only. A reading that lags the journal must not walk a dispute back a stage. */
function advance(current: Stage, next: Stage): Stage {
  if (current === 'closed' || current === 'verified') return current;
  if (next === 'closed' || next === 'abstained') return next;
  if (current === 'abstained') return next === 'finalized' || next === 'verified' ? next : current;
  return STAGES.indexOf(next) > STAGES.indexOf(current) ? next : current;
}

const isZero = (value: Hex): boolean => /^0x0*$/.test(value);

export function createVoter(options: VoterOptions): Voter {
  const { chain, journal, alerts, logger, keys, chainId } = options;

  const termsCache = new Map<string, RegistryTerms>();
  /** Consecutive failed attempts per write, so each retry is priced above the last. */
  const attempts = new Map<string, number>();
  /** The parsed input per dispute, for a validator. Memory only: nothing published depends on it. */
  const inputs = new Map<string, unknown>();

  async function terms(registry: Address): Promise<RegistryTerms> {
    const cached = termsCache.get(registry);
    if (cached !== undefined) return cached;
    const read = await chain.terms(registry);
    termsCache.set(registry, read);
    return read;
  }

  function pricing(label: string): Pricing {
    const tries = attempts.get(label) ?? 0;
    return { feeBps: Math.min(Math.round(10_000 * (BUMP_BPS / 10_000) ** tries), MAX_FEE_BPS) };
  }

  const patch = (served: Served, disputeId: bigint, change: (record: DisputeRecord) => DisputeRecord): Promise<DisputeRecord | undefined> =>
    journal.update(served.registry, disputeId, (current) => (current === undefined ? undefined : change(current)));

  async function open(served: Served, disputeId: bigint, known?: DisputeState): Promise<DisputeRecord> {
    const existing = await journal.get(served.registry, disputeId);
    if (existing !== undefined) return existing;

    const dispute = known ?? (await chain.dispute(served.registry, disputeId));
    if (dispute.status === DisputeStatus.None) throw new Error(`Dispute ${disputeId} does not exist on ${served.registry}.`);
    const lock = await chain.lock(served.escrow, dispute.escrowId);

    const created = await journal.update(served.registry, disputeId, (current) =>
      current ?? {
        registry: served.registry,
        disputeId,
        escrow: served.escrow,
        escrowId: dispute.escrowId,
        openedAt: dispute.openedAt,
        commitEndsAt: dispute.commitEndsAt,
        revealEndsAt: dispute.revealEndsAt,
        disputedAt: lock.disputedAt,
        stage: 'observed',
        snapshot: null,
        submissions: [],
        overrides: [],
        ruling: null,
        votes: [],
        outcome: null,
        finalizeTx: null,
        alerted: [],
        published: false,
      },
    );
    if (created === undefined) throw new Error('The journal did not keep a new record.');
    return created;
  }

  /** Sent once per dispute and key, however many polls and restarts see the same fault. */
  async function once(
    served: Served,
    record: DisputeRecord,
    key: string,
    level: AlertLevel,
    event: string,
    message: string,
    fields: LogFields = {},
  ): Promise<void> {
    const current = (await journal.get(served.registry, record.disputeId)) ?? record;
    if (current.alerted.includes(key)) return;
    await alerts.send(level, event, message, { disputeId: record.disputeId, registry: served.registry, ...fields });
    await patch(served, record.disputeId, (r) => ({ ...r, alerted: [...r.alerted, key] }));
  }

  async function snapshot(served: Served, record: DisputeRecord, head: Head): Promise<DisputeRecord> {
    if (record.snapshot !== null) return record;

    const taken = await takeSnapshot({
      chain,
      escrow: served.escrow,
      escrowId: record.escrowId,
      block: head.number,
      chainTime: head.timestamp,
      fetcher: options.fetcher,
    });
    inputs.set(`${served.registry}:${record.disputeId}`, taken.inputDocument);

    const operatorParty = isOperatorParty(taken.lock, options.operatorAddresses);
    const next =
      (await patch(served, record.disputeId, (r) => ({
        ...r,
        stage: advance(r.stage, 'evidence_open'),
        snapshot: {
          block: taken.block,
          chainTime: taken.chainTime,
          lock: taken.lock,
          heldInDispute: taken.heldInDispute,
          mandate: taken.mandate,
          payee: taken.payee,
          input: taken.input,
          inputHash: taken.inputHash,
          operatorParty,
        },
      }))) ?? record;

    const provisional = rule(await evidenceAt(next, head.timestamp));
    await once(served, next, 'observed', 'INFO', 'dispute_observed', `Dispute ${record.disputeId} is open. Provisional ruling ${provisional.ruleId}.`, {
      escrowId: record.escrowId,
      amount: taken.lock.amount,
      payer: taken.lock.payer,
      payee: taken.lock.payee,
      provisionalScore: provisional.score ?? 'no vote',
      operatorParty,
    });
    return next;
  }

  async function evidenceAt(record: DisputeRecord, cutoff: bigint): Promise<PolicyEvidence & { hashes: Hex[]; transient: boolean }> {
    const shot = record.snapshot;
    if (shot === null) throw new Error('A ruling needs a snapshot first.');

    const inputDocument = inputs.get(`${record.registry}:${record.disputeId}`) ?? null;
    const counted = record.submissions.filter((entry) => entry.wire.kind === 'delivery' && entry.receivedAt <= cutoff);
    const deliveries: DeliveryCheck[] = [];
    for (const entry of counted) {
      const submission = parseEvidence(entry.wire);
      if (submission.kind !== 'delivery') continue;
      deliveries.push(
        await checkDelivery({ submission, lock: shot.lock, inputDocument, fetcher: options.fetcher, validators: options.validators }),
      );
    }

    const override = record.overrides.filter((entry) => entry.receivedAt <= cutoff).at(-1);

    return {
      heldInDispute: shot.heldInDispute,
      input: shot.input,
      deliveries,
      override: override === undefined ? null : { score: override.score, reason: override.reason },
      operatorParty: shot.operatorParty,
      hashes: deliveries.map((delivery) => delivery.hash as Hex),
      // A host that did not answer at the cutoff may answer a minute later. The ruling waits for
      // the commit time before it treats an unfetchable output as the payee's failure.
      transient: deliveries.some((delivery) => delivery.output.kind === 'unfetchable'),
    };
  }

  async function decide(served: Served, record: DisputeRecord, tl: Timeline, head: Head): Promise<DisputeRecord> {
    if (record.ruling !== null || head.timestamp < tl.evidenceCutoff || record.snapshot === null) return record;

    const evidence = await evidenceAt(record, tl.evidenceCutoff);
    if (evidence.transient && head.timestamp < tl.commitAt) return record;

    const ruling = rule(evidence);
    const next =
      (await patch(served, record.disputeId, (r) =>
        r.ruling !== null
          ? r
          : {
              ...r,
              stage: advance(r.stage, ruling.score === null ? 'abstained' : 'ruled'),
              ruling: { ...ruling, decidedAt: head.timestamp, evidenceHashes: evidence.hashes },
            },
      )) ?? record;

    await once(
      served,
      next,
      'ruled',
      ruling.score === null ? 'WARN' : 'INFO',
      ruling.score === null ? 'dispute_abstained' : 'ruling_decided',
      ruling.score === null
        ? `Dispute ${record.disputeId}: no vote. ${ruling.reasons.join(' ')}`
        : `Dispute ${record.disputeId}: rule ${ruling.ruleId}, score ${ruling.score}. Sealed until the reveals land.`,
      { rule: ruling.ruleId },
    );
    return next;
  }

  async function eligible(served: Served, key: ResolverKey): Promise<boolean> {
    const standing = await chain.resolver(served.registry, key.address);
    if (standing.status !== ResolverStatus.Active) return false;
    return chain.bondable(served.registry, key.address, standing.bond);
  }

  async function commit(served: Served, record: DisputeRecord, dispute: DisputeState, tl: Timeline, head: Head): Promise<void> {
    const ruling = record.ruling;
    if (ruling === null || ruling.score === null || head.timestamp < tl.commitAt) return;

    const { quorum, maxVoters } = await terms(served.registry);
    const sealed = await Promise.all(keys.map((key) => chain.committedBy(served.registry, record.disputeId, key.address)));
    const ours = sealed.filter((commitment) => !isZero(commitment)).length;
    if (ours >= quorum) return;

    const { primary, standby } = rotation(record.disputeId, keys.length, quorum);
    const usable: number[] = [];
    for (const index of [...primary, ...standby]) {
      const key = keys[index];
      if (key === undefined) continue;
      if (await eligible(served, key)) {
        usable.push(index);
      } else {
        await once(served, record, `benched:${key.name}`, 'WARN', 'key_benched', `${key.name} cannot vote: it is not active or its bond is below the floor.`, {
          key: key.name,
          address: key.address,
        });
      }
    }

    // Before the standby time the first `quorum` usable keys in rotation order sign: the primary
    // pair, with a usable standby stepping in at once for a benched primary. From the standby time
    // every usable key is a candidate, and the loop stops as soon as quorum is ours.
    const candidates = head.timestamp >= tl.standbyAt ? usable : usable.slice(0, quorum);
    const wanted = candidates.filter((index) => isZero(sealed[index] ?? '0x'));

    if (head.timestamp >= tl.standbyAt && ours < quorum) {
      await once(served, record, 'standby', 'WARN', 'standby_commit', `Dispute ${record.disputeId} has ${ours} of our commits at the standby time; the standby key signs too.`);
    }

    const score = await sealedScore(served, record, sealed) ?? ruling.score;
    if (score !== ruling.score) {
      await once(served, record, 'diverged', 'WARN', 'ruling_diverged', `Dispute ${record.disputeId} was already sealed at ${score} and the ruling now reads ${ruling.score}. Every key votes ${score}, so no key lands away from the others.`);
    }

    let placed = ours;
    for (const index of wanted) {
      if (placed >= quorum || dispute.commitCount + (placed - ours) >= maxVoters) break;
      const key = keys[index];
      if (key === undefined) continue;
      if (await commitOne(served, record, key, score)) placed += 1;
    }

    if (head.timestamp >= tl.commitCritical) {
      const now = await chain.dispute(served.registry, record.disputeId);
      if (now.commitCount < quorum) {
        await once(
          served,
          record,
          'commit-critical',
          'CRITICAL',
          'quorum_at_risk',
          `Dispute ${record.disputeId} has ${now.commitCount} of ${quorum} commits with the commit window closing. Below quorum, anyone can refund the payer with failDispute.`,
          { commitEndsAt: new Date(Number(record.commitEndsAt) * 1_000).toISOString() },
        );
      }
    }
  }

  /**
   * The score a key of ours already sealed on this dispute, if any did.
   *
   * C-d: every key votes the same score, or the registry slashes the ones far from the median. A
   * process that lost its journal between two commits re-rules from whatever evidence it still
   * has, and that ruling can differ from the one the first key sealed. The chain is the record of
   * what was sealed, so the next key follows it.
   */
  async function sealedScore(served: Served, record: DisputeRecord, sealed: readonly Hex[]): Promise<number | null> {
    for (const [index, commitment] of sealed.entries()) {
      const key = keys[index];
      if (key === undefined || isZero(commitment)) continue;
      const salt = await saltFor(key.account, chainId, served.registry, record.disputeId);
      const score = recoverScore({ commitment, disputeId: record.disputeId, resolver: key.address, salt });
      if (score !== null) return score;
    }
    return null;
  }

  async function commitOne(served: Served, record: DisputeRecord, key: ResolverKey, score: number): Promise<boolean> {
    const label = `commit:${served.registry}:${record.disputeId}:${key.address}`;
    const salt = await saltFor(key.account, chainId, served.registry, record.disputeId);
    const commitment = commitmentFor({ disputeId: record.disputeId, resolver: key.address, score, salt });

    // The registry's own hash, compared before anything is signed. A commitment computed one way
    // here and checked another way there can never be revealed, and the silence is slashed.
    const onChain = await chain.commitmentHash(served.registry, record.disputeId, key.address, score, salt);
    if (onChain.toLowerCase() !== commitment.toLowerCase()) {
      await once(served, record, `hash-mismatch:${key.name}`, 'CRITICAL', 'commitment_mismatch', 'The registry hashes commitments differently from this service. Nothing was sent.', {
        key: key.name,
      });
      return false;
    }

    const tx = await write(label, () => chain.commit(key, served.registry, record.disputeId, commitment, pricing(label)));
    if (tx === null) return false;

    await patch(served, record.disputeId, (r) => ({
      ...r,
      stage: advance(r.stage, 'committed'),
      votes: upsertVote(r.votes, { key: key.name, address: key.address, score, commitTx: tx.hash, revealTx: null }),
    }));
    logger.info('committed', { disputeId: record.disputeId, key: key.name, hash: tx.hash, score });
    return true;
  }

  /** One write, with its failure counted and logged. Null means it did not land this time. */
  async function write(label: string, send: () => Promise<TxOutcome>): Promise<TxOutcome | null> {
    try {
      const tx = await send();
      if (tx.status === 'success') {
        attempts.delete(label);
        return tx;
      }
      attempts.set(label, (attempts.get(label) ?? 0) + 1);
      logger.warn('write_reverted', { label, hash: tx.hash });
      return null;
    } catch (error) {
      attempts.set(label, (attempts.get(label) ?? 0) + 1);
      logger.warn('write_failed', {
        label,
        kind: error instanceof WriteFailed ? error.kind : 'error',
        ...(error instanceof WriteFailed && error.hash !== null ? { hash: error.hash } : {}),
        reason: describeError(error),
      });
      return null;
    }
  }

  async function reveal(served: Served, record: DisputeRecord, tl: Timeline, head: Head): Promise<void> {
    if (head.timestamp < record.commitEndsAt || head.timestamp >= record.revealEndsAt) return;

    let unrevealed = 0;
    let sealedByUs = 0;
    for (const key of keys) {
      const commitment = await chain.committedBy(served.registry, record.disputeId, key.address);
      if (isZero(commitment)) continue;
      sealedByUs += 1;
      if ((await chain.revealedBy(served.registry, record.disputeId, key.address)).revealed) continue;

      const salt = await saltFor(key.account, chainId, served.registry, record.disputeId);
      const current = (await journal.get(served.registry, record.disputeId)) ?? record;
      const remembered = current.votes.find((vote) => vote.address.toLowerCase() === key.address.toLowerCase());
      const score =
        remembered !== undefined &&
        commitmentFor({ disputeId: record.disputeId, resolver: key.address, score: remembered.score, salt }).toLowerCase() ===
          commitment.toLowerCase()
          ? remembered.score
          : recoverScore({ commitment, disputeId: record.disputeId, resolver: key.address, salt });

      if (score === null) {
        await once(served, record, `unopenable:${key.name}`, 'CRITICAL', 'commitment_unopenable', `${key.name}'s commitment on dispute ${record.disputeId} does not open with its derived salt at any score.`, {
          key: key.name,
        });
        unrevealed += 1;
        continue;
      }

      const label = `reveal:${served.registry}:${record.disputeId}:${key.address}`;
      const tx = await write(label, () =>
        chain.reveal(key, served.registry, record.disputeId, score, salt, head.timestamp >= tl.lastChance ? LAST_CHANCE : pricing(label)),
      );
      if (tx === null) {
        unrevealed += 1;
        continue;
      }

      await patch(served, record.disputeId, (r) => ({
        ...r,
        votes: upsertVote(r.votes, {
          key: key.name,
          address: key.address,
          score,
          commitTx: r.votes.find((vote) => vote.key === key.name)?.commitTx ?? null,
          revealTx: tx.hash,
        }),
      }));
      logger.info('revealed', { disputeId: record.disputeId, key: key.name, hash: tx.hash, score });
    }

    if (unrevealed === 0) {
      // Every seal this service made is open on chain, so publishing the reasons gives nobody a
      // score to copy. With nothing sealed there was never anything to protect.
      await patch(served, record.disputeId, (r) => ({ ...r, published: true, stage: sealedByUs > 0 ? advance(r.stage, 'revealed') : r.stage }));
      return;
    }

    if (head.timestamp >= tl.revealCritical) {
      await once(served, record, 'reveal-critical', 'CRITICAL', 'reveal_owed', `Dispute ${record.disputeId}: ${unrevealed} of our commitments are still sealed. Silence past the reveal window is slashed.`, {
        revealEndsAt: new Date(Number(record.revealEndsAt) * 1_000).toISOString(),
      });
    }
    if (head.timestamp >= tl.lastChance) {
      await once(served, record, 'last-chance', 'CRITICAL', 'backup_runner_needed', `Dispute ${record.disputeId}: last-chance reveal is failing. Run the backup runner: bursar-resolver-backup reveal-now ${record.disputeId}.`);
    }
  }

  async function finalize(served: Served, record: DisputeRecord, head: Head): Promise<DisputeState> {
    const dispute = await chain.dispute(served.registry, record.disputeId);
    if (dispute.status !== DisputeStatus.Committing && dispute.status !== DisputeStatus.Revealing) return dispute;
    if (head.timestamp < dispute.commitEndsAt) return dispute;

    const { quorum } = await terms(served.registry);
    const everyoneSpoke = dispute.revealCount === dispute.commitCount;
    const windowShut = head.timestamp >= dispute.revealEndsAt;

    if (dispute.revealCount < quorum) {
      if (windowShut) {
        await once(served, record, 'quorum-missed', 'CRITICAL', 'quorum_missed', `Dispute ${record.disputeId} closed its reveal window with ${dispute.revealCount} of ${quorum} reveals. failDispute is callable and refunds the payer.`);
      }
      return dispute;
    }
    // A third party that committed and stays silent holds the vote open until the window shuts.
    if (!everyoneSpoke && !windowShut) return dispute;

    const { primary, standby } = rotation(record.disputeId, keys.length, quorum);
    for (const index of [...primary, ...standby]) {
      const key = keys[index];
      if (key === undefined) continue;
      const label = `finalize:${served.registry}:${record.disputeId}`;
      const tx = await write(label, () => chain.finalize(key, served.registry, record.disputeId, pricing(label)));
      if (tx === null) continue;

      await patch(served, record.disputeId, (r) => ({ ...r, finalizeTx: tx.hash }));
      logger.info('finalized', { disputeId: record.disputeId, key: key.name, hash: tx.hash });
      break;
    }

    return chain.dispute(served.registry, record.disputeId);
  }

  /** Reads back what the chain did with the dispute and says so, loudly where it went wrong. */
  async function settle(served: Served, record: DisputeRecord, dispute: DisputeState): Promise<void> {
    const lock = await chain.lock(served.escrow, record.escrowId);
    const outcome = {
      status: dispute.status === DisputeStatus.Finalized ? ('finalized' as const) : ('failed' as const),
      medianScore: dispute.medianScore,
      refundBps: dispute.refundBps,
      lockStatus: lock.status,
    };

    if (dispute.status === DisputeStatus.Finalized && lock.status === LockStatus.Resolved) {
      await patch(served, record.disputeId, (r) => ({ ...r, outcome, published: true, stage: advance(advance(r.stage, 'finalized'), 'verified') }));
      await once(served, record, 'verified', 'INFO', 'dispute_ruled', `Dispute ${record.disputeId} is finalized at a median of ${dispute.medianScore}, refunding ${dispute.refundBps / 100}% to the payer.`, {
        escrowId: record.escrowId,
      });
      return;
    }

    await patch(served, record.disputeId, (r) => ({ ...r, outcome, published: true, stage: advance(r.stage, 'closed') }));

    if (lock.status === LockStatus.Disputed) {
      // H1: the vote closed but the escrow never ruled, so the money is still frozen and the only
      // exit left is the escrow's own timeout.
      const timeoutAt = lock.disputedAt + (await chain.disputeTimeoutPeriod(served.escrow));
      await once(served, record, 'failed-frozen', 'CRITICAL', 'dispute_failed_lock_frozen', `Dispute ${record.disputeId} closed as Failed with lock ${record.escrowId} still Disputed. disputeTimeout opens at ${new Date(Number(timeoutAt) * 1_000).toISOString()}; follow the payee-compensation playbook.`);
      return;
    }

    await once(served, record, 'failed', 'CRITICAL', 'dispute_failed', `Dispute ${record.disputeId} closed without a ruling and the lock was refunded in full. This is the outcome the service exists to prevent.`, {
      medianScore: dispute.medianScore,
      refundBps: dispute.refundBps,
    });
  }

  return {
    open: (served, disputeId) => open(served, disputeId),

    step: async (served, disputeId, head) => {
      const dispute = await chain.dispute(served.registry, disputeId);
      if (dispute.status === DisputeStatus.None) return 'done';

      const closed = dispute.status === DisputeStatus.Finalized || dispute.status === DisputeStatus.Failed;
      // A dispute that closed before this service ever saw it open is history, not an incident.
      // Paging for it would page for dispute 1 on every fresh start.
      if (closed && (await journal.get(served.registry, disputeId)) === undefined) return 'done';

      let record = await open(served, disputeId, dispute);
      if (closed) {
        await settle(served, record, dispute);
        return 'done';
      }

      const lock = await chain.lock(served.escrow, dispute.escrowId);
      if (lock.status === LockStatus.Disputed && head.timestamp >= lock.disputedAt + WATCHDOG_SECONDS) {
        await once(served, record, 'watchdog', 'CRITICAL', 'dispute_watchdog', `Lock ${dispute.escrowId} has been disputed for 40 hours. disputeTimeout opens at 48 and would refund it without a ruling.`);
      }

      const tl = timeline(dispute);
      if (head.timestamp < dispute.commitEndsAt) {
        record = await snapshot(served, record, head);
        record = await decide(served, record, tl, head);
        await commit(served, record, dispute, tl, head);
        return 'open';
      }

      await reveal(served, record, tl, head);
      const after = await finalize(served, record, head);
      if (after.status === DisputeStatus.Finalized || after.status === DisputeStatus.Failed) {
        await settle(served, record, after);
        return 'done';
      }
      return 'open';
    },
  };
}

function upsertVote(votes: readonly StoredVote[], vote: StoredVote): StoredVote[] {
  return [...votes.filter((existing) => existing.key !== vote.key), vote];
}
