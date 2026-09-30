import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { Address } from 'viem';

import {
  ADDRESSES,
  ReadBatch,
  TOKEN_ADDRESSES,
  addBlockNumber,
  addChainTime,
  adminTimelockAbi,
  buybackAbi,
  escrowAbi,
  rhcClient,
  runBatch,
  settlementAssetAbi,
  stakingAbi,
} from '@/chain';
import { brsr } from '@/money';
import type { Brsr } from '@/money';

/**
 * Everything the operator surface stands on, in one aggregated request.
 *
 * Each figure is its own slot, so each is undefined on its own when that call went unanswered.
 * Fees of zero and fees that could not be read are opposite answers: one says there is nothing to
 * sweep, the other says nobody knows. The type keeps them apart and the page renders them apart.
 */

/**
 * Every figure the buyback spends is USDG, including the ceiling, which is a price in USDG for one
 * whole BRSR. The tier floor below it is BRSR. They are branded apart because this screen is the
 * one place in the product that renders both, one panel under the other.
 */
export type BuybackParams = {
  readonly spendPerCall: Micro;
  readonly maxSpendPerWindow: Micro;
  readonly minSpend: Micro;
  readonly maxPricePerBrsr: Micro;
  readonly window: bigint;
  readonly minInterval: bigint;
};

export type StakingTier = { readonly minStake: Brsr; readonly rebateBps: number };

export type OpsRead = {
  readonly blockNumber: bigint | undefined;
  readonly chainTime: Date | undefined;
  readonly readAt: Date;
  readonly failures: number;
  readonly fees: {
    readonly accrued: Micro | undefined;
    /** What the escrow holds in total. Locked money sits in the same balance as the fee. */
    readonly escrowBalance: Micro | undefined;
    readonly feeBps: number | undefined;
  };
  readonly treasury: {
    readonly current: Address | undefined;
    readonly pending: Address | undefined;
    readonly balance: Micro | undefined;
  };
  readonly signers: readonly Address[] | undefined;
  readonly guardian: Address | undefined;
  readonly staking: {
    readonly address: Address;
    readonly tiers: readonly StakingTier[] | undefined;
    readonly creditManager: Address | undefined;
    /** The one address that can take stake. The zero address means nobody can. */
    readonly slasher: Address | undefined;
    readonly paused: boolean | undefined;
  };
  readonly buyback: {
    readonly address: Address;
    readonly params: BuybackParams | undefined;
    /** The one address that can trigger a buy. The zero address means nobody can. */
    readonly keeper: Address | undefined;
    /** When the ceiling stops being usable, unless governance sets it again first. */
    readonly ceilingStaleAt: Date | undefined;
    readonly paused: boolean | undefined;
  };
};

type RawTier = { minStake: bigint; rebateBps: number };
type RawParams = {
  spendPerCallMicroUsd: bigint;
  maxSpendPerWindowMicroUsd: bigint;
  minSpendMicroUsd: bigint;
  maxPriceMicroUsdPerBrsr: bigint;
  window: bigint;
  minInterval: bigint;
};

