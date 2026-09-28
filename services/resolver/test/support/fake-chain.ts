import { commitmentFor } from '@bursar/sdk';
import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';

import { DisputeStatus, LockStatus, ResolverStatus, WriteFailed } from '../../src/chain.js';
import type { ChainPort, DisputeState, LockState, Pricing, TxOutcome } from '../../src/chain.js';
import type { Served } from '../../src/config.js';
import type { Fetched, Fetcher } from '../../src/evidence.js';
import type { ResolverKey } from '../../src/keys.js';

export const REGISTRY: Address = getAddress('0xcb7c60037ec43b9692a5ddca42a500181cf549ff');
export const ESCROW: Address = getAddress('0x7d82ad9dc36734adcf5cf985295096b2b575c8c4');
export const SERVED: Served = { name: 'test', escrow: ESCROW, registry: REGISTRY, contractSet: 'v1' };
export const SERVED_V2: Served = { ...SERVED, name: 'test-v2', contractSet: 'v2' };

export const HOUR = 3_600n;
export const T0 = 1_790_000_000n;

type Vote = { commitment: Hex; revealed: boolean; score: number };

type FakeDispute = DisputeState & { votes: Map<string, Vote>; voters: string[] };

export type WriteCall = { readonly action: 'commit' | 'reveal' | 'finalize'; readonly key: string; readonly disputeId: bigint; readonly pricing: Pricing };

/**
 * The registry and escrow rules the service depends on, in memory: windows, one commit per key,
 * reveals checked against the commitment hash, finalize guarded the way the contract guards it,
 * and the median that decides the refund. Writes can be told to fail, and every attempt is kept.
 */
export class FakeChain implements ChainPort {
  time = T0;
  block = 1_000n;
  readonly quorum = 2;
  readonly disputes = new Map<bigint, FakeDispute>();
  readonly locks = new Map<bigint, LockState>();
  readonly logs: { disputeId: bigint; escrowId: bigint; blockNumber: bigint }[] = [];
  readonly standing = new Map<string, { status: number; bond: bigint; bondable: boolean }>();
  readonly writes: WriteCall[] = [];
  /** Keys whose next writes fail before anything is signed, per action. */
  readonly refuse = new Map<string, number>();

  advance(seconds: bigint): void {
    this.time += seconds;
    this.block += seconds * 4n;
  }

  at(seconds: bigint): void {
    this.block += (seconds > this.time ? seconds - this.time : 0n) * 4n;
    this.time = seconds;
  }

  openDispute(lock: Partial<LockState> & Pick<LockState, 'payer' | 'payee'>): { disputeId: bigint; escrowId: bigint } {
    const escrowId = BigInt(this.locks.size + 1);
    const disputeId = BigInt(this.disputes.size + 1);
    this.locks.set(escrowId, {
      disputer: lock.payer,
      capabilityId: `0x${'cc'.repeat(32)}`,
      inputCommit: `0x${'00'.repeat(32)}`,
      outputCommit: `0x${'00'.repeat(32)}`,
      inputURI: '',
      outputURI: '',
      amount: 1_000_000n,
      deadline: this.time + 24n * HOUR,
      releasedAt: 0n,
      bond: 50_000n,
      disputedAt: this.time,
      status: LockStatus.Disputed,
      ...lock,
    });
    this.disputes.set(disputeId, {
      escrowId,
      openedAt: this.time,
      commitEndsAt: this.time + 6n * HOUR,
      revealEndsAt: this.time + 12n * HOUR,
      commitCount: 0,
      revealCount: 0,
      medianScore: 0,
      refundBps: 0,
      status: DisputeStatus.Committing,
      votes: new Map(),
      voters: [],
    });
    this.logs.push({ disputeId, escrowId, blockNumber: this.block });
    return { disputeId, escrowId };
  }

  bond(address: Address, bondable = true): void {
    this.standing.set(address.toLowerCase(), { status: ResolverStatus.Active, bond: 25_000n * 10n ** 18n, bondable });
  }

