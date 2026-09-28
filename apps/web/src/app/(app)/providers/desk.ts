import { micro, mulBps } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { LockStatus } from '@bursar/sdk';
import type { Address, Hex } from 'viem';

import {
  ADDRESSES,
  ReadBatch,
  addBlockNumber,
  addChainTime,
  agentRegistryAbi,
  rhcClient,
  escrowAbi,
  oracleRegistryAbi,
  reputationAbi,
  runBatch,
  settlementAssetAbi,
  settlementComplianceAbi,
  splitSettlement,
} from '@/chain';

/**
 * The escrow indexes locks by id and by nothing else. Its `Locked` event carries an indexed payee,
 * but a log scan from the deployment block is thousands of `eth_getLogs` at the span public
 * endpoints accept, and a public endpoint meters arrivals per second. Walking ids backwards from `nextId`
 * through Multicall3 reads the same records in two requests whatever the count.
 *
 * The ceiling is what makes that bounded, and the surface says which ids it covered. It never
 * implies it read everything.
 */
const SCAN_LIMIT = 150n;

/** Locks per aggregated call. Each carries two strings, so the returndata is the limit, not the gas. */
const SCAN_CHUNK = 50;

export type LockStage =
  /** Money is held and the deadline has not passed. The work is owed. */
  | 'awaiting-delivery'
  /** Money is held and the deadline has passed. Anyone can return it to the payer. */
  | 'deadline-passed'
  /** Paid, and the payer can still contest it. */
  | 'paid-open-to-dispute'
  /** Paid, uncontested, and nobody has written it into the payee's record. */
  | 'paid-unrecorded'
  | 'paid-recorded'
  | 'contested'
  /** A panel took a median and split the lock by it. */
  | 'ruled'
  /**
   * The lock left the escrow's disputed state without a panel ever producing a median: the quorum
   * was missed, or nobody closed the dispute and the escrow's own timeout returned the money.
   * Calling that a ruling is the lie the payee's desk was telling about lock 5.
   */
  | 'dispute-closed'
  /** Settled out of a dispute, and how it closed did not come back. */
  | 'dispute-unread'
  | 'returned-to-payer'
  | 'declined';

export type DisputeRead = {
  readonly id: bigint;
  readonly status: number;
  readonly openedAt: Date | null;
  readonly commitEndsAt: Date | null;
  readonly revealEndsAt: Date | null;
  readonly commitCount: number;
  readonly revealCount: number;
  readonly medianScore: number;
  readonly refundBps: number;
  /** Resolvers the fee was split between. Zero on every dispute that closed without a ruling. */
  readonly rewardShares: number;
};

/**
 * What the escrow has moved to the payee for one lock.
 *
 * The desk used to print the lock's amount less the settlement fee in a column headed with what
 * the payee received, on every row whatever became of it, so five locks that were returned to the
 * payer and one that was refunded all claimed a payout. These are five different answers and the
 * column has to be able to tell them apart.
 */
export type LockPayout =
  /** Nothing moved yet. This is what a release would pay today. */
  | { readonly kind: 'expected'; readonly amount: Micro; readonly fee: Micro }
  /** Frozen by a dispute. What the payee keeps is the ruling's to decide. */
  | { readonly kind: 'at-stake'; readonly amount: Micro; readonly fee: Micro }
  /** The escrow moved this to the payee. */
  | { readonly kind: 'paid'; readonly amount: Micro; readonly fee: Micro }
  /** The lock reached its end and the payee received nothing from it. */
  | { readonly kind: 'none' }
  /** What moved could not be worked out from this reading. Not the same as nothing. */
  | { readonly kind: 'unread' };

