import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { LockStatus } from '@bursar/sdk';
import type { Address, Hex } from 'viem';

import {
  ADDRESSES,
  ReadBatch,
  TOKEN_ADDRESSES,
  addChainTime,
  brsrAbi,
  readableDeployments,
  escrowAbi,
  oracleRegistryAbi,
  rhcClient,
  runBatch,
  stakingAbi,
} from '@/chain';
import type { DeploymentTag } from '@/chain';
import { brsr } from '@/money';
import type { Brsr } from '@/money';

import { DisputeStatus, exitFor, phaseDeadline, phaseOf } from './phases';
import type { DisputeExit, DisputePhase, VotingRules } from './phases';

/**
 * Everything a resolver needs, in three aggregated requests.
 *
 * The registry indexes disputes by id and by nothing else, and `DisputeOpened` carries no field
 * worth filtering a log scan on. Walking ids down from `nextDisputeId` through Multicall3 reads the
 * same records in a bounded number of requests whatever the count, and the surface says which ids
 * it covered rather than implying it read them all.
 *
 * Nothing here needs a wallet. The panel, the windows and the bond floor are public, and the
 * account-shaped reads are added to the same batches only when there is an account to read.
 */

/** Newest disputes read per pass. The registry has no pagination, so the ceiling is ours. */
const SCAN_LIMIT = 100n;

/** Disputes per aggregated call. Four slots each with a wallet connected, which fills one call. */
const SCAN_CHUNK = 25;

/** Settlements per aggregated call. Each lock carries two strings, so returndata is the limit. */
const LOCK_CHUNK = 40;

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

export type OracleConfig = VotingRules & {
  readonly commitWindow: bigint;
  readonly revealWindow: bigint;
  readonly unbondingPeriod: bigint;
};

/** The settlement a dispute is about. Undefined where the escrow did not answer for it. */
export type ContestedSettlement = {
  readonly id: bigint;
  readonly payer: Address;
  readonly payee: Address;
  /** Who contested it. The payer in every case the escrow allows today. */
  readonly disputer: Address;
  /** What the payer locked, in the settlement asset. Never BRSR. */
  readonly amount: Micro;
  /** What the disputer staked to open the dispute. Returned or forfeited by the ruling. */
  readonly bond: Micro;
  readonly capabilityId: Hex;
  readonly inputURI: string;
  readonly outputURI: string;
  readonly deadline: Date;
  readonly disputedAt: Date | null;
  readonly status: LockStatus;
};

/** This wallet's part in one dispute. Undefined throughout without a wallet. */
export type YourVote = {
  /** The sealed hash the registry holds. Undefined when the read failed. */
  readonly commitment: Hex | undefined;
  readonly committed: boolean | undefined;
  readonly revealed: boolean | undefined;
  /** The published score. Meaningless until `revealed`. */
  readonly score: number | undefined;
  /** Whether this vote is in the split of the resolver fee. Set when the dispute closes. */
  readonly rewarded: boolean | undefined;
};

export type DisputeRow = {
  /**
   * The registry and escrow this dispute lives on. Ids restart with every deployment, so a dispute
   * is named by the pair. Disputes on an older set are shown and never voted on from here.
   */
  readonly deployment: DeploymentTag;
  /** That registry's voting rules, which the phase and the panel size were judged against. */
  readonly config: OracleConfig | undefined;
  /** That escrow's cut of a settled lock. */
  readonly resolverFeeBps: number | undefined;
  readonly id: bigint;
  readonly escrowId: bigint;
  readonly status: number;
  readonly openedAt: Date | null;
  readonly commitEndsAt: Date | null;
  readonly revealEndsAt: Date | null;
  readonly commitCount: number;
  readonly revealCount: number;
  readonly medianScore: number;
  readonly refundBps: number;
  readonly rewardShares: number;
  readonly phase: DisputePhase;
  /** When the phase on screen runs out. Null where the dispute waits on a person, not a clock. */
  readonly deadline: Date | null;
  /** Which call the registry accepts right now. */
  readonly exit: DisputeExit;
  readonly settlement: ContestedSettlement | undefined;
  readonly yours: YourVote | undefined;
};

