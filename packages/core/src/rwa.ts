import { currentSetDeployments } from './contract-set.js';
import type { CollateralDeployment, RwaDeployment } from './deployment-record.js';

/** Bit 2 of a mandate's `classMask`: eligible stock purchases. */
export const RWA_CLASS_BIT = 1 << 2;

/**
 * The RWA lane that answers for a chain, if one is deployed: the newest record carrying one within
 * the contract set that answers for the chain. An earlier set's lane is never read in its place.
 */
export function rwaDeployment(chainId: number): RwaDeployment | undefined {
  return currentSetDeployments(chainId).find((d) => d.rwa !== undefined)?.rwa;
}

/**
 * USDG micros for a raw token amount at a feed price with eight decimals. The Robinhood feeds
 * price one raw token with the multiplier already inside the answer, so the multiplier is not
 * applied here.
 */
export function rawToUsdgMicros(raw: bigint, priceE8: bigint, decimals = 18): bigint {
  return (raw * priceE8) / 10n ** BigInt(decimals + 2);
}

export function usdgMicrosToRaw(micros: bigint, priceE8: bigint, decimals = 18): bigint {
  if (priceE8 <= 0n) return 0n;
  return (micros * 10n ** BigInt(decimals + 2)) / priceE8;
}

/** A mandate's `lane` value for the collateral lane, the only lane that can borrow. */
export const COLLATERAL_LANE = 1;

/** What `CollateralVault.health` returns for a position with no debt. */
export const NO_DEBT_HEALTH = (1n << 256n) - 1n;

/**
 * `PriceGuard.DrawHalt`, in the order the enum declares: the first condition a draw against a
 * holding fails, and `None` when it fails none. Current state is checked before history and the
 * pool's spot last.
 */
export const DRAW_HALTS = [
  'None',
  'NoPrice',
  'Paused',
  'FeedStale',
  'NoObservation',
  'ObservationExpired',
  'ObservationOffBand',
  'FeedJump',
  'SpotOffBand',
] as const;

export type DrawHalt = (typeof DRAW_HALTS)[number];

/** The name behind the number a vault or a guard answers. Undefined for one this build does not know. */
export function drawHaltOf(value: number): DrawHalt | undefined {
  return DRAW_HALTS[value];
}

/** The collateral lane that answers for a chain, if one is deployed. */
export function collateralDeployment(chainId: number): CollateralDeployment | undefined {
  return rwaDeployment(chainId)?.collateral;
}

/**
 * Health as a plain ratio (1 is the liquidation edge), or null when nothing is owed: a position
 * with no debt has no health to measure.
 */
export function healthRatio(healthE18: bigint): number | null {
  if (healthE18 === NO_DEBT_HEALTH) return null;
  return Number(healthE18 / 10n ** 12n) / 1e6;
}