export type ProviderLock = {
  readonly id: bigint;
  readonly payer: Address;
  readonly disputer: Address;
  readonly capabilityId: Hex;
  readonly inputURI: string;
  readonly outputURI: string;
  /** What the payer locked. */
  readonly amount: Micro;
  /** Charged on the payee's side of a settlement. */
  readonly fee: Micro;
  /** What a release moves to the payee. */
  readonly net: Micro;
  /** What reached the payee, or why nothing did. */
  readonly payout: LockPayout;
  readonly deadline: Date;
  readonly releasedAt: Date | null;
  readonly disputedAt: Date | null;
  readonly bond: Micro;
  readonly status: LockStatus;
  readonly counted: boolean;
  /** The moment `finalizeRelease` starts to work. Null unless this lock is a release waiting on it. */
  readonly recordableAt: Date | null;
  readonly stage: LockStage;
  readonly dispute: DisputeRead | undefined;
};

export type EscrowTerms = {
  readonly feeBps: number | undefined;
  readonly disputeWindow: bigint | undefined;
  readonly disputeTimeoutPeriod: bigint | undefined;
  readonly minTtl: bigint | undefined;
  readonly maxTtl: bigint | undefined;
  readonly disputeBondBps: number | undefined;
  /** Taken off a contested lock before the refund is worked out, ahead of the settlement fee. */
  readonly resolverFeeBps: number | undefined;
};

export type ProviderRecord = {
  readonly released: bigint | undefined;
  readonly timedOut: bigint | undefined;
  readonly disputed: bigint | undefined;
  /** Delivered jobs as a share of settled jobs, 0 to 100. */
  readonly score: number | undefined;
  /** The largest single job a payer may lock against this address. */
  readonly cap: Micro | undefined;
  readonly baseCap: Micro | undefined;
  readonly capPerScore: Micro | undefined;
  readonly maxCap: Micro | undefined;
};

/**
 * A stake on its way out.
 *
 * The registry holds one request per address and matures it on a delay, so the three steps a payee
 * takes are separate readings, not one boolean: the amount asked for, the moment it opens, and
 * whether that moment has passed. `maturesAt` is null when the registry answered the request and
 * not the delay, which is the one combination where the wait is real and its end is unknown.
 */
export type WithdrawalRequest = {
  readonly amount: Micro;
  readonly requestedAt: Date;
  readonly maturesAt: Date | null;
  readonly matured: boolean | undefined;
};

export type ProviderStanding = {
  readonly name: string | undefined;
  readonly registered: boolean | undefined;
  readonly active: boolean | undefined;
  readonly barred: boolean | undefined;
  readonly stake: Micro | undefined;
  readonly minStake: Micro | undefined;
  readonly registeredAt: Date | null;
  /** The most a single ruling can take from this stake right now. */
  readonly maxSlash: Micro | undefined;
  /** The share of a stake a single ruling may take, in basis points. */
  readonly slashBps: number | undefined;
  /** Seconds between asking to withdraw and being able to take it. */
  readonly withdrawalDelay: bigint | undefined;
  /** Undefined while unread, null when nothing is on its way out. */
  readonly withdrawal: WithdrawalRequest | null | undefined;
  /** The registry itself. Paused, it takes no registration, no top-up and no reactivation. */
  readonly registryPaused: boolean | undefined;
  /** USDG the registry may already move from this address. A stake is pulled from it. */
  readonly allowance: Micro | undefined;
};