export async function readOps(): Promise<OpsRead> {
  const client = rhcClient();
  const batch = new ReadBatch();

  const escrow = ADDRESSES.escrow;
  const usdg = ADDRESSES.usdg;

  const slots = {
    blockNumber: addBlockNumber(batch),
    chainTime: addChainTime(batch),
    feesAccrued: batch.add<bigint>('escrow.feesAccrued', { address: escrow, abi: escrowAbi as never, functionName: 'feesAccrued' }),
    feeBps: batch.add<number>('escrow.feeBps', { address: escrow, abi: escrowAbi as never, functionName: 'feeBps' }),
    treasury: batch.add<Address>('escrow.treasury', { address: escrow, abi: escrowAbi as never, functionName: 'treasury' }),
    pendingTreasury: batch.add<Address>('escrow.pendingTreasury', {
      address: escrow,
      abi: escrowAbi as never,
      functionName: 'pendingTreasury',
    }),
    escrowBalance: batch.add<bigint>('usdg.balanceOf.escrow', {
      address: usdg,
      abi: settlementAssetAbi as never,
      functionName: 'balanceOf',
      args: [escrow],
    }),
    signers: batch.add<readonly Address[]>('timelock.getSigners', {
      address: ADDRESSES.adminTimelock,
      abi: adminTimelockAbi as never,
      functionName: 'getSigners',
    }),
    guardian: batch.add<Address>('timelock.guardian', {
      address: ADDRESSES.adminTimelock,
      abi: adminTimelockAbi as never,
      functionName: 'guardian',
    }),
    tiers: batch.add<readonly RawTier[]>('staking.tiers', {
      address: TOKEN_ADDRESSES.Staking,
      abi: stakingAbi as never,
      functionName: 'tiers',
    }),
    creditManager: batch.add<Address>('staking.creditManager', {
      address: TOKEN_ADDRESSES.Staking,
      abi: stakingAbi as never,
      functionName: 'creditManager',
    }),
    slasher: batch.add<Address>('staking.slasher', {
      address: TOKEN_ADDRESSES.Staking,
      abi: stakingAbi as never,
      functionName: 'slasher',
    }),
    stakingPaused: batch.add<boolean>('staking.paused', {
      address: TOKEN_ADDRESSES.Staking,
      abi: stakingAbi as never,
      functionName: 'paused',
    }),
    params: batch.add<RawParams>('buyback.params', {
      address: TOKEN_ADDRESSES.Buyback,
      abi: buybackAbi as never,
      functionName: 'params',
    }),
    buybackPaused: batch.add<boolean>('buyback.paused', {
      address: TOKEN_ADDRESSES.Buyback,
      abi: buybackAbi as never,
      functionName: 'paused',
    }),
    keeper: batch.add<Address>('buyback.keeper', {
      address: TOKEN_ADDRESSES.Buyback,
      abi: buybackAbi as never,
      functionName: 'keeper',
    }),
    ceilingSetAt: batch.add<bigint>('buyback.ceilingSetAt', {
      address: TOKEN_ADDRESSES.Buyback,
      abi: buybackAbi as never,
      functionName: 'ceilingSetAt',
    }),
    maxCeilingAge: batch.add<bigint>('buyback.maxCeilingAge', {
      address: TOKEN_ADDRESSES.Buyback,
      abi: buybackAbi as never,
      functionName: 'maxCeilingAge',
    }),
  };

  const first = await runBatch(client, batch);
  const readAt = new Date();
  const blockNumber = first.get(slots.blockNumber);
  const treasury = first.get(slots.treasury);

  // The treasury's own balance needs its address, which the first request is what produces. A
  // second aggregate rather than a guess: the address compiled into the deployment record is the
  // one this build was shipped with, and the escrow is where it is held.
  let treasuryBalance: bigint | undefined;
  if (treasury !== undefined) {
    const second = new ReadBatch();
    const slot = second.add<bigint>('usdg.balanceOf.treasury', {
      address: usdg,
      abi: settlementAssetAbi as never,
      functionName: 'balanceOf',
      args: [treasury],
    });
    treasuryBalance = (await runBatch(client, second)).get(slot);
  }

  const chainTimeSeconds = first.get(slots.chainTime);
  const rawTiers = first.get(slots.tiers);
  const rawParams = first.get(slots.params);
  const ceilingSetAt = first.get(slots.ceilingSetAt);
  const maxCeilingAge = first.get(slots.maxCeilingAge);

  return {
    blockNumber,
    chainTime: chainTimeSeconds === undefined ? undefined : new Date(Number(chainTimeSeconds) * 1000),
    readAt,
    failures: first.failures,
    fees: {
      accrued: asMicro(first.get(slots.feesAccrued)),
      escrowBalance: asMicro(first.get(slots.escrowBalance)),
      feeBps: numberOf(first.get(slots.feeBps)),
    },
    treasury: {
      current: treasury,
      pending: first.get(slots.pendingTreasury),
      balance: asMicro(treasuryBalance),
    },
    signers: first.get(slots.signers),
    guardian: first.get(slots.guardian),
    staking: {
      address: TOKEN_ADDRESSES.Staking,
      tiers: rawTiers?.map((tier) => ({ minStake: brsr(tier.minStake), rebateBps: Number(tier.rebateBps) })),
      creditManager: first.get(slots.creditManager),
      slasher: first.get(slots.slasher),
      paused: first.get(slots.stakingPaused),
    },
    buyback: {
      address: TOKEN_ADDRESSES.Buyback,
      params:
        rawParams === undefined
          ? undefined
          : {
              spendPerCall: micro(rawParams.spendPerCallMicroUsd),
              maxSpendPerWindow: micro(rawParams.maxSpendPerWindowMicroUsd),
              minSpend: micro(rawParams.minSpendMicroUsd),
              maxPricePerBrsr: micro(rawParams.maxPriceMicroUsdPerBrsr),
              window: rawParams.window,
              minInterval: rawParams.minInterval,
            },
      keeper: first.get(slots.keeper),
      ceilingStaleAt:
        ceilingSetAt === undefined || maxCeilingAge === undefined ? undefined : new Date(Number(ceilingSetAt + maxCeilingAge) * 1000),
      paused: first.get(slots.buybackPaused),
    },
  };
}

function asMicro(value: bigint | undefined): Micro | undefined {
  return value === undefined ? undefined : micro(value);
}

function numberOf(value: number | bigint | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}
