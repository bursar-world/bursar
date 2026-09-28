/**
 * Three unit systems live in this app and they must never meet.
 *
 * USDG settles in six-decimal micro-USD and carries `Micro` from @bursar/core. $BRSR is an
 * eighteen-decimal governance and staking token and carries `Brsr`. ETH pays transaction fees and
 * carries `Wei`. All three are bigint underneath, so nothing but the type stops
 * `stake(balanceOfUsdg)` or `usd(feeInWei)` from compiling. The brands are what make those compile
 * errors. Without them the first is a transfer 10^12 times wrong and the second is a fee in ETH
 * printed with a dollar sign.
 *
 * Arithmetic is bigint end to end. Formatting is a separate step and its output never goes back
 * into a calculation.
 */
import { MICRO_DECIMALS } from '@bursar/core';
import type { Micro } from '@bursar/core';

declare const brsrToken: unique symbol;
export type Brsr = bigint & { readonly [brsrToken]: true };

export const BRSR_DECIMALS = 18;
export const BRSR_SCALE = 10n ** 18n;
export const ZERO_BRSR = 0n as Brsr;

declare const weiToken: unique symbol;
/** ETH in wei. What a transaction fee is paid in, and never what a payment is denominated in. */
export type Wei = bigint & { readonly [weiToken]: true };

export const ETH_DECIMALS = 18;
export const ZERO_WEI = 0n as Wei;

export class AmountError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'AmountError';
    this.field = field;
  }
}

/** Brands an amount already in wei of $BRSR. No conversion happens. */
export function brsr(atomic: bigint): Brsr {
  return atomic as Brsr;
}

/** Brands an amount already in wei of ETH. No conversion happens. */
export function wei(atomic: bigint): Wei {
  return atomic as Wei;
}

/**
 * ETH for a screen.
 *
 * A fee on this chain is a small number with its meaning in the last digits: 0.00003986 rounded to
 * four places is zero, and a fee shown as zero is a fee nobody budgets for. So nine places are
 * available and the trailing zeros come off, which reads a balance and a fee with the same
 * function and lies about neither.
 */
export function formatEth(value: Wei, options: AmountFormat = {}): string {
  const { minDecimals = 4, maxDecimals = 9, grouped = true, suffix = true } = options;
  const body = render(value, ETH_DECIMALS, minDecimals, maxDecimals, grouped);
  return suffix ? `${body} ETH` : body;
}

export function addBrsr(...values: readonly Brsr[]): Brsr {
  let total = 0n;
  for (const value of values) total += value;
  return total as Brsr;
}

export function subBrsr(a: Brsr, b: Brsr): Brsr {
  return (a - b) as Brsr;
}

export function minBrsr(a: Brsr, b: Brsr): Brsr {
  return a < b ? a : b;
}

export function maxBrsr(a: Brsr, b: Brsr): Brsr {
  return a > b ? a : b;
}

/** Share of a whole in basis points, truncated toward zero to match Solidity. */
export function brsrBps(value: Brsr, bps: number): Brsr {
  if (!Number.isInteger(bps) || bps < 0) throw new AmountError('bps', `Basis points must be a non-negative integer, got ${bps}.`);
  return ((value * BigInt(bps)) / 10_000n) as Brsr;
}

/**
 * Parses an exact decimal string of $BRSR. Strict: no exponents, no separators, no more than
 * eighteen decimal places. Use `parseAmount` for anything a person typed.
 */
export function parseBrsr(decimal: string): Brsr {
  return scale(decimal, BRSR_DECIMALS, 'amount') as Brsr;
}

export type AmountFormat = {
  /** Always show at least this many decimal places. */
  readonly minDecimals?: number;
  /** Never show more than this many. */
  readonly maxDecimals?: number;
  readonly grouped?: boolean;
  /** Appends the ticker, which is how a token balance reads outside a column of its own. */
  readonly suffix?: boolean;
};

/**
 * Display only. Eighteen decimals is more precision than any screen needs, so this shows four by
 * default and never rounds up: a staked balance shown larger than it is would be a lie about a
 * position.
 */
