import type { Micro } from '@bursar/core';

import { parseUsdgInput, usd } from '@/money';

/**
 * One typed amount, and the reason it cannot be sent.
 *
 * The invariant is the point: a value is present exactly when there is no problem. Every form in
 * the console derives both its warning and whether its button is pressable from this one reading,
 * which is the only way those two can never disagree. Working them out separately is what left
 * Create pressable over a mandate the contract refuses, and a deposit pressable over a balance the
 * wallet does not hold.
 *
 * Every refusal names itself. A dead button over an empty slot tells a treasurer nothing, and the
 * parser already knows the difference between letters, a negative, too much precision and nothing
 * typed at all.
 */
export type AmountReading = {
  readonly value: Micro | undefined;
  readonly problem: string | undefined;
};

/** A ceiling the amount has to land under, with the sentence for landing over it. */
export type AmountCeiling = {
  readonly most: Micro;
  /**
   * Said when the typed amount is above `most`. The caller writes it, because a ceiling is a
   * balance in one place and a limit in another and those two are not the same sentence.
   */
  readonly over: string;
};

export type AmountOptions = {
  /**
   * Said when the field is empty. Leave it unset where an empty field is a legitimate answer, as
   * it is for the optional amount on a spend preview.
   */
  readonly whenEmpty?: string;
  readonly ceiling?: AmountCeiling;
};

export function readUsdgAmount(text: string, options: AmountOptions = {}): AmountReading {
  if (text.trim() === '') return { value: undefined, problem: options.whenEmpty };

  if (!grouped(text)) {
    return { value: undefined, problem: 'Group the digits in threes, or use no separators.' };
  }

  const parsed = parseUsdgInput(text);
  if (!parsed.ok) return { value: undefined, problem: parsed.problem };
  if (parsed.value <= 0n) return { value: undefined, problem: 'Enter a positive amount.' };

  const ceiling = options.ceiling;
  if (ceiling !== undefined && parsed.value > ceiling.most) return { value: undefined, problem: ceiling.over };

  return { value: parsed.value, problem: undefined };
}

export type FundingAmounts = {
  readonly deposit: AmountReading;
  readonly withdraw: AmountReading;
};

/**
 * The two amounts on the funding panel, and the two different ceilings they answer to.
 *
 * A deposit is bounded by what the owner's own wallet holds, because the account pulls it with
 * `transferFrom` and the token reverts inside that call with the fee already paid. A withdrawal is
 * bounded by what the mandate holds. They are different numbers about different accounts, and
 * neither sentence is the other's.
 *
 * A wallet balance the token did not report is no ceiling at all. It is left off rather than
 * guessed at, so an unread balance never turns into a refusal the reader cannot act on.
 */
export function fundingAmounts(input: {
  readonly depositText: string;
  readonly withdrawText: string;
  /** The owner's own settlement-asset balance, or undefined where the token did not answer. */
  readonly wallet: Micro | undefined;
  /** What the mandate account holds. */
  readonly held: Micro;
}): FundingAmounts {
  const { depositText, withdrawText, wallet, held } = input;

  return {
    deposit: readUsdgAmount(depositText, {
      whenEmpty: 'Enter how much USDG to move into this mandate.',
      ...(wallet === undefined ? {} : { ceiling: { most: wallet, over: `Your wallet holds ${usd(wallet)}.` } }),
    }),
    withdraw: readUsdgAmount(withdrawText, {
      whenEmpty: 'Enter how much USDG to send back to your wallet.',
      ceiling: { most: held, over: `This mandate holds ${usd(held)}.` },
    }),
  };
}

/**
 * Whether the digits before the decimal point are grouped the way a locale groups them.
 *
 * The parser takes the last separator as the decimal point and every earlier one as grouping,
 * which is what resolves 1.234,56 and 1,234.56 to the same amount. Carried far enough, that same
 * rule reads "1.2.3" as 12.3: an amount nobody meant, accepted in silence, on a form that moves
 * money. The parser is left alone, because three other surfaces read amounts through it. The
 * console refuses the shape instead and says what a group is.
 */
function grouped(text: string): boolean {
  const body = text.replace(/[\s']/g, '').replace(/^\+/, '');
  const at = Math.max(body.lastIndexOf(','), body.lastIndexOf('.'));
  const whole = at === -1 ? body : body.slice(0, at);

  if (!whole.includes(',') && !whole.includes('.')) return true;
  return /^\d{1,3}(?:,\d{3})+$/.test(whole) || /^\d{1,3}(?:\.\d{3})+$/.test(whole);
}
