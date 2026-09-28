import type { Address } from 'viem';

import {
  ADDRESSES,
  ReadBatch,
  TOKEN_ADDRESSES,
  addBlockNumber,
  assertTokenChain,
  rhcClient,
  brsrAbi,
  oracleRegistryAbi,
  runBatch,
  stakingAbi,
} from '@/chain';
import { brsr } from '@/money';
import type { Brsr } from '@/money';

/**
 * What the token page needs that `readToken` does not carry: who is holding each allocation right
 * now, whether the staking contract may take this wallet's tokens yet, and the two bond regimes
 * the dispute layer sits between.
 *
 * One more batch, and so one more request. A public endpoint refills about twenty requests a
 * second, and a page that asks for eighteen figures one at a time is a page the reader watches
 * load.
 */
export type SupplyHolders = {
  /** AdminTimelock. Every community release is a proposal that waits out the delay. */
  readonly community: Brsr | undefined;
  /** The vesting contract, which is where the team grant sits for the whole term. */
  readonly team: Brsr | undefined;
  readonly treasury: Brsr | undefined;
};

/**
 * The dispute layer's bond, read from both contracts that decide it.
 *
 * The registry names the currency a bond is posted in and holds what is posted. The floor itself
 * lives at the staking pool the registry points to, and the registry reads it live on every vote.
 * Neither figure means anything without the other, so both are read here and neither is assumed:
 * a page that names a currency the registry does not hold is describing a different deployment.
 */
export type ResolverBonding = {
  /** The token a resolver posts. Zero address means the registry has no collateral wired yet. */
  readonly bondAsset: Address | undefined;
  /** The staking pool holding the bond policy, as the registry names it. */
  readonly bondPool: Address | undefined;
  readonly totalBonded: Brsr | undefined;
  readonly unbondingPeriod: bigint | undefined;
  readonly quorum: number | undefined;
  readonly maxVoters: number | undefined;
  readonly slashBps: number | undefined;
  /** The floor at the staking contract. Zero blocks a bond at any amount. */
  readonly minBondBrsr: Brsr | undefined;
  readonly yourBond: Brsr | undefined;
  readonly yourStatus: number | undefined;
  readonly yourFinalized: number | undefined;
  readonly yourSlashes: number | undefined;
  readonly yourFloorBrsr: Brsr | undefined;
  readonly bondingDenied: boolean | undefined;
};

export type TokenExtras = {
  readonly blockNumber: bigint | undefined;
  readonly readAt: Date;
  /**
   * False when a call in this batch went unanswered. What the page cannot read stays unknown on
   * screen, because a holding that reads as zero and one that was never read mean opposite things.
   */
  readonly complete: boolean;
  readonly failures: number;
  readonly holders: SupplyHolders;
  /** What this wallet has already let the staking contract move. */
  readonly allowance: Brsr | undefined;
  /** The credit lane. Zero means nothing can be slashed and no spread is arriving. */
  readonly creditManager: Address | undefined;
  readonly bonding: ResolverBonding;
};

type RawOracleConfig = {
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

export async function readTokenExtras(account?: Address): Promise<TokenExtras> {
  assertTokenChain();

  const batch = new ReadBatch();
  const call = (address: Address, abi: unknown) => (functionName: string, args?: readonly unknown[]) => ({
    address,
    abi: abi as never,
    functionName,
    ...(args === undefined ? {} : { args }),
  });

  const token = call(TOKEN_ADDRESSES.BRSR, brsrAbi);
  const staking = call(TOKEN_ADDRESSES.Staking, stakingAbi);
  const oracle = call(ADDRESSES.oracleRegistry, oracleRegistryAbi);

  const blockNumber = addBlockNumber(batch);

  const holders = {
    community: batch.add<bigint>('brsr.balanceOf:timelock', token('balanceOf', [ADDRESSES.adminTimelock])),
    team: batch.add<bigint>('brsr.balanceOf:vesting', token('balanceOf', [TOKEN_ADDRESSES.Vesting])),
    treasury: batch.add<bigint>('brsr.balanceOf:treasury', token('balanceOf', [ADDRESSES.treasury])),
  };

  const creditManager = batch.add<Address>('staking.creditManager', staking('creditManager'));
  const minBondBrsr = batch.add<bigint>('staking.minBond', staking('minBond'));
  const oracleConfig = batch.add<RawOracleConfig>('oracle.config', oracle('config'));
  const totalBonded = batch.add<bigint>('oracle.totalBonded', oracle('totalBonded'));
  const bondAsset = batch.add<Address>('oracle.bondAsset', oracle('bondAsset'));
  const bondPool = batch.add<Address>('oracle.staking', oracle('staking'));

  const yours = account
    ? {
        allowance: batch.add<bigint>('brsr.allowance', token('allowance', [account, TOKEN_ADDRESSES.Staking])),
        resolver: batch.add<RawResolver>('oracle.getResolver', oracle('getResolver', [account])),
        floor: batch.add<bigint>('staking.minBondOf', staking('minBondOf', [account])),
        denied: batch.add<boolean>('staking.bondingDenied', staking('bondingDenied', [account])),
      }
    : undefined;

  const results = await runBatch(rhcClient(), batch);
  const config = results.get(oracleConfig);
  const resolver = yours ? results.get(yours.resolver) : undefined;

  return {
    blockNumber: results.get(blockNumber),
    readAt: new Date(),
    complete: results.failures === 0,
    failures: results.failures,
    holders: {
      community: asBrsr(results.get(holders.community)),
      team: asBrsr(results.get(holders.team)),
      treasury: asBrsr(results.get(holders.treasury)),
    },
    allowance: yours ? asBrsr(results.get(yours.allowance)) : undefined,
    creditManager: results.get(creditManager),
    bonding: {
      bondAsset: results.get(bondAsset),
      bondPool: results.get(bondPool),
      totalBonded: asBrsr(results.get(totalBonded)),
      unbondingPeriod: config?.unbondingPeriod,
      quorum: config?.quorum,
      maxVoters: config?.maxVoters,
      slashBps: config?.slashBps,
      minBondBrsr: asBrsr(results.get(minBondBrsr)),
      yourBond: asBrsr(resolver?.bond),
      yourStatus: resolver?.status,
      yourFinalized: resolver?.finalized,
      yourSlashes: resolver?.slashes,
      yourFloorBrsr: yours ? asBrsr(results.get(yours.floor)) : undefined,
      bondingDenied: yours ? results.get(yours.denied) : undefined,
    },
  };
}

function asBrsr(value: bigint | undefined): Brsr | undefined {
  return value === undefined ? undefined : brsr(value);
}
