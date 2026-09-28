/**
 * A contested payment, from the side that paid for it: open one, follow it, read the ruling.
 *
 * Two different things are called a dispute, and the difference is where the money is. While the
 * escrow still holds it, contesting hands the split to bonded resolvers, costs a bond, and ends in
 * a refund share the escrow pays out. Once the provider has been paid, there is nothing left to
 * split: the complaint is recorded against the provider's history and no resolver ever votes on
 * it. Both are reported here, and neither is described as the other.
 */

import { getContract } from 'viem';
import type { Address, Chain, PublicClient, Transport } from 'viem';
import { escrowAbi, micro, oracleRegistryAbi } from '@bursar/core';
import type { Micro } from '@bursar/core';

import { connectFor, type Connection, type ConnectOptions } from './connection.js';
import { toDate } from './format.js';
import { checkEscrowId } from './guards.js';
import { LockStatus, toLockStatus, type Lock } from './types.js';

const BPS = 10_000n;

/** The line the escrow draws between a ruling that went the disputer's way and one that did not. */
const HALF_BPS = 5_000;

/** Mirrors `IOracleRegistry.DisputeStatus`. */
export const DisputePhase = {
  None: 0,
  Committing: 1,
  Revealing: 2,
  Finalized: 3,
  Failed: 4,
} as const;

export type DisputePhase = (typeof DisputePhase)[keyof typeof DisputePhase];

const PHASE_NAMES = ['none', 'committing', 'revealing', 'finalized', 'failed'] as const;

export type DisputePhaseName = (typeof PHASE_NAMES)[number];

/** The voting parameters in force, read off the registry rather than assumed. */
export type DisputeTerms = {
  /** Seconds resolvers have to commit a sealed score, counted from the moment the dispute opens. */
  readonly commitWindow: bigint;
  /** Seconds to publish that score once the commit window shuts. A commitment unrevealed is slashed. */
  readonly revealWindow: bigint;
  readonly unbondingPeriod: bigint;
  /** Revealed scores needed before the vote is a result rather than noise. */
  readonly quorum: number;
  readonly maxVoters: number;
  /** Score points a revealed score may sit from the median before it counts as an outlier. */
  readonly maxDeviation: number;
  /** Basis points of a resolver's bond a slash takes. */
  readonly slashBps: number;
};

/** How a ruling cut the lock. Every figure is derived the way the escrow derives it. */
export type DisputeRuling = {
  /** The median of the revealed scores, 0 to 100. */
  readonly medianScore: number;
  /** The payer's share of the lock, in basis points, after the resolver fee comes off the top. */
  readonly refundBps: number;
  readonly refundedToPayer: Micro;
  readonly paidToProvider: Micro;
  /** Split between the resolvers whose scores held. Charged to both sides of the dispute. */
  readonly resolverFee: Micro;
  readonly protocolFee: Micro;
  /** True when the ruling landed on the side that opened the dispute, which returns the bond. */
  readonly bondReturned: boolean;
};

export type DisputeRecord = {
  readonly settlementId: bigint;
  /** The registry's own id for the vote. Zero when no resolver was ever asked. */
  readonly disputeId: bigint;
  readonly phase: DisputePhaseName;
  readonly openedAt: Date;
  readonly openedBy: Address;
  /** What opening it cost the disputer. Zero for a complaint about a payment already made. */
  readonly bond: Micro;
  readonly amount: Micro;
  readonly payer: Address;
  readonly provider: Address;
  /** True when the provider had already been paid, so there is a record and no ruling. */
  readonly recordOnly: boolean;
  /** When resolvers stop being able to commit. Null for a record-only complaint. */
  readonly commitEndsAt: Date | null;
  readonly revealEndsAt: Date | null;
  readonly commitCount: number;
  readonly revealCount: number;
  /**
   * When the held funds and the bond come back to the payer if no ruling has landed. The escrow
   * enforces it, so a resolver quorum that goes quiet cannot hold a payment indefinitely.
   */
  readonly resolveBy: Date | null;
  readonly ruling: DisputeRuling | null;
  /** The lock as it stands now, which is what says where the money actually is. */
  readonly settlementStatus: LockStatus;
  readonly next: string;
};

function phaseName(status: number): DisputePhaseName {
  return PHASE_NAMES[status] ?? 'none';
}

function bps(amount: bigint, rate: bigint): bigint {
  return (amount * rate) / BPS;
}