export type ProviderDesk = {
  readonly payee: Address;
  readonly blockNumber: bigint | undefined;
  /** Chain time. Every deadline and window on this screen is decided by it, not by the browser. */
  readonly chainTime: Date;
  readonly readAt: Date;
  readonly requests: number;
  /**
   * False when the escrow did not answer how many locks exist. Every list below is then unknown,
   * and the difference matters: an empty desk and an unread one look identical on screen and mean
   * opposite things.
   */
  readonly complete: boolean;
  readonly failures: number;
  readonly terms: EscrowTerms;
  readonly record: ProviderRecord;
  readonly standing: ProviderStanding;
  /** USDG the payee address holds. Payouts land here. */
  readonly balance: Micro | undefined;
  /**
   * Net USDG the escrow has released to this address across the jobs read, which is the ids in
   * `scanned` and no further back. Undefined when the escrow did not answer, because a total over
   * a list that never arrived is zero and zero reads as an answer.
   */
  readonly paidOut: Micro | undefined;
  /** The token issuer's blocklist, read against the payee address. */
  readonly blocked: boolean | undefined;
  readonly tokenPaused: boolean | undefined;
  readonly locks: readonly ProviderLock[];
  readonly working: readonly ProviderLock[];
  readonly settled: readonly ProviderLock[];
  readonly contested: readonly ProviderLock[];
  /** Released and still outside the record, whether or not the call works yet. */
  readonly unrecorded: readonly ProviderLock[];
  /** The subset `finalizeRelease` accepts right now. */
  readonly recordable: readonly ProviderLock[];
  /** Where the cap lands if every recordable release is written in. */
  readonly projectedCap: Micro | undefined;
  readonly scanned: { readonly from: bigint; readonly to: bigint; readonly truncated: boolean };
};

type RawLock = {
  payer: Address;
  payee: Address;
  disputer: Address;
  capabilityId: Hex;
  inputCommit: Hex;
  outputCommit: Hex;
  inputURI: string;
  outputURI: string;
  amount: bigint;
  deadline: bigint;
  releasedAt: bigint;
  bond: bigint;
  disputedAt: bigint;
  status: number;
  counted: boolean;
};

type RawCurve = { baseCap: bigint; capPerScore: bigint; maxCap: bigint };
type RawAgent = { name: string; stake: bigint; registeredAt: bigint; active: boolean };
type RawDispute = {
  escrowId: bigint;
  openedAt: bigint;
  commitEndsAt: bigint;
  revealEndsAt: bigint;
  commitCount: number;
  revealCount: number;
  medianScore: number;
  refundBps: number;
  rewardShares: number;
  status: number;
};

/**
 * What joining the registry costs and what a score is worth, with no address involved.
 *
 * The provider surface answers this before a wallet is connected, so it is read on its own rather
 * than lifted off a desk. One aggregated request.
 */
export type RegistryTerms = {
  readonly minStake: Micro | undefined;
  readonly slashBps: number | undefined;
  readonly maxSlashBps: number | undefined;
  readonly withdrawalDelay: bigint | undefined;
  readonly baseCap: Micro | undefined;
  readonly capPerScore: Micro | undefined;
  readonly maxCap: Micro | undefined;
  readonly paused: boolean | undefined;
  readonly listed: bigint | undefined;
};

export async function readRegistryTerms(signal?: AbortSignal): Promise<RegistryTerms> {
  const client = rhcClient();
  const batch = new ReadBatch();
  const registryCall = (functionName: string) => ({
    address: ADDRESSES.agentRegistry,
    abi: agentRegistryAbi as never,
    functionName,
  });

  const slots = {
    minStake: batch.add<bigint>('registry.minStake', registryCall('minStake')),
    slashBps: batch.add<number>('registry.slashBps', registryCall('slashBps')),
    maxSlashBps: batch.add<number>('registry.MAX_SLASH_BPS', registryCall('MAX_SLASH_BPS')),
    delay: batch.add<bigint>('registry.WITHDRAWAL_DELAY', registryCall('WITHDRAWAL_DELAY')),
    paused: batch.add<boolean>('registry.paused', registryCall('paused')),
    listed: batch.add<bigint>('registry.totalAgents', registryCall('totalAgents')),
    curve: batch.add<RawCurve>('reputation.curve', {
      address: ADDRESSES.reputation,
      abi: reputationAbi as never,
      functionName: 'curve',
    }),
  };

  const results = await runBatch(client, batch, signal);
  const curve = results.get(slots.curve);

  return {
    minStake: asMicro(results.get(slots.minStake)),
    slashBps: results.get(slots.slashBps),
    maxSlashBps: results.get(slots.maxSlashBps),
    withdrawalDelay: results.get(slots.delay),
    baseCap: asMicro(curve?.baseCap),
    capPerScore: asMicro(curve?.capPerScore),
    maxCap: asMicro(curve?.maxCap),
    paused: results.get(slots.paused),
    listed: results.get(slots.listed),
  };
}

