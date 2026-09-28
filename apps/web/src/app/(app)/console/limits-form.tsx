'use client';

import { MICRO_DECIMALS, formatMicro, isTotalBudgetWindow, totalBudgetWindowSeconds } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { MandateLimits } from '@bursar/sdk';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { AmountInput } from '@/components/amount-input';
import { Field, FieldGrid } from '@/components/layout';
import { DAY_SECONDS, MONTH_SECONDS, checkLimits } from '@/chain/limits';
import type { LimitsForm, LimitsProblem } from '@/chain/limits';
import { parseUsdgInput, usd } from '@/money';
import { APPROVE_EVERYTHING, APPROVE_NOTHING, approvalModeOf } from './lib/format';
import type { ApprovalMode } from './lib/format';

/**
 * The limit set as a person fills it in.
 *
 * Text and numbers are kept apart: the draft holds exactly what was typed so nothing reformats
 * under the cursor, and `readDraft` is the single place that turns it into the struct the contract
 * takes. Every field is required. A limit left blank would deploy as zero, and a mandate with a
 * zero per-payment cap refuses its agent's first call and reads as an outage.
 */

export type LimitsDraft = {
  readonly perCall: string;
  /** The period cap. Held in the account's first window. */
  readonly daily: string;
  /** The total budget, or the second rolling cap when `longWindow` is a period. */
  readonly monthly: string;
  /** The period the cap refills over, in seconds. */
  readonly shortWindow: number;
  /** `NEVER_REFILLS` for a total budget; otherwise the second window's period in seconds. */
  readonly longWindow: number;
  readonly approvalMode: ApprovalMode;
  readonly approvalAmount: string;
  /** ISO date, or empty for no expiry. */
  readonly validUntil: string;
  /** Carried through a limit change untouched. Zero means the mandate is open already. */
  readonly validFrom: number;
};

/**
 * The second window as a total budget: it never refills.
 *
 * The account has no lifetime field, so the total is its second window given a period it can never
 * outlive (`totalBudgetWindowSeconds`). The draft holds this marker instead of that number, because
 * the number depends on the expiry and the draft should not change when the expiry does.
 */
export const NEVER_REFILLS = 0;

export const EMPTY_DRAFT: LimitsDraft = {
  perCall: '',
  daily: '',
  monthly: '',
  shortWindow: DAY_SECONDS,
  longWindow: NEVER_REFILLS,
  approvalMode: 'above',
  approvalAmount: '',
  validUntil: '',
  validFrom: 0,
};

const SHORT_WINDOWS: readonly { readonly seconds: number; readonly label: string }[] = [
  { seconds: 3_600, label: '1 hour' },
  { seconds: 8 * 3_600, label: '8 hours' },
  { seconds: DAY_SECONDS, label: '1 day' },
  { seconds: 7 * DAY_SECONDS, label: '7 days' },
  { seconds: MONTH_SECONDS, label: '30 days' },
];

/**
 * A total budget first. The rolling choices stay for mandates created with a second rolling cap,
 * so editing one of those does not quietly turn its cap into a lifetime total.
 */
const LONG_WINDOWS: readonly { readonly seconds: number; readonly label: string }[] = [
  { seconds: NEVER_REFILLS, label: 'Never. It is a total budget' },
  { seconds: 7 * DAY_SECONDS, label: 'Every 7 days' },
  { seconds: MONTH_SECONDS, label: 'Every 30 days' },
  { seconds: 90 * DAY_SECONDS, label: 'Every 90 days' },
  { seconds: 365 * DAY_SECONDS, label: 'Every 365 days' },
];

/** Whether this draft's second window is the total budget. */
export function isTotalDraft(draft: LimitsDraft): boolean {
  return draft.longWindow === NEVER_REFILLS;
}

/**
 * The draft as a limit set, or the reasons it is not one yet.
 *
 * `limits` is present only when `problems` is empty. The two used to be worked out from different
 * conditions: a per-payment cap of 50 against a daily cap of 10 produced the warning that a daily
 * limit has to be at least the per-payment limit, and a `limits` struct all the same, so the form
 * showed the contradiction and left Create pressable over a mandate the contract refuses.
 */
