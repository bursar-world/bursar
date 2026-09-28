'use client';

import { useId } from 'react';
import type { ReactNode } from 'react';
import { getAddress, isAddress } from 'viem';
import type { Address } from 'viem';

/**
 * An address field that answers before a wallet opens.
 *
 * Whatever case it is typed or pasted in, the checksum form is echoed underneath, because the
 * checksum is the only part of an address a person can check by eye. A value that is not an
 * address is rejected here, long before a transaction is up in a wallet waiting to be signed.
 */
export type AddressReading = { readonly value: Address | undefined; readonly problem: string | undefined };

export function readAddress(text: string): AddressReading {
  const trimmed = text.trim();
  if (trimmed === '') return { value: undefined, problem: undefined };
  if (!isAddress(trimmed, { strict: false })) {
    return { value: undefined, problem: 'An address is 42 characters, starting 0x.' };
  }
  return { value: getAddress(trimmed), problem: undefined };
}

export function AddressInput({
  label,
  value,
  onChange,
  hint,
  problem,
  placeholder = '0x',
  disabled = false,
  action,
}: {
  readonly label: ReactNode;
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly hint?: ReactNode;
  readonly problem?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** A control that belongs to the field, kept on the input's row so the note under it cannot push it out of line. */
  readonly action?: ReactNode;
}) {
  const id = useId();
  const reading = readAddress(value);
  const shown = problem ?? reading.problem;
  const note = shown ?? (reading.value ? `Reads as ${reading.value}` : undefined);

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
        {label}
      </label>
      <div className="flex flex-wrap items-stretch gap-2">
        <div className="min-w-0 flex-1 basis-60">
          <input
            id={id}
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={shown !== undefined}
            aria-describedby={note ? `${id}-note` : undefined}
            onChange={(event) => onChange(event.target.value)}
            className="tabular h-11 w-full border bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
            style={{ borderColor: shown ? 'var(--color-state-blocked)' : 'var(--color-line)' }}
          />
        </div>
        {action}
      </div>
      {note && (
        <p id={`${id}-note`} className="tabular break-all text-note" style={{ color: shown ? 'var(--color-state-blocked)' : 'var(--color-muted)' }}>
          {note}
        </p>
      )}
      {hint && !note && <p className="text-note text-[color:var(--color-muted)]">{hint}</p>}
    </div>
  );
}
