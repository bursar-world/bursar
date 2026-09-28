import {
  RefuseReason,
  SPEND_CLASS_INFO,
  SPEND_CLASSES,
  capabilityId,
  classLabel,
  evaluateDocument,
  micro,
  parseRule,
  spendHistory,
} from '@bursar/core';
import type { Decision, MandateDocument, Micro, SpendClass, SpendRequest } from '@bursar/core';
import { getAddress, isAddress } from 'viem';

import { isTotalDraft, readDraft } from '@/app/(app)/console/limits-form';
import { parseUsdgInput, usd } from '@/money';
import type { MandateDraft } from './model';

/**
 * The pre-activation rule check: a spend the agent might ask for, run against a saved draft.
 *
 * It runs the same evaluator the underwriter decides live spends with, on a document built from
 * the draft. Nothing is deployed and nothing is sent, so a result here is a reading of the draft's
 * rules, not a transaction and not a proof.
 */

export type PlannedSpend = {
  readonly spendClass: SpendClass;
  /** Without its class namespace, as the draft lists it. */
  readonly capability: string;
  readonly payee: string;
  readonly amount: string;
  /** ISO date the spend would be made on. */
  readonly date: string;
  /** Already spent in the period this spend falls in. */
  readonly spentThisPeriod: string;
  /** Already spent over the life of the mandate, this period included. */
  readonly spentInTotal: string;
};

/** The rules a draft holds, by the names the create form gives them. */
export type RuleName =
  | 'Per-payment limit'
  | 'Period cap'
  | 'Second cap'
  | 'Total budget'
  | 'Spend class'
  | 'Capability'
  | 'Counterparty'
  | 'Expiry'
  | 'Amount'
  | 'Approval';

export type RuleCheckResult =
  | { readonly outcome: 'incomplete'; readonly problems: readonly string[] }
  | { readonly outcome: 'allowed'; readonly message: string }
  | { readonly outcome: 'approval'; readonly rule: 'Approval'; readonly message: string }
  | { readonly outcome: 'refused'; readonly rule: RuleName; readonly message: string };

/** The last representable instant. A draft with no expiry never expires. */
const NO_EXPIRY = '9999-12-31T23:59:59.000Z';

/** uint128, the widest amount the account stores. Used as "no ceiling" for a rolling second cap. */
const NO_CEILING = micro((1n << 128n) - 1n);

export const EMPTY_SPEND: PlannedSpend = {
  spendClass: 'service',
  capability: '',
  payee: '',
  amount: '',
  date: '',
  spentThisPeriod: '',
  spentInTotal: '',
};