export type ResolverStanding = {
  readonly address: Address;
  readonly bond: Brsr | undefined;
  readonly status: number | undefined;
  /** Disputes this resolver saw through to a ruling. */
  readonly finalized: number | undefined;
  readonly slashes: number | undefined;
  /** When the exit was asked for, not when it matures. */
  readonly unbondingAt: Date | null;
  readonly maturesAt: Date | null;
  /** Commitments made and not yet settled. Every one of them holds the bond in place. */
  readonly openVotes: number | undefined;
  /** Unclaimed resolver fees, in the settlement asset. Bonds are BRSR and never mix with this. */
  readonly rewards: Micro | undefined;
  /** This address's floor at the staking pool, which governance can raise above the global one. */
  readonly floor: Brsr | undefined;
  readonly barred: boolean | undefined;
  readonly balance: Brsr | undefined;
  /** BRSR this wallet has already let the registry move. */
  readonly allowance: Brsr | undefined;
  /** What the bond is short of the floor. Zero when it clears. */
  readonly short: Brsr | undefined;
};

export type ResolverDesk = {
  readonly registry: Address;
  /**
   * Chain time, and the only provenance this desk claims.
   *
   * Every window on this screen is decided by it, not by the browser's clock. There is no block
   * number here on purpose: `block.number` inside the EVM on an Arbitrum Orbit chain answers the
   * settlement chain's height, not this one's, so a figure labelled "at block N" next to a link to
   * the explorer would name two different blocks.
   */
  readonly chainTime: Date;
  readonly readAt: Date;
  readonly requests: number;
  /** False when any slot in any batch went unanswered. */
  readonly complete: boolean;
  readonly failures: number;
  /**
   * False when the registry did not say how many disputes exist. The list below is then unknown
   * rather than empty, and those are opposite answers on a screen a resolver is paid to watch.
   */
  readonly disputesReadable: boolean;
  readonly config: OracleConfig | undefined;
  readonly bondAsset: Address | undefined;
  readonly bondPool: Address | undefined;
  readonly rewardAsset: Address | undefined;
  readonly escrow: Address | undefined;
  readonly slashSink: Address | undefined;
  /** The global floor at the staking pool. What an address with no floor of its own has to post. */
  readonly minBond: Brsr | undefined;
  readonly totalBonded: Brsr | undefined;
  readonly resolverCount: number | undefined;
  /** Fees that reached no resolver, waiting to be swept to the slash sink. */
  readonly unallocatedRewards: Micro | undefined;
  /** The cut of a settled lock the escrow returns to the panel that ruled on it. */
  readonly resolverFeeBps: number | undefined;
  readonly disputes: readonly DisputeRow[];
  /** Still open to a vote or to a closing call. */
  readonly open: readonly DisputeRow[];
  readonly settled: readonly DisputeRow[];
  readonly standing: ResolverStanding | undefined;
  readonly scanned: Scanned;
  /**
   * The older registries this chain still carries, read for the disputes still open on them. Their
   * rows are in `disputes`, `open` and `settled` with the rest, tagged with the deployment.
   */
  readonly earlier: readonly EarlierRegistry[];
};

export type Scanned = { readonly from: bigint; readonly to: bigint; readonly truncated: boolean };

export type EarlierRegistry = {
  readonly deployment: DeploymentTag;
  /** False when that registry did not say how many disputes it holds. */
  readonly disputesReadable: boolean;
  readonly scanned: Scanned;
};

type RawConfig = {
  commitWindow: bigint;
  revealWindow: bigint;
  unbondingPeriod: bigint;
  quorum: number;
  maxVoters: number;
  maxDeviation: number;
  slashBps: number;
};