export type DraftReading = {
  readonly limits: LimitsForm | undefined;
  readonly problems: readonly LimitsProblem[];
};

export function readDraft(draft: LimitsDraft, now: number = Date.now()): DraftReading {
  const problems: LimitsProblem[] = [];
  const total = isTotalDraft(draft);

  const perCall = readAmount(draft.perCall, 'Set the most this agent may spend on one payment.');
  const daily = readAmount(draft.daily, 'Set the most this agent may spend in each period.');
  const monthly = readAmount(
    draft.monthly,
    total ? 'Set the total budget: the most this agent may spend over the life of the mandate.' : 'Set the second cap.',
  );
  const threshold = thresholdOf(draft);

  if (perCall.problem) problems.push({ field: 'perCallCap', problem: perCall.problem });
  if (daily.problem) problems.push({ field: 'dailyCap', problem: daily.problem });
  if (monthly.problem) problems.push({ field: 'monthlyCap', problem: monthly.problem });
  if (threshold.problem) problems.push({ field: 'approvalThreshold', problem: threshold.problem });

  const validUntil = draft.validUntil === '' ? 0 : Math.floor(endOfDay(draft.validUntil) / 1000);
  if (draft.validUntil !== '' && !Number.isFinite(validUntil)) {
    problems.push({ field: 'validUntil', problem: 'That is not a date the mandate can expire on.' });
  } else if (validUntil !== 0 && validUntil * 1000 < now) {
    // The contract only compares the expiry against the start date, so a date in the past is
    // accepted and produces a mandate that refuses its agent's first call.
    problems.push({ field: 'validUntil', problem: 'That date has passed, so the mandate would refuse every payment.' });
  }

  if (perCall.value === undefined || daily.value === undefined || monthly.value === undefined || threshold.value === undefined) {
    return { limits: undefined, problems };
  }

  const expiry = Number.isFinite(validUntil) ? validUntil : 0;
  const limits: LimitsForm = {
    perCallCap: perCall.value,
    dailyCap: daily.value,
    monthlyCap: monthly.value,
    dailyWindow: draft.shortWindow,
    monthlyWindow: total ? Number(totalBudgetWindowSeconds(expiry, Math.floor(now / 1000))) : draft.longWindow,
    approvalThreshold: threshold.value,
    validFrom: draft.validFrom,
    validUntil: expiry,
  };

  const refused = [...problems, ...checkLimits(limits)];
  return refused.length > 0 ? { limits: undefined, problems: refused } : { limits, problems: [] };
}

export function draftFromLimits(limits: MandateLimits): LimitsDraft {
  const mode = approvalModeOf(limits.approvalThreshold, limits.perCallCap);

  return {
    perCall: plain(limits.perCallCap),
    daily: plain(limits.dailyCap),
    monthly: plain(limits.monthlyCap),
    shortWindow: Number(limits.dailyWindow),
    longWindow: isTotalBudgetWindow(limits.monthlyWindow) ? NEVER_REFILLS : Number(limits.monthlyWindow),
    approvalMode: mode,
    approvalAmount: mode === 'above' ? plain(limits.approvalThreshold) : '',
    validUntil: limits.validUntil === 0n ? '' : isoDate(Number(limits.validUntil) * 1000),
    validFrom: Number(limits.validFrom),
  };
}

export function problemFor(problems: readonly LimitsProblem[], field: keyof LimitsForm): string | undefined {
  return problems.find((problem) => problem.field === field)?.problem;
}