/**
 * Everything the party being paid needs, in two aggregated requests for the common case and a
 * third only when something is contested.
 */
export async function readProviderDesk(payee: Address, signal?: AbortSignal): Promise<ProviderDesk> {
  const client = rhcClient();

  const head = new ReadBatch();
  const escrowCall = (functionName: string, args?: readonly unknown[]) => ({
    address: ADDRESSES.escrow,
    abi: escrowAbi as never,
    functionName,
    ...(args === undefined ? {} : { args }),
  });
  const registryCall = (functionName: string, args?: readonly unknown[]) => ({
    address: ADDRESSES.agentRegistry,
    abi: agentRegistryAbi as never,
    functionName,
    ...(args === undefined ? {} : { args }),
  });
  const reputationCall = (functionName: string, args?: readonly unknown[]) => ({
    address: ADDRESSES.reputation,
    abi: reputationAbi as never,
    functionName,
    ...(args === undefined ? {} : { args }),
  });

  const slots = {
    blockNumber: addBlockNumber(head),
    chainTime: addChainTime(head),
    nextId: head.add<bigint>('escrow.nextId', escrowCall('nextId')),
    feeBps: head.add<number>('escrow.feeBps', escrowCall('feeBps')),
    disputeWindow: head.add<bigint>('escrow.disputeWindow', escrowCall('disputeWindow')),
    disputeTimeoutPeriod: head.add<bigint>('escrow.disputeTimeoutPeriod', escrowCall('disputeTimeoutPeriod')),
    minTtl: head.add<bigint>('escrow.minTtl', escrowCall('minTtl')),
    maxTtl: head.add<bigint>('escrow.maxTtl', escrowCall('maxTtl')),
    disputeBondBps: head.add<number>('escrow.disputeBondBps', escrowCall('disputeBondBps')),
    resolverFeeBps: head.add<number>('escrow.resolverFeeBps', escrowCall('resolverFeeBps')),
    agent: head.add<RawAgent>('registry.getAgent', registryCall('getAgent', [payee])),
    registered: head.add<boolean>('registry.isRegistered', registryCall('isRegistered', [payee])),
    active: head.add<boolean>('registry.isActive', registryCall('isActive', [payee])),
    barred: head.add<boolean>('registry.isBlacklisted', registryCall('isBlacklisted', [payee])),
    stake: head.add<bigint>('registry.stakeOf', registryCall('stakeOf', [payee])),
    minStake: head.add<bigint>('registry.minStake', registryCall('minStake')),
    maxSlash: head.add<bigint>('registry.maxSlash', registryCall('maxSlash', [payee])),
    slashBps: head.add<number>('registry.slashBps', registryCall('slashBps')),
    withdrawal: head.add<readonly [bigint, bigint]>('registry.withdrawals', registryCall('withdrawals', [payee])),
    withdrawalDelay: head.add<bigint>('registry.WITHDRAWAL_DELAY', registryCall('WITHDRAWAL_DELAY')),
    registryPaused: head.add<boolean>('registry.paused', registryCall('paused')),
    allowance: head.add<bigint>('usdg.allowance', {
      address: ADDRESSES.usdg,
      abi: settlementAssetAbi as never,
      functionName: 'allowance',
      args: [payee, ADDRESSES.agentRegistry],
    }),
    score: head.add<number>('reputation.score', reputationCall('score', [payee])),
    cap: head.add<bigint>('reputation.capOf', reputationCall('capOf', [payee])),
    stats: head.add<readonly [bigint, bigint, bigint]>('reputation.payeeStats', reputationCall('payeeStats', [payee])),
    curve: head.add<RawCurve>('reputation.curve', reputationCall('curve')),
    balance: head.add<bigint>('usdg.balanceOf', { address: ADDRESSES.usdg, abi: settlementAssetAbi as never, functionName: 'balanceOf', args: [payee] }),
    blocked: head.add<boolean>('usdg.isFrozen', { address: ADDRESSES.usdg, abi: settlementComplianceAbi as never, functionName: 'isFrozen', args: [payee] }),
    paused: head.add<boolean>('usdg.paused', { address: ADDRESSES.usdg, abi: settlementComplianceAbi as never, functionName: 'paused' }),
  };

  const headResults = await runBatch(client, head, signal);
  let requests = 1;

  const chainSeconds = headResults.get(slots.chainTime);
  const chainTime = chainSeconds === undefined ? new Date() : new Date(Number(chainSeconds) * 1000);
  const nextId = headResults.get(slots.nextId) ?? 1n;
  const feeBps = headResults.get(slots.feeBps);
  const resolverFeeBps = headResults.get(slots.resolverFeeBps);
  const disputeWindow = headResults.get(slots.disputeWindow);
  const curve = headResults.get(slots.curve);

  const highest = nextId > 0n ? nextId - 1n : 0n;
  const from = highest > SCAN_LIMIT ? highest - SCAN_LIMIT + 1n : 1n;
  const ids: bigint[] = [];
  for (let id = highest; id >= from && id >= 1n; id -= 1n) ids.push(id);

  const chunks: bigint[][] = [];
  for (let index = 0; index < ids.length; index += SCAN_CHUNK) chunks.push(ids.slice(index, index + SCAN_CHUNK));

  const scanned = await Promise.all(
    chunks.map(async (chunk) => {
      const batch = new ReadBatch();
      const lockSlots = chunk.map((id) => ({ id, slot: batch.add<RawLock>(`escrow.getLock:${id}`, escrowCall('getLock', [id])) }));
      const results = await runBatch(client, batch, signal);
      return lockSlots.map((entry) => ({ id: entry.id, raw: results.get(entry.slot) }));
    }),
  );
  requests += chunks.length;

  const mine = scanned
    .flat()
    .filter((entry): entry is { id: bigint; raw: RawLock } => entry.raw !== undefined)
    .filter((entry) => entry.raw.status !== LockStatus.None && entry.raw.payee.toLowerCase() === payee.toLowerCase());

  // A ruling is the moment a lock stops being disputed. Reading the dispute only for locks still
  // sitting in `Disputed` therefore dropped it in the same block its outcome became readable, and
  // the desk fell back to a stage label that claimed a ruling nobody had made. `Resolved` is the
  // status every closed dispute lands in, whether a panel ruled or the escrow timed it out.
  const disputeReads = await readDisputes(
    mine
      .filter((entry) => entry.raw.status === LockStatus.Disputed || entry.raw.status === LockStatus.Resolved)
      .map((entry) => entry.id),
    signal,
  );
  if (disputeReads.requests > 0) requests += disputeReads.requests;

  const locks = mine.map((entry) =>
    toLock(entry.id, entry.raw, { feeBps, resolverFeeBps, disputeWindow }, chainTime, disputeReads.byLock.get(entry.id)),
  );

  const working = locks.filter((lock) => lock.status === LockStatus.Locked);
  const contested = locks.filter((lock) => lock.status === LockStatus.Disputed);
  const settled = locks.filter(
    (lock) => lock.status !== LockStatus.Locked && lock.status !== LockStatus.Disputed,
  );
  const unrecorded = locks.filter((lock) => lock.status === LockStatus.Released && !lock.counted);
  const recordable = unrecorded.filter((lock) => lock.stage === 'paid-unrecorded');

  const stats = headResults.get(slots.stats);
  const record: ProviderRecord = {
    released: stats?.[0],
    timedOut: stats?.[1],
    disputed: stats?.[2],
    score: headResults.get(slots.score),
    cap: asMicro(headResults.get(slots.cap)),
    baseCap: asMicro(curve?.baseCap),
    capPerScore: asMicro(curve?.capPerScore),
    maxCap: asMicro(curve?.maxCap),
  };

  const agent = headResults.get(slots.agent);
  const complete = headResults.get(slots.nextId) !== undefined;

  return {
    payee,
    blockNumber: headResults.get(slots.blockNumber),
    chainTime,
    readAt: new Date(),
    requests,
    complete,
    failures: headResults.failures,
    terms: {
      feeBps,
      disputeWindow,
      disputeTimeoutPeriod: headResults.get(slots.disputeTimeoutPeriod),
      minTtl: headResults.get(slots.minTtl),
      maxTtl: headResults.get(slots.maxTtl),
      disputeBondBps: headResults.get(slots.disputeBondBps),
      resolverFeeBps,
    },
    record,
    standing: {
      name: agent?.name,
      registered: headResults.get(slots.registered),
      active: headResults.get(slots.active),
      barred: headResults.get(slots.barred),
      stake: asMicro(headResults.get(slots.stake)),
      minStake: asMicro(headResults.get(slots.minStake)),
      registeredAt: agent && agent.registeredAt > 0n ? new Date(Number(agent.registeredAt) * 1000) : null,
      maxSlash: asMicro(headResults.get(slots.maxSlash)),
      slashBps: headResults.get(slots.slashBps),
      withdrawalDelay: headResults.get(slots.withdrawalDelay),
      withdrawal: toWithdrawal(headResults.get(slots.withdrawal), headResults.get(slots.withdrawalDelay), chainTime),
      registryPaused: headResults.get(slots.registryPaused),
      allowance: asMicro(headResults.get(slots.allowance)),
    },
    balance: asMicro(headResults.get(slots.balance)),
    // What the escrow moved, across every lock in the scan. A lock that was returned to the payer
    // or refunded by a ruling adds nothing, which is the whole difference between this figure and
    // the one the desk used to show.
    paidOut: complete ? micro(locks.reduce((total, lock) => (lock.payout.kind === 'paid' ? total + lock.payout.amount : total), 0n)) : undefined,
    blocked: headResults.get(slots.blocked),
    tokenPaused: headResults.get(slots.paused),
    locks,
    working,
    settled,
    contested,
    unrecorded,
    recordable,
    projectedCap: projectCap(record, BigInt(recordable.length)),
    scanned: { from, to: highest, truncated: highest > SCAN_LIMIT },
  };
}