export function checkDraftSpend(draft: MandateDraft, spend: PlannedSpend, now: number = Date.now()): RuleCheckResult {
  const problems: string[] = [];
  const reading = readDraft(draft.limits, now);
  if (reading.limits === undefined) {
    problems.push(...reading.problems.map((problem) => `Draft: ${problem.problem}`));
  }

  const amount = readMoney(spend.amount, 'the amount', problems, true);
  const spentThisPeriod = readMoney(spend.spentThisPeriod, 'already spent this period', problems, false);
  const spentInTotal = readMoney(spend.spentInTotal, 'already spent in total', problems, false);

  const label = spend.capability.trim();
  if (label === '') problems.push('Name the capability the spend is for, such as gpu.render:1.');
  let action = '';
  if (label !== '') {
    try {
      action = classLabel(spend.spendClass, label);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  const payee = spend.payee.trim();
  if (!isAddress(payee, { strict: false })) problems.push('Enter the counterparty as a 0x address.');

  const atMs = spend.date === '' ? now : Date.parse(`${spend.date}T12:00:00`);
  if (Number.isNaN(atMs)) problems.push('That is not a date.');

  if (problems.length > 0 || reading.limits === undefined || amount === undefined || action === '') {
    return { outcome: 'incomplete', problems };
  }

  const limits = reading.limits;
  const total = isTotalDraft(draft.limits);
  const at = new Date(atMs).toISOString();
  const allowedClasses = SPEND_CLASSES.filter((id) => draft.classes[id] && SPEND_CLASS_INFO[id].available);
  const payees = draft.payees.filter((entry) => isAddress(entry, { strict: false })).map((entry) => getAddress(entry));

  const document: MandateDocument = {
    subject: draft.id,
    account: null,
    chainId: null,
    version: null,
    validFrom: null,
    expiresAt: limits.validUntil ? new Date(limits.validUntil * 1000).toISOString() : NO_EXPIRY,
    rules: allowedClasses.map((id) => parseRule(`${SPEND_CLASS_INFO[id].prefix}*`, 'allow')),
    ceilingMicros: total ? limits.monthlyCap : NO_CEILING,
    perCallCapMicros: limits.perCallCap,
    approvalThresholdMicros: limits.approvalThreshold,
    daily: { limitMicros: limits.dailyCap, seconds: limits.dailyWindow },
    monthly: total ? null : { limitMicros: limits.monthlyCap, seconds: limits.monthlyWindow },
    windowAnchor: at,
    merchantGate: { kind: 'allowlist', merchants: payees },
    capabilities: draft.capabilities
      .filter((entry) => allowedClasses.includes(entry.spendClass))
      .map((entry) => capabilityId(classLabel(entry.spendClass, entry.label))),
  };

  const period = spentThisPeriod ?? micro(0n);
  const lifetime = spentInTotal === undefined || spentInTotal < period ? period : spentInTotal;
  const history = spendHistory([
    { amountMicros: period, atMs },
    { amountMicros: micro(lifetime - period), atMs: Number.NEGATIVE_INFINITY },
  ]);

  const request: SpendRequest = {
    requestId: 'rule-check',
    subject: draft.id,
    action,
    amountMicros: amount,
    at,
    merchant: getAddress(payee),
    capabilityId: capabilityId(action),
  };

  return explain(evaluateDocument(document, history, request), { draft, spend, action, amount, period, lifetime, limits });
}

type Context = {
  readonly draft: MandateDraft;
  readonly spend: PlannedSpend;
  readonly action: string;
  readonly amount: Micro;
  readonly period: Micro;
  readonly lifetime: Micro;
  readonly limits: NonNullable<ReturnType<typeof readDraft>['limits']>;
};

function explain(decision: Decision, c: Context): RuleCheckResult {
  if (decision.decision === 'allow') {
    return { outcome: 'allowed', message: `${usd(c.amount)} for ${c.action} passes every rule in this draft.` };
  }
  if (decision.decision === 'hold') {
    return {
      outcome: 'approval',
      rule: 'Approval',
      message: `${usd(c.amount)} is at or above the ${usd(c.limits.approvalThreshold)} approval amount, so it would wait for your signature.`,
    };
  }

  const refused = (rule: RuleName, message: string): RuleCheckResult => ({ outcome: 'refused', rule, message });
  const info = SPEND_CLASS_INFO[c.spend.spendClass];

  switch (decision.reason) {
    case RefuseReason.Expired:
      return refused('Expiry', 'The spend falls after the draft expires, so it would be refused.');
    case RefuseReason.OutsideMandate:
      return info.available
        ? refused('Spend class', `${info.name} are not allowed by this draft.`)
        : refused('Spend class', `${info.name} are not available yet, so no mandate can allow them.`);
    case RefuseReason.MerchantNotAllowed:
      return refused(
        'Counterparty',
        c.draft.payees.length === 0 ? 'This draft allows no counterparty yet.' : 'This counterparty is not on the draft’s list.',
      );
    case RefuseReason.CapabilityNotAllowed:
      return refused('Capability', `${c.action} is not one of the capabilities this draft allows.`);
    case RefuseReason.OverPerCallCap:
      return refused('Per-payment limit', `${usd(c.amount)} is above the ${usd(c.limits.perCallCap)} limit on one payment.`);
    case RefuseReason.DailyCapExceeded:
      return refused(
        'Period cap',
        `${usd(remaining(c.limits.dailyCap, c.period))} of the ${usd(c.limits.dailyCap)} period cap is left, and the spend asks for ${usd(c.amount)}.`,
      );
    case RefuseReason.MonthlyCapExceeded:
      return refused('Second cap', `The second cap of ${usd(c.limits.monthlyCap)} has no room for ${usd(c.amount)}.`);
    case RefuseReason.OverCumulativeCeiling:
      return refused(
        'Total budget',
        `${usd(remaining(c.limits.monthlyCap, c.lifetime))} of the ${usd(c.limits.monthlyCap)} total budget is left, and the spend asks for ${usd(c.amount)}.`,
      );
    case RefuseReason.ZeroAmount:
      return refused('Amount', 'A spend of nothing is refused.');
    default:
      return refused('Amount', `Refused: ${decision.reason}.`);
  }
}

function remaining(cap: Micro, spent: Micro): Micro {
  return micro(cap > spent ? cap - spent : 0n);
}

function readMoney(text: string, name: string, problems: string[], required: boolean): Micro | undefined {
  if (text.trim() === '') {
    if (required) problems.push(`Enter ${name}.`);
    return required ? undefined : micro(0n);
  }
  const parsed = parseUsdgInput(text);
  if (!parsed.ok) {
    problems.push(`${name[0]!.toUpperCase()}${name.slice(1)}: ${parsed.problem}`);
    return undefined;
  }
  return parsed.value;
}