  /** A resolver outside this service seals a score and, unless told otherwise, never opens it. */
  thirdPartyCommit(disputeId: bigint, address: Address): void {
    const dispute = this.need(disputeId);
    dispute.votes.set(address.toLowerCase(), { commitment: `0x${'ab'.repeat(32)}`, revealed: false, score: 0 });
    dispute.voters.push(address.toLowerCase());
    this.disputes.set(disputeId, { ...dispute, commitCount: dispute.commitCount + 1 });
  }

  private need(disputeId: bigint): FakeDispute {
    const found = this.disputes.get(disputeId);
    if (found === undefined) throw new Error(`no dispute ${disputeId}`);
    return found;
  }

  private tx(): TxOutcome {
    this.block += 1n;
    return { hash: `0x${this.block.toString(16).padStart(64, '0')}`, status: 'success', blockNumber: this.block, gasUsed: 80_000n };
  }

  private gate(action: string, key: ResolverKey): void {
    const label = `${action}:${key.name}`;
    const left = this.refuse.get(label) ?? 0;
    if (left > 0) {
      this.refuse.set(label, left - 1);
      throw new WriteFailed(action, 'refused', null, new Error('injected failure'));
    }
  }

  private revert(action: string, reason: string): never {
    throw new WriteFailed(action, 'refused', null, new Error(`execution reverted: ${reason}`));
  }