async function readDisputes(lockIds: readonly bigint[], signal?: AbortSignal): Promise<{
  readonly byLock: ReadonlyMap<bigint, DisputeRead>;
  readonly requests: number;
}> {
  const byLock = new Map<bigint, DisputeRead>();
  if (lockIds.length === 0) return { byLock, requests: 0 };

  const client = rhcClient();
  const oracleCall = (functionName: string, args: readonly unknown[]) => ({
    address: ADDRESSES.oracleRegistry,
    abi: oracleRegistryAbi as never,
    functionName,
    args,
  });

  const idBatch = new ReadBatch();
  const idSlots = lockIds.map((lockId) => ({
    lockId,
    slot: idBatch.add<bigint>(`oracle.disputeIdOf:${lockId}`, oracleCall('disputeIdOf', [lockId])),
  }));
  const idResults = await runBatch(client, idBatch, signal);

  const found = idSlots
    .map((entry) => ({ lockId: entry.lockId, disputeId: idResults.get(entry.slot) }))
    .filter((entry): entry is { lockId: bigint; disputeId: bigint } => entry.disputeId !== undefined && entry.disputeId > 0n);

  if (found.length === 0) return { byLock, requests: 1 };

  const detailBatch = new ReadBatch();
  const detailSlots = found.map((entry) => ({
    ...entry,
    slot: detailBatch.add<RawDispute>(`oracle.getDispute:${entry.disputeId}`, oracleCall('getDispute', [entry.disputeId])),
  }));
  const detailResults = await runBatch(client, detailBatch, signal);

  for (const entry of detailSlots) {
    const raw = detailResults.get(entry.slot);
    if (!raw) continue;
    byLock.set(entry.lockId, {
      id: entry.disputeId,
      status: raw.status,
      openedAt: toDate(raw.openedAt),
      commitEndsAt: toDate(raw.commitEndsAt),
      revealEndsAt: toDate(raw.revealEndsAt),
      commitCount: raw.commitCount,
      revealCount: raw.revealCount,
      medianScore: raw.medianScore,
      refundBps: raw.refundBps,
      rewardShares: raw.rewardShares,
    });
  }

  return { byLock, requests: 2 };
}

