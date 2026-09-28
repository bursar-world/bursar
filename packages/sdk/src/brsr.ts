import { formatUnits, parseUnits } from 'viem';

import { InvalidArgumentError } from './errors.js';

/**
 * BRSR, the token a resolver posts to be heard, at its own eighteen decimals.
 *
 * Branded separately from `Micro` because the two are not the same money and the compiler is the
 * only thing standing between a resolver and a bond a millionth of the size it meant. Settlement
 * is USDG at six decimals: a resolver's rewards arrive in it, a resolver's bond never does.
 *
 * A bond is collateral at risk, not a deposit. It is taken when a vote is silent or lands far
 * from the room, and nothing in the protocol pays a return on holding one.
 */
declare const brsrToken: unique symbol;
export type Brsr = bigint & { readonly [brsrToken]: true };

export const BRSR_DECIMALS = 18;
export const BRSR_SCALE = 10n ** 18n;

/** Brands an amount already in BRSR's own atomic units. Nothing is converted. */
export function brsr(atomic: bigint): Brsr {
  // A number here would come back unchanged and branded, and fail later in a bigint sum far from
  // the call that passed it.
  if (typeof atomic !== 'bigint') throw notText('brsr()', 'a bigint of atomic units, such as 10n ** 18n', atomic);

  return atomic as Brsr;
}

/**
 * Accepts the forms an eighteen-decimal amount arrives in: a bigint from a contract read, or a
 * digit string from JSON or a column. A number is refused outright rather than rounded, because
 * 25,000 BRSR does not survive a double.
 */
export function toBrsr(atomic: bigint | string): Brsr {
  if (typeof atomic === 'bigint') return atomic as Brsr;
  if (typeof atomic !== 'string') {
    throw notText('toBrsr()', 'a bigint or a digit string of atomic units', atomic);
  }

  const trimmed = atomic.trim();

  if (!/^-?\d+$/u.test(trimmed)) {
    throw new InvalidArgumentError(
      'amount',
      `"${atomic}" is not an integer number of BRSR atomic units. BRSR has ${BRSR_DECIMALS} ` +
        'decimals, so one whole token is "1000000000000000000".',
      { input: atomic },
    );
  }

  return BigInt(trimmed) as Brsr;
}

/** Parses a decimal BRSR figure such as `"25000"` or `"0.5"` into atomic units. */
export function parseBrsr(amount: string): Brsr {
  if (typeof amount !== 'string') throw notText('parseBrsr()', "a decimal string such as '25000.5'", amount);

  if (!/^\d+(?:\.\d{1,18})?$/u.test(amount.trim())) {
    throw new InvalidArgumentError(
      'amount',
      `"${amount}" is not a BRSR amount. Write it in whole tokens, with at most ${BRSR_DECIMALS} ` +
        'decimal places and no separators: "25000" or "25000.5".',
      { input: amount },
    );
  }

  return parseUnits(amount.trim(), BRSR_DECIMALS) as Brsr;
}

/** The refusal for a number handed to a helper that only takes exact forms. */
function notText(call: string, wanted: string, input: unknown): InvalidArgumentError {
  return new InvalidArgumentError(
    'amount',
    `${call} takes ${wanted}, and was given a ${typeof input} (${String(input)}). A JavaScript ` +
      `number stops being exact past 2^53, and an eighteen-decimal amount passes that at 0.009 BRSR.`,
    { input: String(input), type: typeof input },
  );
}

/** The same amount for a person to read. Never fed back into arithmetic. */
export function formatBrsr(amount: Brsr | bigint): string {
  return formatUnits(amount, BRSR_DECIMALS);
}