export function formatBrsr(value: Brsr, options: AmountFormat = {}): string {
  const { minDecimals = 2, maxDecimals = 4, grouped = true, suffix = false } = options;
  const body = render(value, BRSR_DECIMALS, minDecimals, maxDecimals, grouped);
  return suffix ? `${body} BRSR` : body;
}

/** The full-precision decimal string, for a field a caller will parse back. */
export function formatBrsrExact(value: Brsr): string {
  return render(value, BRSR_DECIMALS, 0, BRSR_DECIMALS, false);
}

export type ParsedAmount<T extends bigint> =
  | { readonly ok: true; readonly value: T; readonly canonical: string }
  | { readonly ok: false; readonly problem: string };

/**
 * What a person typed, turned into atomic units.
 *
 * Accepts a comma as the decimal separator, because most of the world writes 1,50 and a treasurer
 * typing their own locale should not be told their money is malformed. Where both separators
 * appear the last one is the decimal point and the other is grouping, which resolves 1.234,56 and
 * 1,234.56 the same correct way. A lone comma is always a decimal point: "1,5" is one and a half.
 *
 * `canonical` is the amount written back in one unambiguous form. Surfaces echo it next to the
 * field so the reading is never in doubt.
 */
export function parseAmount(input: string, decimals: number): ParsedAmount<bigint> {
  const cleaned = input.replace(/[\s   ']/g, '');
  if (cleaned === '') return { ok: false, problem: 'Enter an amount.' };

  const negative = cleaned.startsWith('-');
  if (negative) return { ok: false, problem: 'Enter a positive amount.' };

  const body = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  if (!/^[\d.,]+$/.test(body)) return { ok: false, problem: 'Use digits, and a comma or a dot for the decimal point.' };

  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');
  const separator = lastComma > lastDot ? ',' : lastDot > lastComma ? '.' : '';

  let whole = body;
  let fraction = '';
  if (separator !== '') {
    const at = separator === ',' ? lastComma : lastDot;
    whole = body.slice(0, at);
    fraction = body.slice(at + 1);
  }

  whole = whole.replace(/[.,]/g, '');
  if (fraction.includes('.') || fraction.includes(',')) {
    return { ok: false, problem: 'Only one decimal point.' };
  }

  if (whole === '' && fraction === '') return { ok: false, problem: 'Enter an amount.' };
  if (fraction.length > decimals) {
    return { ok: false, problem: `At most ${decimals} decimal places.` };
  }

  const value = BigInt(whole === '' ? '0' : whole) * 10n ** BigInt(decimals) + BigInt(fraction === '' ? '0' : fraction.padEnd(decimals, '0'));
  return { ok: true, value, canonical: render(value, decimals, 0, decimals, false) };
}

/** `parseAmount` narrowed to micro-USD, so a USDG field cannot hand back $BRSR. */
export function parseUsdgInput(input: string): ParsedAmount<Micro> {
  const parsed = parseAmount(input, MICRO_DECIMALS);
  return parsed.ok ? { ok: true, value: parsed.value as Micro, canonical: parsed.canonical } : parsed;
}

export function parseBrsrInput(input: string): ParsedAmount<Brsr> {
  const parsed = parseAmount(input, BRSR_DECIMALS);
  return parsed.ok ? { ok: true, value: parsed.value as Brsr, canonical: parsed.canonical } : parsed;
}

function scale(decimal: string, decimals: number, field: string): bigint {
  const match = new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`).exec(decimal.trim());
  if (!match) throw new AmountError(field, `"${decimal}" is not an amount with at most ${decimals} decimal places.`);
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
}

function render(value: bigint, decimals: number, minDecimals: number, maxDecimals: number, grouped: boolean): string {
  const scaleBy = 10n ** BigInt(decimals);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / scaleBy;
  const fraction = (magnitude % scaleBy).toString().padStart(decimals, '0');

  let shown = fraction.slice(0, maxDecimals);
  while (shown.length > minDecimals && shown.endsWith('0')) shown = shown.slice(0, -1);

  const head = grouped ? whole.toLocaleString('en-US') : whole.toString();
  const body = shown.length > 0 ? `${head}.${shown}` : head;
  return `${negative ? '-' : ''}${body}`;
}
