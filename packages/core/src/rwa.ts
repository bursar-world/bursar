import { deploymentsForChain } from './deployments.js';
import type { RwaDeployment } from './deployment-record.js';

/** Bit 2 of a mandate's `classMask`: eligible stock purchases. */
export const RWA_CLASS_BIT = 1 << 2;

/**
 * The RWA lane that answers for a chain, if one is deployed. Only the newest record carrying one
 * counts; an older contract set has no RWA contracts to fall back to.
 */
export function rwaDeployment(chainId: number): RwaDeployment | undefined {
  return deploymentsForChain(chainId).find((d) => d.rwa !== undefined)?.rwa;
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