/**
 * The four legs a ruling cuts a lock into, derived exactly as `Escrow._split` derives them: the
 * resolver fee comes off the top, the refund splits what is left, and the protocol fee is charged
 * only on the provider's share. Both divisions truncate toward the provider, so the legs add back
 * up to the locked amount with nothing over.
 */
function splitOf(
  amount: bigint,
  refundBps: number,
  terms: { resolverFeeBps: number; feeBps: number },
): { refunded: bigint; paid: bigint; protocolFee: bigint; resolverFee: bigint } {
  const resolverFee = bps(amount, BigInt(terms.resolverFeeBps));
  const divisible = amount - resolverFee;
  const refunded = bps(divisible, BigInt(refundBps));
  const awarded = divisible - refunded;
  const protocolFee = bps(awarded, BigInt(terms.feeBps));

  return { refunded, paid: awarded - protocolFee, protocolFee, resolverFee };
}

type EscrowFees = {
  readonly feeBps: number;
  readonly resolverFeeBps: number;
  readonly disputeBondBps: number;
  readonly disputeTimeoutPeriod: bigint;
};

/**
 * Reads a contested payment and the vote on it.
 *
 * The registry is read off the escrow rather than out of the address book, because the escrow's
 * own pairing is the one that decides who rules on its locks.
 */
export class DisputeClient {
  readonly connection: Connection;
  readonly escrow: Address;
  /** The dispute layer this escrow rules through. Zero when the deployment has none. */
  readonly registry: Address;
  readonly terms: DisputeTerms | null;
  readonly fees: EscrowFees;

  constructor(init: {
    connection: Connection;
    escrow: Address;
    registry: Address;
    terms: DisputeTerms | null;
    fees: EscrowFees;
  }) {
    this.connection = init.connection;
    this.escrow = init.escrow;
    this.registry = init.registry;
    this.terms = init.terms;
    this.fees = init.fees;
  }

  /** True when this escrow has a dispute layer at all. Without one a job is answered by its deadline. */
  get hasResolver(): boolean {
    return !/^0x0+$/u.test(this.registry);
  }

  /**
   * The dispute against one settlement, or null when nobody has contested it.
   *
   * A settlement id the escrow never issued is not a dispute either, and answers null rather than
   * a zeroed record.
   */
  async of(settlementId: bigint): Promise<DisputeRecord | null> {
    const id = checkEscrowId('settlementId', settlementId);
    const lock = await this.#lock(id);

    if (lock.status === LockStatus.None || lock.disputedAt === 0n) return null;

    return this.#record(id, lock);
  }

  /** The same record, reached by the registry's own dispute id. */
  async get(disputeId: bigint): Promise<DisputeRecord | null> {
    if (!this.hasResolver) return null;

    const dispute = await getContract({
      address: this.registry,
      abi: oracleRegistryAbi,
      client: this.connection.publicClient,
    }).read.getDispute([checkEscrowId('disputeId', disputeId)]);

    if (dispute.status === DisputePhase.None) return null;

    const lock = await this.#lock(dispute.escrowId);

    return this.#record(dispute.escrowId, lock);
  }

  async #lock(id: bigint): Promise<Lock> {
    const lock = await getContract({
      address: this.escrow,
      abi: escrowAbi,
      client: this.connection.publicClient,
    }).read.getLock([id]);

    return { ...lock, amount: micro(lock.amount), bond: micro(lock.bond), status: toLockStatus(lock.status) };
  }

  async #record(settlementId: bigint, lock: Lock): Promise<DisputeRecord> {
    // A complaint raised after the payee was paid never reaches a resolver: the escrow records it
    // against the payee's history and closes the lock in the same call.
    const recordOnly = lock.releasedAt !== 0n;
    const registry = getContract({
      address: this.registry,
      abi: oracleRegistryAbi,
      client: this.connection.publicClient,
    });

    const disputeId =
      recordOnly || !this.hasResolver ? 0n : await registry.read.disputeIdOf([settlementId]);
    const vote = disputeId === 0n ? null : await registry.read.getDispute([disputeId]);
    const phase = vote === null ? 'none' : phaseName(vote.status);

    // The lock zeroes its bond the moment a ruling pays it back or forfeits it, so the figure that
    // was actually posted is recomputed rather than read off a settled lock.
    const bond = recordOnly ? 0n : bps(lock.amount, BigInt(this.fees.disputeBondBps));

    const ruling =
      vote !== null && vote.status === DisputePhase.Finalized
        ? this.#ruling(lock, vote.medianScore, vote.refundBps)
        : null;

    return {
      settlementId,
      disputeId,
      phase,
      openedAt: toDate(lock.disputedAt),
      openedBy: lock.disputer,
      bond: micro(bond),
      amount: lock.amount,
      payer: lock.payer,
      provider: lock.payee,
      recordOnly,
      commitEndsAt: vote === null ? null : toDate(vote.commitEndsAt),
      revealEndsAt: vote === null ? null : toDate(vote.revealEndsAt),
      commitCount: vote?.commitCount ?? 0,
      revealCount: vote?.revealCount ?? 0,
      resolveBy: recordOnly ? null : toDate(lock.disputedAt + this.fees.disputeTimeoutPeriod),
      ruling,
      settlementStatus: lock.status,
      next: nextFor({ phase, recordOnly, ruling, status: lock.status, hasResolver: this.hasResolver }),
    };
  }

  #ruling(lock: Lock, medianScore: number, refundBps: number): DisputeRuling {
    const split = splitOf(lock.amount, refundBps, this.fees);
    const vindicated =
      lock.disputer.toLowerCase() === lock.payer.toLowerCase()
        ? refundBps >= HALF_BPS
        : refundBps <= HALF_BPS;

    return {
      medianScore,
      refundBps,
      refundedToPayer: micro(split.refunded),
      paidToProvider: micro(split.paid),
      resolverFee: micro(split.resolverFee),
      protocolFee: micro(split.protocolFee),
      bondReturned: vindicated,
    };
  }
}