  head = async () => ({ number: this.block, timestamp: this.time });
  terms = async () => ({ commitWindow: 6n * HOUR, revealWindow: 6n * HOUR, quorum: this.quorum, maxVoters: 5, maxDeviation: 20 });
  escrowResolver = async () => REGISTRY;
  nextDisputeId = async () => BigInt(this.disputes.size + 1);
  disputeIdOf = async (_registry: Address, escrowId: bigint) =>
    [...this.disputes.entries()].find(([, dispute]) => dispute.escrowId === escrowId)?.[0] ?? 0n;
  disputeTimeoutPeriod = async () => 48n * HOUR;
  disputeOpenedLogs = async (_registry: Address, fromBlock: bigint, toBlock: bigint) =>
    this.logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);

  dispute = async (_registry: Address, disputeId: bigint): Promise<DisputeState> => {
    const found = this.disputes.get(disputeId);
    if (found === undefined) {
      return { escrowId: 0n, openedAt: 0n, commitEndsAt: 0n, revealEndsAt: 0n, commitCount: 0, revealCount: 0, medianScore: 0, refundBps: 0, status: 0 };
    }
    const { votes: _votes, voters: _voters, ...state } = found;
    return state;
  };

  lock = async (_escrow: Address, escrowId: bigint) => {
    const found = this.locks.get(escrowId);
    if (found === undefined) throw new Error(`no lock ${escrowId}`);
    return found;
  };

  committedBy = async (_registry: Address, disputeId: bigint, resolver: Address): Promise<Hex> =>
    this.disputes.get(disputeId)?.votes.get(resolver.toLowerCase())?.commitment ?? `0x${'00'.repeat(32)}`;

  revealedBy = async (_registry: Address, disputeId: bigint, resolver: Address) => {
    const vote = this.disputes.get(disputeId)?.votes.get(resolver.toLowerCase());
    return { revealed: vote?.revealed ?? false, score: vote?.revealed === true ? vote.score : 0 };
  };

  commitmentHash = async (_registry: Address, disputeId: bigint, resolver: Address, score: number, salt: Hex) =>
    commitmentFor({ disputeId, resolver, score, salt });

  resolver = async (_registry: Address, resolver: Address) => {
    const found = this.standing.get(resolver.toLowerCase());
    return { bond: found?.bond ?? 0n, status: found?.status ?? ResolverStatus.None, slashes: 0, finalized: 0 };
  };

  openVotes = async (_registry: Address, resolver: Address) =>
    [...this.disputes.values()].filter(
      (dispute) =>
        (dispute.status === DisputeStatus.Committing || dispute.status === DisputeStatus.Revealing) &&
        dispute.votes.has(resolver.toLowerCase()),
    ).length;

  bondable = async (_registry: Address, resolver: Address) => this.standing.get(resolver.toLowerCase())?.bondable ?? false;
  balance = async () => 10n ** 15n;
  mandate = async () => null;
  payee = async () => ({ active: true, released: 3n, timedOut: 0n, disputed: 0n });

  commit = async (key: ResolverKey, _registry: Address, disputeId: bigint, commitment: Hex, pricing: Pricing) => {
    this.writes.push({ action: 'commit', key: key.name, disputeId, pricing });
    this.gate('commit', key);
    const dispute = this.need(disputeId);
    if (dispute.status !== DisputeStatus.Committing) this.revert('commit', 'BadStatus');
    if (this.time >= dispute.commitEndsAt) this.revert('commit', 'CommitWindowClosed');
    if (dispute.votes.has(key.address.toLowerCase())) this.revert('commit', 'AlreadyCommitted');
    dispute.votes.set(key.address.toLowerCase(), { commitment, revealed: false, score: 0 });
    dispute.voters.push(key.address.toLowerCase());
    this.disputes.set(disputeId, { ...dispute, commitCount: dispute.commitCount + 1 });
    return this.tx();
  };

  reveal = async (key: ResolverKey, _registry: Address, disputeId: bigint, score: number, salt: Hex, pricing: Pricing) => {
    this.writes.push({ action: 'reveal', key: key.name, disputeId, pricing });
    this.gate('reveal', key);
    const dispute = this.need(disputeId);
    if (this.time < dispute.commitEndsAt) this.revert('reveal', 'CommitWindowOpen');
    if (this.time >= dispute.revealEndsAt) this.revert('reveal', 'RevealWindowClosed');
    const vote = dispute.votes.get(key.address.toLowerCase());
    if (vote === undefined) this.revert('reveal', 'NoCommitment');
    if (vote.revealed) this.revert('reveal', 'AlreadyRevealed');
    if (commitmentFor({ disputeId, resolver: key.address, score, salt }) !== vote.commitment) this.revert('reveal', 'BadReveal');
    dispute.votes.set(key.address.toLowerCase(), { ...vote, revealed: true, score });
    this.disputes.set(disputeId, { ...dispute, revealCount: dispute.revealCount + 1, status: DisputeStatus.Revealing });
    return this.tx();
  };

  finalize = async (key: ResolverKey, _registry: Address, disputeId: bigint, pricing: Pricing) => {
    this.writes.push({ action: 'finalize', key: key.name, disputeId, pricing });
    this.gate('finalize', key);
    const dispute = this.need(disputeId);
    if (dispute.status !== DisputeStatus.Committing && dispute.status !== DisputeStatus.Revealing) this.revert('finalize', 'BadStatus');
    if (this.time < dispute.commitEndsAt) this.revert('finalize', 'CommitWindowOpen');
    if (this.time < dispute.revealEndsAt && dispute.revealCount < dispute.commitCount) this.revert('finalize', 'RevealWindowOpen');
    if (dispute.revealCount < this.quorum) this.revert('finalize', 'QuorumNotMet');

    const scores = [...dispute.votes.values()].filter((vote) => vote.revealed).map((vote) => vote.score).sort((a, b) => a - b);
    const middle = scores.length % 2 === 1 ? (scores[(scores.length - 1) / 2] ?? 0) : Math.floor(((scores[scores.length / 2 - 1] ?? 0) + (scores[scores.length / 2] ?? 0)) / 2);
    const refundBps = middle < 50 ? 10_000 : middle < 65 ? 7_500 : middle < 80 ? 3_500 : 0;

    this.disputes.set(disputeId, { ...dispute, status: DisputeStatus.Finalized, medianScore: middle, refundBps });
    const lock = this.locks.get(dispute.escrowId);
    if (lock !== undefined) this.locks.set(dispute.escrowId, { ...lock, status: LockStatus.Resolved });
    return this.tx();
  };
}

/** A fetcher over a fixed table, so no test depends on a network. */
export function tableFetcher(table: Readonly<Record<string, Fetched>>): Fetcher {
  return async (uri) => {
    if (uri.startsWith('data:')) {
      const payload = uri.slice(uri.indexOf(',') + 1);
      return { kind: 'ok', text: Buffer.from(payload, 'base64').toString('utf8') };
    }
    return table[uri] ?? { kind: 'unfetchable', detail: 'not in the table' };
  };
}