/** `IOracleRegistry.DisputeStatus`, in the order the enum declares. */
const DisputeStatus = { None: 0, Committing: 1, Revealing: 2, Finalized: 3, Failed: 4 } as const;

/** Whether the registry has closed this dispute, either with a median or without one. */
function disputeIsClosed(dispute: DisputeRead): boolean {
  return dispute.status === DisputeStatus.Finalized || dispute.status === DisputeStatus.Failed;
}

type LockRates = {
  readonly feeBps: number | undefined;
  readonly resolverFeeBps: number | undefined;
  readonly disputeWindow: bigint | undefined;
};

function toLock(id: bigint, raw: RawLock, rates: LockRates, now: Date, dispute: DisputeRead | undefined): ProviderLock {
  const amount = micro(raw.amount);
  const fee = rates.feeBps === undefined ? micro(0n) : mulBps(amount, rates.feeBps);
  const releasedAt = toDate(raw.releasedAt);
  const recordableAt =
    releasedAt === null || rates.disputeWindow === undefined
      ? null
      : new Date(releasedAt.getTime() + Number(rates.disputeWindow) * 1000);

  return {
    id,
    payer: raw.payer,
    disputer: raw.disputer,
    capabilityId: raw.capabilityId,
    inputURI: raw.inputURI,
    outputURI: raw.outputURI,
    amount,
    fee,
    net: micro(amount - fee),
    payout: payoutOf(raw, amount, fee, rates, dispute),
    deadline: new Date(Number(raw.deadline) * 1000),
    releasedAt,
    disputedAt: toDate(raw.disputedAt),
    bond: micro(raw.bond),
    status: raw.status as LockStatus,
    counted: raw.counted,
    recordableAt: raw.status === LockStatus.Released && !raw.counted ? recordableAt : null,
    stage: stageOf(raw, recordableAt, now, dispute),
    dispute,
  };
}