type RawResolver = {
  bond: bigint;
  unbondingAt: bigint;
  finalized: number;
  slashes: number;
  status: number;
};

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

export async function readResolverDesk(account?: Address, signal?: AbortSignal): Promise<ResolverDesk> {
  const client = rhcClient();
  const [current, ...older] = readableDeployments();
  const registry = current?.oracleRegistry ?? ADDRESSES.oracleRegistry;
  const escrowAddress = current?.escrow ?? ADDRESSES.escrow;

  const head = new ReadBatch();
  const at =
    (address: Address, abi: unknown) =>
    (functionName: string, args?: readonly unknown[]) => ({
      address,
      abi: abi as never,
      functionName,
      ...(args === undefined ? {} : { args }),
    });

  const oracle = at(registry, oracleRegistryAbi);
  const staking = at(TOKEN_ADDRESSES.Staking, stakingAbi);
  const token = at(TOKEN_ADDRESSES.BRSR, brsrAbi);
  const escrow = at(escrowAddress, escrowAbi);

  const slots = {
    chainTime: addChainTime(head),
    config: head.add<RawConfig>('oracle.config', oracle('config')),
    nextDisputeId: head.add<bigint>('oracle.nextDisputeId', oracle('nextDisputeId')),
    totalBonded: head.add<bigint>('oracle.totalBonded', oracle('totalBonded')),
    resolverCount: head.add<bigint>('oracle.resolverCount', oracle('resolverCount')),
    bondAsset: head.add<Address>('oracle.bondAsset', oracle('bondAsset')),
    bondPool: head.add<Address>('oracle.staking', oracle('staking')),
    rewardAsset: head.add<Address>('oracle.settlementAsset', oracle('settlementAsset')),
    escrow: head.add<Address>('oracle.escrow', oracle('escrow')),
    slashSink: head.add<Address>('oracle.slashSink', oracle('slashSink')),
    unallocated: head.add<bigint>('oracle.unallocatedRewards', oracle('unallocatedRewards')),
    minBond: head.add<bigint>('staking.minBond', staking('minBond')),
    resolverFeeBps: head.add<number>('escrow.resolverFeeBps', escrow('resolverFeeBps')),
  };

  const yours = account
    ? {
        resolver: head.add<RawResolver>('oracle.getResolver', oracle('getResolver', [account])),
        openVotes: head.add<number>('oracle.openVotes', oracle('openVotes', [account])),
        rewards: head.add<bigint>('oracle.rewardsOf', oracle('rewardsOf', [account])),
        floor: head.add<bigint>('staking.minBondOf', staking('minBondOf', [account])),
        barred: head.add<boolean>('staking.bondingDenied', staking('bondingDenied', [account])),
        balance: head.add<bigint>('brsr.balanceOf', token('balanceOf', [account])),
        allowance: head.add<bigint>('brsr.allowance', token('allowance', [account, registry])),
      }
    : undefined;

  // The older sets are read in the same request as the current one. Their registries answer the
  // same view functions, so one ABI reads both.
  const earlierSlots = older.map((tag) => {
    const oldOracle = at(tag.oracleRegistry, oracleRegistryAbi);
    return {
      tag,
      config: head.add<RawConfig>(`oracle.config@${tag.name}`, oldOracle('config')),
      nextDisputeId: head.add<bigint>(`oracle.nextDisputeId@${tag.name}`, oldOracle('nextDisputeId')),
      resolverFeeBps: head.add<number>(`escrow.resolverFeeBps@${tag.name}`, at(tag.escrow, escrowAbi)('resolverFeeBps')),
    };
  });

  const headResults = await runBatch(client, head, signal);
  let requests = 1;
  let failures = headResults.failures;

  const chainSeconds = headResults.get(slots.chainTime);
  const chainTime = chainSeconds === undefined ? new Date() : new Date(Number(chainSeconds) * 1000);
  const config = toConfig(headResults.get(slots.config));
  const nextDisputeId = headResults.get(slots.nextDisputeId);
  const resolverFeeBps = headResults.get(slots.resolverFeeBps);

  const currentTag: DeploymentTag = current ?? {
    name: 'current',
    contractSet: 'v2',
    current: true,
    escrow: escrowAddress,
    oracleRegistry: registry,
  };

  const sets = [
    { tag: currentTag, config, nextDisputeId, resolverFeeBps },
    ...earlierSlots.map((entry) => ({
      tag: entry.tag,
      config: toConfig(headResults.get(entry.config)),
      nextDisputeId: headResults.get(entry.nextDisputeId),
      resolverFeeBps: headResults.get(entry.resolverFeeBps),
    })),
  ];

  const read = await Promise.all(
    sets.map(async (set) => {
      const scanned = scanRange(set.nextDisputeId);
      const ids: bigint[] = [];
      for (let id = scanned.to; id >= scanned.from && id >= 1n; id -= 1n) ids.push(id);

      const scan = await readDisputes(set.tag.oracleRegistry, ids, account, signal);
      const locks = await readSettlements(
        set.tag.escrow,
        scan.rows.map((row) => row.escrowId).filter((id) => id > 0n),
        signal,
      );

      // Without a config there are no rules to judge a phase against, and guessing one would put a
      // countdown on screen that the contract does not hold. Every row then reads as unknown.
      const rows = scan.rows.map((row) =>
        toRow(row, set, chainTime, locks.byId.get(row.escrowId)),
      );
      return {
        set,
        scanned,
        rows,
        requests: scan.requests + locks.requests,
        failures: scan.failures + locks.failures,
      };
    }),
  );

  for (const entry of read) {
    requests += entry.requests;
    failures += entry.failures;
  }

  const disputes = read.flatMap((entry) => entry.rows);
  const scanned = read[0]?.scanned ?? scanRange(undefined);

  const rawResolver = yours ? headResults.get(yours.resolver) : undefined;
  const floor = yours ? headResults.get(yours.floor) : undefined;
  const bond = rawResolver?.bond;
  const unbondingAt = rawResolver && rawResolver.unbondingAt > 0n ? new Date(Number(rawResolver.unbondingAt) * 1000) : null;

  const standing: ResolverStanding | undefined =
    account === undefined || yours === undefined
      ? undefined
      : {
          address: account,
          bond: asBrsr(bond),
          status: rawResolver?.status,
          finalized: rawResolver?.finalized,
          slashes: rawResolver?.slashes,
          unbondingAt,
          maturesAt:
            unbondingAt === null || config === undefined
              ? null
              : new Date(unbondingAt.getTime() + Number(config.unbondingPeriod) * 1000),
          openVotes: headResults.get(yours.openVotes),
          rewards: asMicro(headResults.get(yours.rewards)),
          floor: asBrsr(floor),
          barred: headResults.get(yours.barred),
          balance: asBrsr(headResults.get(yours.balance)),
          allowance: asBrsr(headResults.get(yours.allowance)),
          short: bond === undefined || floor === undefined ? undefined : brsr(floor > bond ? floor - bond : 0n),
        };

  const resolverCount = headResults.get(slots.resolverCount);

  return {
    registry,
    chainTime,
    readAt: new Date(),
    requests,
    complete: failures === 0,
    failures,
    disputesReadable: nextDisputeId !== undefined,
    config,
    bondAsset: headResults.get(slots.bondAsset),
    bondPool: headResults.get(slots.bondPool),
    rewardAsset: headResults.get(slots.rewardAsset),
    escrow: headResults.get(slots.escrow),
    slashSink: headResults.get(slots.slashSink),
    minBond: asBrsr(headResults.get(slots.minBond)),
    totalBonded: asBrsr(headResults.get(slots.totalBonded)),
    resolverCount: resolverCount === undefined ? undefined : Number(resolverCount),
    unallocatedRewards: asMicro(headResults.get(slots.unallocated)),
    resolverFeeBps,
    disputes,
    open: disputes.filter((row) => row.phase === 'commit' || row.phase === 'reveal' || row.phase === 'ruling'),
    settled: disputes.filter((row) => row.phase === 'finalized' || row.phase === 'failed'),
    standing,
    scanned,
    earlier: read.slice(1).map((entry) => ({
      deployment: entry.set.tag,
      disputesReadable: entry.set.nextDisputeId !== undefined,
      scanned: entry.scanned,
    })),
  };
}

