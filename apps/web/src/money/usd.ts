import { formatMicro, MICRO_SCALE } from '@bursar/core';
import type { Micro } from '@bursar/core';

/**
 * USDG for a screen. `@bursar/core` owns the arithmetic and the exact string; these are the two
 * readings a surface wants, and they exist so every amount in the product is spaced and
 * suffixed the same way.
 */
export function usd(value: Micro): string {
  return formatMicro(value, { minDecimals: 2, maxDecimals: 2, grouped: true, symbol: true });
}

/** Full six-decimal precision, for a fee or a gas figure where the last digits carry meaning. */
export function usdExact(value: Micro): string {
  return formatMicro(value, { minDecimals: 2, maxDecimals: 6, grouped: true, symbol: true });
}

export function usdg(value: Micro): string {
  return `${formatMicro(value, { minDecimals: 2, maxDecimals: 6, grouped: true })} USDG`;
}

/** A share of a whole, 0 to 100, for a bar or a label. Returns null when the whole is zero. */
export function shareOf(part: Micro, whole: Micro): number | null {
  if (whole <= 0n) return null;
  return Number((part * 10_000n) / whole) / 100;
}

/** Basis points as a percentage string: 200 reads "2%". */
export function bps(value: number): string {
  const percent = value / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
}

export { MICRO_SCALE };
