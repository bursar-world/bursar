import { formatMicro, micro, microToAtomicString } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { formatUnits } from 'viem';

import type { BondView, MoneyView } from './types.js';

/** BRSR has eighteen decimals and USDG has six. Nothing converts between them; there is no price. */
export const BRSR_DECIMALS = 18;

/** Contract amounts arrive as uint128. They are already six-decimal atomic units, so this brands. */
export function fromUint(value: bigint): Micro {
  return micro(value);
}

export function money(value: Micro): MoneyView {
  return { micro: microToAtomicString(value), usdg: formatMicro(value) };
}

export function moneyFromUint(value: bigint): MoneyView {
  return money(fromUint(value));
}

/** A bond, in the token bonds are actually posted in. Never fed through the money path. */
export function bond(atomic: bigint): BondView {
  return { atomic: atomic.toString(), brsr: formatUnits(atomic, BRSR_DECIMALS) };
}

/**
 * The last second a JavaScript Date can hold. Contracts store times as uint64, and a principal who
 * means "no end" may write the largest one, which `toISOString` refuses with a RangeError.
 */
const LATEST_SECOND = 8_640_000_000_000;

/** Chain time, rendered for a reader. Every absolute time this server emits is UTC and to the second. */
export function instant(seconds: bigint | number): string {
  return instantOrNull(seconds) ?? 'never';
}

/** The same, or null for a time past the end of the calendar, which a field reports as unbounded. */
export function instantOrNull(seconds: bigint | number): string | null {
  const value = Number(seconds);

  if (value > LATEST_SECOND) return null;

  return new Date(value * 1000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/** Seconds until `at`, floored at zero: a deadline in the past is zero away, not negative. */
export function secondsUntil(at: bigint, now: bigint): number {
  return at > now ? Number(at - now) : 0;
}

export function duration(seconds: number): string {
  if (seconds % 86_400 === 0) return plural(seconds / 86_400, 'day');
  if (seconds % 3_600 === 0) return plural(seconds / 3_600, 'hour');
  if (seconds % 60 === 0) return plural(seconds / 60, 'minute');

  return plural(seconds, 'second');
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}