function scanRange(nextDisputeId: bigint | undefined): Scanned {
  const highest = nextDisputeId !== undefined && nextDisputeId > 0n ? nextDisputeId - 1n : 0n;
  const from = highest > SCAN_LIMIT ? highest - SCAN_LIMIT + 1n : 1n;
  return { from, to: highest, truncated: highest > SCAN_LIMIT };
}

function toConfig(raw: RawConfig | undefined): OracleConfig | undefined {
  return raw === undefined
    ? undefined
    : {
        commitWindow: raw.commitWindow,
        revealWindow: raw.revealWindow,
        unbondingPeriod: raw.unbondingPeriod,
        quorum: raw.quorum,
        maxVoters: raw.maxVoters,
        maxDeviation: raw.maxDeviation,
        slashBps: raw.slashBps,
      };
}

type ScannedDispute = RawDispute & { readonly id: bigint; readonly yours: YourVote | undefined };

async function readDisputes(
  registry: Address,
  ids: readonly bigint[],
  account: Address | undefined,
  signal?: AbortSignal,
): Promise<{ readonly rows: readonly ScannedDispute[]; readonly requests: number; readonly failures: number }> {
  if (ids.length === 0) return { rows: [], requests: 0, failures: 0 };

  const client = rhcClient();
  const oracle = (functionName: string, args: readonly unknown[]) => ({
    address: registry,
    abi: oracleRegistryAbi as never,
    functionName,
    args,
  });

  const chunks: bigint[][] = [];
  for (let index = 0; index < ids.length; index += SCAN_CHUNK) chunks.push([...ids.slice(index, index + SCAN_CHUNK)]);

  const scanned = await Promise.all(
    chunks.map(async (chunk) => {
      const batch = new ReadBatch();
      const entries = chunk.map((id) => ({
        id,
        dispute: batch.add<RawDispute>(`oracle.getDispute:${id}`, oracle('getDispute', [id])),
        commitment: account ? batch.add<Hex>(`oracle.committedBy:${id}`, oracle('committedBy', [id, account])) : undefined,
        revealed: account
          ? batch.add<readonly [boolean, number]>(`oracle.revealedBy:${id}`, oracle('revealedBy', [id, account]))
          : undefined,
        rewarded: account ? batch.add<boolean>(`oracle.rewardedBy:${id}`, oracle('rewardedBy', [id, account])) : undefined,
      }));

      const results = await runBatch(client, batch, signal);

      const rows = entries.flatMap((entry): ScannedDispute[] => {
        const raw = results.get(entry.dispute);
        if (raw === undefined || raw.status === DisputeStatus.None) return [];

        const commitment = results.get(entry.commitment);
        const revealed = results.get(entry.revealed);

        return [
          {
            ...raw,
            id: entry.id,
            yours:
              account === undefined
                ? undefined
                : {
                    commitment,
                    committed: commitment === undefined ? undefined : commitment !== ZERO_BYTES32,
                    revealed: revealed?.[0],
                    score: revealed?.[1],
                    rewarded: results.get(entry.rewarded),
                  },
          },
        ];
      });

      return { rows, failures: results.failures };
    }),
  );

  return {
    rows: scanned.flatMap((entry) => entry.rows),
    requests: chunks.length,
    failures: scanned.reduce((total, entry) => total + entry.failures, 0),
  };
}