/**
 * What the escrow moved to this payee, worked out from the call that settled the lock.
 *
 * `release` charges `feeBps` on the whole amount. `resolve` takes the resolver fee off the top
 * first and charges `feeBps` only on what the payee is left with, which is a different base.
 * `timeout`, `cancel` and the escrow's own `disputeTimeout` move nothing to the payee at all.
 */
function payoutOf(
  raw: RawLock,
  amount: Micro,
  fee: Micro,
  rates: LockRates,
  dispute: DisputeRead | undefined,
): LockPayout {
  if (rates.feeBps === undefined) return { kind: 'unread' };
  const released = { kind: 'paid', amount: micro(amount - fee), fee } as const;

  switch (raw.status) {
    case LockStatus.Locked:
      return { kind: 'expected', amount: micro(amount - fee), fee };

    case LockStatus.Released:
      return released;

    case LockStatus.Disputed:
      // A dispute opened after the release cannot take the money back: `resolve` refuses a lock
      // whose `releasedAt` is set, and so does `disputeTimeout`. The payee keeps what it was paid.
      return raw.releasedAt === 0n ? { kind: 'at-stake', amount: micro(amount - fee), fee } : released;

    case LockStatus.Resolved: {
      if (dispute === undefined || rates.resolverFeeBps === undefined) return { kind: 'unread' };
      // The escrow's own `disputeTimeout` moves the lock to `Resolved` without telling the
      // registry, so an open dispute behind a resolved lock means nobody ruled and the payer took
      // the whole thing back.
      if (!disputeIsClosed(dispute)) return { kind: 'none' };

      const split = splitSettlement(amount, dispute.refundBps, rates.resolverFeeBps, rates.feeBps);
      return split.paid === 0n ? { kind: 'none' } : { kind: 'paid', amount: split.paid, fee: split.protocolFee };
    }

    case LockStatus.TimedOut:
    case LockStatus.Cancelled:
      return { kind: 'none' };

    default:
      return { kind: 'unread' };
  }
}

