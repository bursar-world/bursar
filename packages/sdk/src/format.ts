import { formatMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { formatEther } from 'viem';

/**
 * Display only. Every amount that crosses a wire or a contract boundary stays in atomic
 * micro-USD; this exists so an error message reads like money instead of like a counter.
 */
export function usd(value: Micro): string {
  return `${formatMicro(value, { minDecimals: 2, maxDecimals: 6, grouped: true })} USDG`;
}

/**
 * Gas, in the asset gas is actually paid in.
 *
 * Wei is a bigint and never a `Micro`: ETH is not the settlement asset and the two must not be
 * added, compared or formatted through the same path. Eighteen decimals of a fee budget is noise,
 * so this trims the tail without rounding a non-zero balance down to nothing.
 */
export function eth(wei: bigint): string {
  const exact = formatEther(wei);
  const [whole = '0', fraction = ''] = exact.split('.');
  const trimmed = fraction.slice(0, 9).replace(/0+$/u, '');

  if (trimmed !== '') return `${whole}.${trimmed} ETH`;
  // Anything under a gwei still has to read as a balance rather than as zero.
  return wei > 0n && whole === '0' ? 'less than 0.000000001 ETH' : `${whole} ETH`;
}

const MINUTE = 60n;
const HOUR = 3600n;
const DAY = 86_400n;

/**
 * A rough interval in the two largest units that carry meaning. Written for a human reading a
 * refusal, so "in 4h 12m" is the useful answer and 15132 seconds is not.
 */
export function formatDuration(seconds: bigint): string {
  if (seconds <= 0n) return 'now';

  if (seconds < MINUTE) return `${seconds}s`;

  if (seconds < HOUR) {
    const minutes = seconds / MINUTE;
    const rest = seconds % MINUTE;
    return rest === 0n ? `${minutes}m` : `${minutes}m ${rest}s`;
  }

  if (seconds < DAY) {
    const hours = seconds / HOUR;
    const rest = (seconds % HOUR) / MINUTE;
    return rest === 0n ? `${hours}h` : `${hours}h ${rest}m`;
  }

  const days = seconds / DAY;
  const rest = (seconds % DAY) / HOUR;
  return rest === 0n ? `${days}d` : `${days}d ${rest}h`;
}

/** Unix seconds as the chain holds them, as a Date. */
export function toDate(unixSeconds: bigint): Date {
  return new Date(Number(unixSeconds) * 1000);
}

/** Seconds between two instants, floored, for the interval in a refusal message. */
export function secondsUntil(target: Date, now: Date): bigint {
  return BigInt(Math.floor((target.getTime() - now.getTime()) / 1000));
}

/** An instant and how far away it is: "2026-09-12T00:00:00.000Z (in 4h 12m)". */
export function formatDeadline(target: Date, now: Date): string {
  const delta = secondsUntil(target, now);
  if (delta <= 0n) return target.toISOString();
  return `${target.toISOString()} (in ${formatDuration(delta)})`;
}