async function readSettlements(
  escrow: Address,
  escrowIds: readonly bigint[],
  signal?: AbortSignal,
): Promise<{ readonly byId: ReadonlyMap<bigint, ContestedSettlement>; readonly requests: number; readonly failures: number }> {
  const byId = new Map<bigint, ContestedSettlement>();
  if (escrowIds.length === 0) return { byId, requests: 0, failures: 0 };

  const client = rhcClient();
  const unique = [...new Set(escrowIds)];
  const chunks: bigint[][] = [];
  for (let index = 0; index < unique.length; index += LOCK_CHUNK) chunks.push(unique.slice(index, index + LOCK_CHUNK));

  const scanned = await Promise.all(
    chunks.map(async (chunk) => {
      const batch = new ReadBatch();
      const entries = chunk.map((id) => ({
        id,
        slot: batch.add<RawLock>(`escrow.getLock:${id}`, {
          address: escrow,
          abi: escrowAbi as never,
          functionName: 'getLock',
          args: [id],
        }),
      }));

      const results = await runBatch(client, batch, signal);
      return {
        found: entries.map((entry) => ({ id: entry.id, raw: results.get(entry.slot) })),
        failures: results.failures,
      };
    }),
  );

  for (const chunk of scanned) {
    for (const entry of chunk.found) {
      if (entry.raw === undefined || entry.raw.status === LockStatus.None) continue;
      byId.set(entry.id, {
        id: entry.id,
        payer: entry.raw.payer,
        payee: entry.raw.payee,
        disputer: entry.raw.disputer,
        amount: micro(entry.raw.amount),
        bond: micro(entry.raw.bond),
        capabilityId: entry.raw.capabilityId,
        inputURI: entry.raw.inputURI,
        outputURI: entry.raw.outputURI,
        deadline: new Date(Number(entry.raw.deadline) * 1000),
        disputedAt: entry.raw.disputedAt === 0n ? null : new Date(Number(entry.raw.disputedAt) * 1000),
        status: entry.raw.status as LockStatus,
      });
    }
  }

  return {
    byId,
    requests: chunks.length,
    failures: scanned.reduce((total, entry) => total + entry.failures, 0),
  };
}