export function LimitsFields({
  draft,
  onChange,
  problems,
  disabled = false,
}: {
  readonly draft: LimitsDraft;
  readonly onChange: (next: LimitsDraft) => void;
  readonly problems: readonly LimitsProblem[];
  readonly disabled?: boolean;
}) {
  const set = <K extends keyof LimitsDraft>(key: K, value: LimitsDraft[K]) => onChange({ ...draft, [key]: value });
  const perCallCap = amountOf(draft.perCall);
  const approvalAmount = amountOf(draft.approvalAmount);

  const total = isTotalDraft(draft);

  return (
    <div className="space-y-5">
      <FieldGrid columns={3}>
        <AmountInput
          label="Most per payment"
          asset="USDG"
          value={draft.perCall}
          disabled={disabled}
          onChange={(text) => set('perCall', text)}
          problem={problemFor(problems, 'perCallCap')}
          hint="A single payment above this is refused by the contract."
        />
        <AmountInput
          label="Period cap"
          asset="USDG"
          value={draft.daily}
          disabled={disabled}
          onChange={(text) => set('daily', text)}
          problem={problemFor(problems, 'dailyCap')}
          hint="The most the agent may spend in each period. It refills when the period rolls."
        />
        <AmountInput
          label={total ? 'Total budget' : 'Second cap'}
          asset="USDG"
          value={draft.monthly}
          disabled={disabled}
          onChange={(text) => set('monthly', text)}
          problem={problemFor(problems, 'monthlyCap')}
          hint={
            total
              ? 'The most the agent may spend over the life of the mandate. It never refills; you can raise it.'
              : 'A second rolling cap. Both bind at once, so the tighter one is what the agent feels.'
          }
        />
      </FieldGrid>

      <FieldGrid columns={3}>
        <Select
          label="Period"
          value={String(draft.shortWindow)}
          disabled={disabled}
          onChange={(value) => set('shortWindow', Number(value))}
          options={SHORT_WINDOWS.map((entry) => ({ value: String(entry.seconds), label: entry.label }))}
          problem={problemFor(problems, 'dailyWindow')}
        />
        <Select
          label={total ? 'Total budget refills' : 'Second cap refills'}
          value={String(draft.longWindow)}
          disabled={disabled}
          onChange={(value) => set('longWindow', Number(value))}
          options={LONG_WINDOWS.map((entry) => ({ value: String(entry.seconds), label: entry.label }))}
          problem={problemFor(problems, 'monthlyWindow')}
        />
        <DateField
          label="Valid until"
          value={draft.validUntil}
          disabled={disabled}
          onChange={(value) => set('validUntil', value)}
          hint="Leave empty for no expiry. After this date the mandate refuses every payment."
          problem={problemFor(problems, 'validUntil')}
        />
      </FieldGrid>

      <div className="space-y-3">
        <Field label="Payments you approve yourself" hint="Approval is asked for at and above the amount you set.">
          <div className="space-y-2">
            <Choice
              name="approval"
              checked={draft.approvalMode === 'above'}
              disabled={disabled}
              onSelect={() => set('approvalMode', 'above')}
              label="From an amount I set"
              detail="Below it the agent pays on its own. At or above it the payment waits for your signature."
            />
            {draft.approvalMode === 'above' && (
              <div className="pl-6">
                <AmountInput
                  label="Approve from"
                  asset="USDG"
                  value={draft.approvalAmount}
                  disabled={disabled}
                  onChange={(text) => set('approvalAmount', text)}
                  problem={problemFor(problems, 'approvalThreshold')}
                  hint={
                    perCallCap !== undefined && approvalAmount !== undefined && approvalAmount > perCallCap
                      ? `Above the ${usd(perCallCap)} per-payment limit, so in practice nothing would need approval.`
                      : undefined
                  }
                />
              </div>
            )}
            <Choice
              name="approval"
              checked={draft.approvalMode === 'every'}
              disabled={disabled}
              onSelect={() => set('approvalMode', 'every')}
              label="Every payment"
              detail="The agent can start work and can settle nothing without you."
            />
            <Choice
              name="approval"
              checked={draft.approvalMode === 'never'}
              disabled={disabled}
              onSelect={() => set('approvalMode', 'never')}
              label="None of them"
              detail="The limits above are the only thing standing between the agent and a payment."
            />
          </div>
        </Field>
      </div>
    </div>
  );
}

