'use client';

import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { BRSR_DECIMALS, formatBrsrExact, parseAmount, usd } from '../money';
import type { Brsr } from '../money';
import { formatMicro, MICRO_DECIMALS } from '@bursar/core';
import type { Micro } from '@bursar/core';

export type AmountAsset = 'USDG' | 'BRSR';

export type AmountInputProps = {
  readonly label: ReactNode;
  readonly asset: AmountAsset;
  /** The raw text the person typed. Held by the caller so nothing reformats under their cursor. */
  readonly value: string;
  /** Gives back the text and the atomic value, which is undefined while the text is not an amount. */
  readonly onChange: (text: string, atomic: bigint | undefined) => void;
  readonly hint?: ReactNode;
  /** A problem the caller found, such as an amount above a limit. It takes the echo's place. */
  readonly problem?: string;
  /** Fills the field with everything available, and says what that is. */
  readonly max?: { readonly atomic: bigint; readonly label?: string };
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
};

/**
 * An amount field that takes the decimal separator a person uses.
 *
 * Most of the world writes 1,50. Rejecting it as malformed, or worse reading it as 150, is the
 * kind of mistake that only shows up once money has moved. Whatever is typed, the canonical
 * reading is echoed under the field, so 1,5 and 1.5 are visibly the same amount and 1,500 is
 * visibly not fifteen hundred.
 *
 * The text and the number are separate things. The caller keeps both and spends the number.
 */
export function AmountInput({
  label,
  asset,
  value,
  onChange,
  hint,
  problem,
  max,
  placeholder = '0.00',
  disabled = false,
  autoFocus = false,
}: AmountInputProps) {
  const id = useId();
  // An empty field nobody has touched yet is not wrong; it is unfilled. The caller's problem shows
  // once the field has been typed in or left, so a fresh form does not open in red.
  const [touched, setTouched] = useState(false);
  const pristine = !touched && value.trim() === '';
  const decimals = asset === 'USDG' ? MICRO_DECIMALS : BRSR_DECIMALS;
  const parsed = value.trim() === '' ? undefined : parseAmount(value, decimals);
  const atomic = parsed?.ok ? parsed.value : undefined;
  const overMax = max !== undefined && atomic !== undefined && atomic > max.atomic;

  const shownProblem = pristine ? undefined : problem;
  const note = shownProblem
    ? shownProblem
    : overMax
      ? `That is more than the ${format(max.atomic, asset)} available.`
      : parsed && !parsed.ok
        ? parsed.problem
        : atomic !== undefined
          ? `Reads as ${format(atomic, asset)}`
          : undefined;

  const bad = Boolean(shownProblem) || overMax || (parsed !== undefined && !parsed.ok);

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
        {label}
      </label>
      <div
        className="flex items-center border bg-surface transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--color-ring)]"
        style={{ borderColor: bad ? 'var(--color-state-blocked)' : 'var(--color-line)' }}
      >
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={value}
          aria-invalid={bad}
          aria-describedby={note ? `${id}-note` : undefined}
          onBlur={() => setTouched(true)}
          onChange={(event) => {
            setTouched(true);
            const text = event.target.value;
            const next = text.trim() === '' ? undefined : parseAmount(text, decimals);
            onChange(text, next?.ok ? next.value : undefined);
          }}
          className="tabular h-11 w-full bg-transparent px-3.5 text-sm outline-none"
        />
        <span className="px-3 font-mono text-label uppercase tracking-wide text-[color:var(--color-muted)]">{asset}</span>
        {max && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(exact(max.atomic, asset), max.atomic)}
            className="mr-1.5 bg-[color:var(--color-raised)] px-2 py-1 font-mono text-label uppercase tracking-wide text-[color:var(--color-ink)] transition-colors hover:bg-[color:var(--color-accent)]"
          >
            {max.label ?? 'Max'}
          </button>
        )}
      </div>
      {note && (
        <p id={`${id}-note`} className="text-note" style={{ color: bad ? 'var(--color-state-blocked)' : 'var(--color-muted)' }}>
          {note}
        </p>
      )}
      {hint && !note && <p className="text-note text-[color:var(--color-muted)]">{hint}</p>}
    </div>
  );
}

function format(atomic: bigint, asset: AmountAsset): string {
  return asset === 'USDG' ? usd(atomic as Micro) : `${formatBrsrExact(atomic as Brsr)} BRSR`;
}

/** The value written back into the field, which has to round-trip through the parser unchanged. */
function exact(atomic: bigint, asset: AmountAsset): string {
  return asset === 'USDG'
    ? formatMicro(atomic as Micro, { minDecimals: 0, maxDecimals: MICRO_DECIMALS })
    : formatBrsrExact(atomic as Brsr);
}