function stageOf(raw: RawLock, recordableAt: Date | null, now: Date, dispute: DisputeRead | undefined): LockStage {
  switch (raw.status) {
    case LockStatus.Locked:
      return new Date(Number(raw.deadline) * 1000) > now ? 'awaiting-delivery' : 'deadline-passed';
    case LockStatus.Released:
      if (raw.counted) return 'paid-recorded';
      // The contract refuses `finalizeRelease` until the dispute window has closed, so a release
      // inside it is waiting, not neglected. An unread window is treated as still open,
      // which is the answer that does not send a reader at a call that reverts.
      if (recordableAt === null || recordableAt >= now) return 'paid-open-to-dispute';
      return 'paid-unrecorded';
    case LockStatus.Disputed:
      return 'contested';
    case LockStatus.Resolved:
      if (dispute === undefined) return 'dispute-unread';
      if (dispute.status === DisputeStatus.Finalized) return 'ruled';
      return 'dispute-closed';
    case LockStatus.TimedOut:
      return 'returned-to-payer';
    case LockStatus.Cancelled:
      return 'declined';
    default:
      return 'awaiting-delivery';
  }
}

/**
 * `capOf = min(baseCap + capPerScore * score, maxCap)` with `score = released * 100 / settled`,
 * copied from `Reputation` so the screen can answer what recording finished work is worth before
 * anyone pays for a transaction to find out.
 */
export function projectCap(record: ProviderRecord, additionalReleases: bigint): Micro | undefined {
  if (record.baseCap === undefined || record.capPerScore === undefined || record.maxCap === undefined) return undefined;
  if (record.released === undefined || record.timedOut === undefined || record.disputed === undefined) return undefined;

  const released = record.released + additionalReleases;
  const settled = released + record.timedOut + record.disputed;
  const score = settled === 0n ? 0n : (released * 100n) / settled;
  const cap = record.baseCap + record.capPerScore * score;

  return micro(cap > record.maxCap ? record.maxCap : cap);
}

/**
 * Zero is the registry's way of saying nothing is pending, which is an answer and not a gap. The
 * gap is the call that never came back, and the two are kept apart here: null means no request,
 * undefined means nobody knows.
 */
export function toWithdrawal(
  raw: readonly [bigint, bigint] | undefined,
  delaySeconds: bigint | undefined,
  now: Date,
): WithdrawalRequest | null | undefined {
  if (raw === undefined) return undefined;

  const [amount, requestedAt] = raw;
  if (amount === 0n) return null;

  const maturesAt = delaySeconds === undefined ? null : new Date(Number(requestedAt + delaySeconds) * 1000);

  return {
    amount: micro(amount),
    requestedAt: new Date(Number(requestedAt) * 1000),
    maturesAt,
    matured: maturesAt === null ? undefined : maturesAt.getTime() <= now.getTime(),
  };
}

function asMicro(value: bigint | undefined): Micro | undefined {
  return value === undefined ? undefined : micro(value);
}

function toDate(seconds: bigint): Date | null {
  return seconds === 0n ? null : new Date(Number(seconds) * 1000);
}