function nextFor(state: {
  phase: DisputePhaseName;
  recordOnly: boolean;
  ruling: DisputeRuling | null;
  status: LockStatus;
  hasResolver: boolean;
}): string {
  if (state.recordOnly) {
    return (
      'The provider had already been paid, so there is nothing left to split and no resolver rules ' +
      'on this. The complaint counts against the provider’s settlement history, which lowers the ' +
      'ceiling on the next job it can be paid for. Nothing further to decide.'
    );
  }

  if (state.ruling) {
    return (
      `The resolvers scored the delivery ${state.ruling.medianScore} out of 100 and the escrow has ` +
      'moved the money on that ruling. Nothing further to decide.'
    );
  }

  switch (state.phase) {
    case 'committing':
      return 'Resolvers are sealing their scores. Nothing to decide until the vote closes.';
    case 'revealing':
      return 'Resolvers are publishing the scores they sealed. Read this again for the ruling.';
    case 'failed':
      return state.status === LockStatus.Resolved
        ? 'The vote produced no usable result, so the escrow refunded the payer in full and the ' +
            'provider was paid nothing. Nothing further to decide.'
        : 'The vote produced no usable result. The escrow refunds the payer in full when the dispute ' +
            'is closed, and anyone can close it.';
    default:
      return state.hasResolver
        ? 'The escrow is holding the funds and no vote is open on them. They return to the payer, ' +
            'with the bond, once the dispute deadline passes.'
        : 'This escrow has no dispute layer, so nobody can rule on this. The funds return to the ' +
            'payer once the dispute deadline passes.';
  }
}

/** Opens a reader for the dispute layer this escrow rules through. */
export async function disputes(options: Connection | ConnectOptions = {}): Promise<DisputeClient> {
  const connection = connectFor(options, 'disputes()');
  const escrowAddress = connection.addresses.escrow;
  const read = getContract({
    address: escrowAddress,
    abi: escrowAbi,
    client: connection.publicClient,
  }).read;

  const [registry, feeBps, resolverFeeBps, disputeBondBps, disputeTimeoutPeriod] = await Promise.all([
    read.resolver(),
    read.feeBps(),
    read.resolverFeeBps(),
    read.disputeBondBps(),
    read.disputeTimeoutPeriod(),
  ]);

  return new DisputeClient({
    connection,
    escrow: escrowAddress,
    registry,
    terms: await readTerms(connection.publicClient, registry),
    fees: { feeBps, resolverFeeBps, disputeBondBps, disputeTimeoutPeriod },
  });
}

/** The voting parameters, or null for an escrow with no dispute layer wired to it. */
export async function readTerms(
  client: PublicClient<Transport, Chain>,
  registry: Address,
): Promise<DisputeTerms | null> {
  if (/^0x0+$/u.test(registry)) return null;

  const config = await getContract({ address: registry, abi: oracleRegistryAbi, client }).read.config();

  return {
    commitWindow: config.commitWindow,
    revealWindow: config.revealWindow,
    unbondingPeriod: config.unbondingPeriod,
    quorum: config.quorum,
    maxVoters: config.maxVoters,
    maxDeviation: config.maxDeviation,
    slashBps: config.slashBps,
  };
}