/**
 * The threshold binds at and above, so turning approvals off is the largest value the field holds
 * and turning them on for everything is the smallest. Zero is refused by the contract, which is why
 * neither end of this is ever left to a default.
 *
 * A typed threshold above the per-payment cap is kept exactly as typed, so the mandate reads back
 * as the number its owner chose. The field tells them what it will mean.
 */
function thresholdOf(draft: LimitsDraft): AmountReading {
  if (draft.approvalMode === 'every') return { value: APPROVE_EVERYTHING, problem: undefined };
  if (draft.approvalMode === 'never') return { value: APPROVE_NOTHING, problem: undefined };
  return readAmount(draft.approvalAmount, 'Set the amount from which you want to approve payments yourself.');
}

type AmountReading = { readonly value: Micro | undefined; readonly problem: string | undefined };

/**
 * One typed amount, and the reason it cannot be spent against.
 *
 * An empty field is not a mistake yet, so it gets the instruction. Anything else that does not read
 * as a positive amount is a mistake, and the field says which one: the parser already distinguishes
 * letters from too much precision from a negative, and every one of those used to arrive as the
 * same neutral "set the most this agent may spend", in the slot where a valid amount shows
 * "Reads as $10.00". A treasurer typing 1.2345678 got a dead button and no reason.
 */
function readAmount(text: string, whenEmpty: string): AmountReading {
  if (text.trim() === '') return { value: undefined, problem: whenEmpty };

  const parsed = parseUsdgInput(text);
  if (!parsed.ok) return { value: undefined, problem: parsed.problem };
  if (parsed.value <= 0n) return { value: undefined, problem: 'Enter a positive amount.' };

  return { value: parsed.value, problem: undefined };
}

/** The same reading the amount field echoes back, so the form and the field never disagree. */
function amountOf(text: string): Micro | undefined {
  return readAmount(text, '').value;
}

function plain(value: Micro): string {
  return formatMicro(value, { minDecimals: 0, maxDecimals: MICRO_DECIMALS });
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A mandate that expires on a date is good for the whole of it, in the reader's own zone. */
function endOfDay(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return Number.NaN;
  return new Date(year, month - 1, day, 23, 59, 59).getTime();
}

function Select({
  label,
  value,
  options,
  onChange,
  problem,
  disabled = false,
}: {
  readonly label: ReactNode;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
  readonly problem?: string;
  readonly disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 w-full border bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
        style={{ borderColor: problem ? 'var(--color-state-blocked)' : 'var(--color-line)' }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {problem && (
        <p className="text-note" style={{ color: 'var(--color-state-blocked)' }}>
          {problem}
        </p>
      )}
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
  hint,
  problem,
  disabled = false,
}: {
  readonly label: ReactNode;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly problem?: string;
  readonly disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
        {label}
      </label>
      <input
        id={id}
        type="date"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="tabular h-11 w-full border bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
        style={{ borderColor: problem ? 'var(--color-state-blocked)' : 'var(--color-line)' }}
      />
      {problem ? (
        <p className="text-note" style={{ color: 'var(--color-state-blocked)' }}>
          {problem}
        </p>
      ) : (
        hint && <p className="text-note text-[color:var(--color-muted)]">{hint}</p>
      )}
    </div>
  );
}

function Choice({
  name,
  checked,
  onSelect,
  label,
  detail,
  disabled = false,
}: {
  readonly name: string;
  readonly checked: boolean;
  readonly onSelect: () => void;
  readonly label: string;
  readonly detail: string;
  readonly disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex gap-2">
      <input id={id} type="radio" name={name} checked={checked} disabled={disabled} onChange={onSelect} className="mt-1" />
      <label htmlFor={id} className="text-detail">
        <span className="font-medium">{label}</span>
        <span className="block text-[color:var(--color-muted)]">{detail}</span>
      </label>
    </div>
  );
}
