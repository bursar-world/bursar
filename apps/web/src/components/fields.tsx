'use client';

import { useId } from 'react';
import type { ReactNode } from 'react';

/**
 * A labelled text input and a labelled select, for a form whose values are not amounts.
 *
 * `AmountInput` owns money, where the decimal separator and the asset matter. Everything else a
 * governance form asks for is a duration in seconds, a count, a basis-point share, an address or a
 * 32-byte word, and each of those wants the same three things on screen: what it is, what it means
 * once it is on chain, and what is wrong with what was typed.
 */

const CONTROL =
  'h-11 w-full bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)] disabled:opacity-50';

export type TextFieldProps = {
  readonly label: ReactNode;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** What the value means once it is on chain. Replaced by `problem` when there is one. */
  readonly help?: ReactNode;
  readonly problem?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** Shown inside the control, after the input. A unit, usually. */
  readonly suffix?: string;
  readonly mono?: boolean;
};

export function TextField({ label, value, onChange, help, problem, placeholder, disabled = false, suffix, mono = false }: TextFieldProps) {
  const id = useId();
  const bad = problem !== undefined && problem !== '';

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
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={bad}
          aria-describedby={bad || help ? `${id}-note` : undefined}
          onChange={(event) => onChange(event.target.value)}
          className={`${CONTROL} bg-transparent ${mono ? 'font-mono' : 'tabular'}`}
        />
        {suffix && <span className="px-3 font-mono text-label uppercase tracking-wide text-[color:var(--color-muted)]">{suffix}</span>}
      </div>
      {(bad || help) && (
        <p id={`${id}-note`} className="text-note" style={{ color: bad ? 'var(--color-state-blocked)' : 'var(--color-muted)' }}>
          {bad ? problem : help}
        </p>
      )}
    </div>
  );
}

export type SelectOption = { readonly value: string; readonly label: string; readonly group?: string };

export type SelectFieldProps = {
  readonly label: ReactNode;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly help?: ReactNode;
  readonly disabled?: boolean;
};

export function SelectField({ label, value, options, onChange, help, disabled = false }: SelectFieldProps) {
  const id = useId();
  const groups = [...new Set(options.map((option) => option.group ?? ''))];

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={`${CONTROL} border border-[color:var(--color-line)]`}
      >
        {groups.map((group) =>
          group === '' ? (
            options
              .filter((option) => (option.group ?? '') === '')
              .map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))
          ) : (
            <optgroup key={group} label={group}>
              {options
                .filter((option) => option.group === group)
                .map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
            </optgroup>
          ),
        )}
      </select>
      {help && <p className="text-note text-[color:var(--color-muted)]">{help}</p>}
    </div>
  );
}