type RegistrySet = {
  readonly tag: DeploymentTag;
  readonly config: OracleConfig | undefined;
  readonly resolverFeeBps: number | undefined;
};

function toRow(
  raw: ScannedDispute,
  set: RegistrySet,
  now: Date,
  settlement: ContestedSettlement | undefined,
): DisputeRow {
  const rules: VotingRules | undefined = set.config;
  const clock = {
    status: raw.status,
    commitEndsAt: toDate(raw.commitEndsAt),
    revealEndsAt: toDate(raw.revealEndsAt),
    commitCount: raw.commitCount,
    revealCount: raw.revealCount,
  };

  const phase = rules === undefined ? 'unknown' : phaseOf(clock, rules, now);

  return {
    deployment: set.tag,
    config: set.config,
    resolverFeeBps: set.resolverFeeBps,
    id: raw.id,
    escrowId: raw.escrowId,
    status: raw.status,
    openedAt: toDate(raw.openedAt),
    commitEndsAt: clock.commitEndsAt,
    revealEndsAt: clock.revealEndsAt,
    commitCount: raw.commitCount,
    revealCount: raw.revealCount,
    medianScore: raw.medianScore,
    refundBps: raw.refundBps,
    rewardShares: raw.rewardShares,
    phase,
    deadline: phaseDeadline(clock, phase),
    exit: rules === undefined ? 'none' : exitFor(clock, rules, now),
    settlement,
    yours: raw.yours,
  };
}

function asBrsr(value: bigint | undefined): Brsr | undefined {
  return value === undefined ? undefined : brsr(value);
}

function asMicro(value: bigint | undefined): Micro | undefined {
  return value === undefined ? undefined : micro(value);
}

function toDate(seconds: bigint): Date | null {
  return seconds === 0n ? null : new Date(Number(seconds) * 1000);
}
