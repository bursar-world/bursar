'use client';

import type { Micro } from '@bursar/core';
import { issuerRefusal } from '@bursar/sdk';
import type { DenialReason, Refusal } from '@bursar/sdk';
import type { ReactNode } from 'react';

import type { Wei } from '../money';

import { shortAddress } from '../chain/rhc';
import { isUserRejection } from '../lib/revert';
import { formatEth, usd } from '../money';
import { Instant } from './instant';
import { Address, TxHash } from './address';

/**
 * Renders the failure the system reported.
 *
 * Every error the SDK and the core package raise carries a stable `code`, and the ones that come
 * from a mandate already name which limit stopped the spend and when it frees up. The branch is
 * on `code`, never on the class. A workspace resolving two copies of a package is ordinary, and an
 * `instanceof` check against the wrong copy falls silently through to a generic message written
 * for nobody.
 */
export type MandateShapedError = {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly name?: unknown;
  readonly details?: Record<string, unknown>;
  readonly reason?: unknown;
  readonly resetsAt?: unknown;
  /** What the mandate held when it refused, when whoever raised the error had it to hand. */
  readonly snapshot?: unknown;
  readonly mandate?: unknown;
  readonly merchant?: unknown;
  readonly amount?: unknown;
  readonly account?: unknown;
  readonly balance?: unknown;
  /** The signer's ETH at the time of the failure. A fee is never quoted in the settlement asset. */
  readonly balanceWei?: unknown;
  readonly required?: unknown;
  readonly sender?: unknown;
  readonly hash?: unknown;
  readonly errorName?: unknown;
  readonly field?: unknown;
};

export type ErrorSurfaceProps = {
  readonly error: unknown;
  /** What the reader was trying to do, so the heading reads as a sentence about their action. */
  readonly action?: string;
  /** Replaces that sentence where the failure is not an action at all, such as a page that threw. */
  readonly heading?: string;
  readonly onRetry?: () => void;
  /** Says what pressing it does. "Try again" is wrong for a transaction that may still confirm. */
  readonly retryLabel?: string;
  readonly children?: ReactNode;
};

export function ErrorSurface({ error, action, heading, onRetry, retryLabel = 'Try again', children }: ErrorSurfaceProps) {
  if (error === null || error === undefined) return null;

  const shaped = error as MandateShapedError;
  const code = typeof shaped.code === 'string' ? shaped.code : undefined;
  const title = headingFor(code, shaped, action, heading);
  const message = messageFor(code, shaped, error);

  return (
    <div role="alert" className="border border-l-2 border-[color:var(--color-line)] border-l-[color:var(--color-state-blocked)] bg-surface px-5 py-4">
      <p className="text-sm font-medium" style={{ color: 'var(--color-state-blocked)' }}>
        {title}
      </p>
      <p className="mt-1 text-detail text-[color:var(--color-ink)]">{message}</p>
      <ErrorFacts code={code} error={shaped} />
      {children}
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-3 font-mono text-label uppercase tracking-wide underline underline-offset-4">
          {retryLabel}
        </button>
      )}
    </div>
  );
}

/**
 * viem appends the request it made to every error it raises: the contract address, the encoded
 * calldata, the gas fields. That is the right thing in a log and the wrong thing on a screen, so
 * the sentence is kept and the dump is dropped.
 */
function readable(message: string): string {
  const cut = message.search(/\n\s*(Raw Call Arguments|Request Arguments|Contract Call|Details|Docs|Version):/);
  const trimmed = (cut === -1 ? message : message.slice(0, cut)).trim();
  return trimmed === '' ? message.trim() : trimmed;
}

/**
 * The mandate writes its refusal for a developer reading a stack trace: the account address in
 * full, and the contract call to make next. The person looking at this card is the one who has to
 * fix it, so the figures are kept and the vocabulary is theirs.
 */
function messageFor(code: string | undefined, error: MandateShapedError, raw: unknown): string {
  if (code === 'mandate_denied') {
    const sentence = denialSentence(error);
    if (sentence) return sentence;
  }

  if (code === 'x402_rejected') {
    const refusal = issuerRefusalOf(error);
    if (refusal) return refusal.message;
  }

  if (code === 'receipt_timeout') {
    return 'The network took the transaction and no receipt has arrived in the time this screen waits. It may still confirm. Check it on the explorer before sending it a second time.';
  }

  return readable(typeof error.message === 'string' ? error.message : String(raw));
}

function headingFor(
  code: string | undefined,
  error: MandateShapedError,
  action: string | undefined,
  heading: string | undefined,
): string {
  const subject = heading ?? (action ? `${action} did not go through` : 'That did not go through');

  if (isUserRejection(error)) return 'You cancelled the signature';

  switch (code) {
    case 'mandate_denied':
      return `The mandate refused this payment: ${denialHeadline(denialReason(error))}`;
    case 'insufficient_funds':
      return 'The mandate account is not funded for this payment';
    case 'gas_failure':
      return 'The signer could not pay the transaction fee in ETH';
    case 'call_refused':
    case 'contract_reverted':
      return `${subject}: a contract refused it`;
    case 'transaction_reverted':
      return 'The transaction reached the chain and failed';
    case 'receipt_timeout':
      return 'The transaction was sent and has not confirmed yet';
    case 'event_missing':
      return 'The transaction succeeded and the receipt came back incomplete';
    case 'argument_invalid':
      return 'Check what was entered';
    case 'money_invalid':
      return 'That amount is not valid';
    case 'rpc_all_providers_down':
    case 'chain_unreadable':
      return 'The chain is not reachable';
    // Nothing was sent. Both endpoints failed a moment ago and this app stopped asking for a few
    // seconds, which is a state it holds itself and clears itself. Reported as the chain being
    // unreachable, it sends a reader to check a network that was never contacted.
    case 'rpc_all_providers_cooling':
      return 'This app has paused its own requests to the chain';
    case 'rpc_rate_limited':
      return 'The network endpoint is busy';
    case 'rpc_error':
    case 'rpc_http_error':
    case 'rpc_bad_body':
      return 'The network endpoint answered with an error';
    // Six ways to have no history, with different owners. A browser refusing a response nobody gave
    // it permission to read is not the index refusing a request, an index charging for the answer is
    // neither, and the fixes are nothing alike.
    case 'index_rate_limited':
      return 'The network index is metering this deployment';
    case 'index_blocked':
      return 'This browser blocked the network index';
    case 'index_refused':
      return 'The network index refused the request';
    case 'index_unkeyed':
      return 'This deployment has no key for the network index';
    case 'index_unreachable':
      return 'The network index did not answer';
    case 'index_timeout':
      return 'The network index is taking too long';
    case 'index_malformed':
      return 'The network index answered with something else';
    case 'deployment_invalid':
    case 'deployment_unknown':
      return 'This deployment is not configured correctly';
    case 'no_signer':
      return 'Connect a wallet first';
    case 'x402_rejected':
      return issuerHeadline(issuerRefusalOf(error), subject);
    default:
      return subject;
  }
}

function denialHeadline(reason: DenialReason | undefined): string {
  switch (reason) {
    case 'daily-cap':
      return 'this period’s cap is spent';
    case 'monthly-cap':
      return 'the second cap is spent';
    case 'total-budget':
      return 'the total budget is spent';
    case 'per-call-cap':
      return 'it is over the per-payment limit';
    case 'approval-required':
      return 'it needs the account owner’s signature';
    case 'merchant-not-allowed':
      return 'the merchant is not on the allowlist';
    case 'capability-not-allowed':
      return 'this kind of work is not allowed';
    case 'paused':
      return 'spending is paused';
    case 'revoked':
      return 'the agent was revoked';
    case 'expired':
      return 'the mandate has expired';
    case 'not-yet-valid':
      return 'the mandate has not opened yet';
    default:
      return 'the limits do not allow it';
  }
}

/**
 * A paid service refused, and the question is whose refusal it was.
 *
 * The underwriter and the facilitator read USDG's own controls before anything is signed and
 * refuse with one of five words when the token is what said no. Those five are the only refusals
 * nobody on this screen can clear, so they are named as the issuer's rather than folded into a
 * service being unavailable. Every other reason keeps the service's own wording.
 */
function issuerRefusalOf(error: MandateShapedError): Refusal | null {
  return typeof error.reason === 'string' ? issuerRefusal(error.reason) : null;
}

function issuerHeadline(refusal: Refusal | null, subject: string): string {
  if (refusal === null) return `${subject}: the service refused the payment`;

  // `deployment` is the token routing no code for one of its own compliance calls. Nobody refused;
  // nobody could establish that anyone had agreed, which refuses by default.
  return refusal.owner === 'deployment'
    ? 'The settlement asset could not be read, so the payment was refused'
    : 'The token issuer refused this payment';
}

function denialReason(error: MandateShapedError): DenialReason | undefined {
  return typeof error.reason === 'string' ? (error.reason as DenialReason) : undefined;
}

/**
 * What stopped the payment, what is left, and who lifts it. The figures come from the reading the
 * mandate had when it refused, so a reader is never told a window is spent without being told how
 * much it holds or when it rolls.
 */
function denialSentence(error: MandateShapedError): string | undefined {
  const snapshot = snapshotOf(error.snapshot);
  const asked = typeof error.amount === 'bigint' ? ` This payment asks for ${usd(error.amount as Micro)}.` : '';

  switch (denialReason(error)) {
    case 'daily-cap':
      return snapshot
        ? `${usd(snapshot.remaining.daily)} of the ${usd(snapshot.daily.cap)} period cap is left.${asked} The cap refills when the period rolls, and until then only the account owner can raise it.`
        : `The period cap is spent.${asked} It refills when the period rolls.`;
    case 'monthly-cap':
      return snapshot
        ? `${usd(snapshot.remaining.monthly)} of the ${usd(snapshot.monthly.cap)} second cap is left.${asked} The allowance returns when its window rolls, and until then only the account owner can raise it.`
        : `The second cap is spent.${asked} The allowance returns when its window rolls.`;
    case 'total-budget':
      return snapshot
        ? `${usd(snapshot.remaining.monthly)} of the ${usd(snapshot.monthly.cap)} total budget is left.${asked} The total never refills; only the account owner can raise it.`
        : `The total budget is spent.${asked} It never refills; only the account owner can raise it.`;
    case 'per-call-cap':
      return snapshot
        ? `One payment can be at most ${usd(snapshot.limits.perCallCap)} here.${asked} Split the work, or ask the account owner to raise the per-payment limit.`
        : `It is over the limit on a single payment.${asked} Split the work, or ask the account owner to raise that limit.`;
    case 'approval-required':
      return snapshot
        ? `Payments of ${usd(snapshot.limits.approvalThreshold)} and above need the account owner to approve them.${asked} Ask for consent, then send the payment with it.`
        : `This payment is at or above the approval threshold and carries no consent.${asked} Ask the account owner for it, then send the payment again.`;
    case 'approval-mismatch':
      return 'The consent names a different payee, capability or ceiling than this payment. It covers one payment exactly as it was signed.';
    case 'approval-expired':
      return 'The consent passed its expiry before it was used. The account owner signs a new one.';
    case 'approval-spent':
      return 'That consent covered one payment and has already been used. Each approval is good once.';
    case 'bad-signature':
      return 'The consent did not recover to the account owner. A signature made for a different account or a different network reads exactly like this.';
    case 'merchant-not-allowed':
      return 'This mandate pays only the addresses its owner has allowed, and this payee is not one of them. The account owner adds it.';
    case 'capability-not-allowed':
      return 'The work being bought is outside what this mandate covers. The account owner decides what it covers.';
    case 'merchant-proof-required':
      return 'This mandate reads its payee list from a published root, so a payment has to carry a proof for the payee it names.';
    case 'merchant-proof-invalid':
      return 'The proof sent with the payment does not belong to the payee list this mandate reads.';
    case 'merchant-proof-unexpected':
      return 'This mandate keeps its own payee list, so a proof against a published root is never consulted. Send the payment without one.';
    case 'paused':
      return 'The account owner paused this mandate. It refuses every payment until the owner resumes it.';
    case 'revoked':
      return 'This mandate has no agent seated, so nothing can spend from it. The account owner seats one again.';
    case 'expired':
      return 'The mandate passed its valid-until date. Only the account owner can extend it.';
    case 'not-yet-valid':
      return 'The mandate has not opened yet. It starts on the date written into its limits.';
    case 'not-agent':
      return 'Only the address seated as the agent can spend from this mandate.';
    case 'zero-amount':
      return 'The amount is zero. A payment of nothing is refused before anything else is read.';
    case 'zero-address':
      return 'The payee address is empty.';
    default:
      return undefined;
  }
}

type DenialWindow = { readonly cap: Micro; readonly resetsAt: Date };

type DenialSnapshot = {
  readonly limits: { readonly perCallCap: Micro; readonly approvalThreshold: Micro };
  readonly remaining: { readonly daily: Micro; readonly monthly: Micro };
  readonly daily: DenialWindow;
  readonly monthly: DenialWindow;
};

/**
 * The reading rides on the error as an ordinary property, so it is checked field by field and
 * never trusted. A mandate error raised by a copy of the SDK this build did not construct is
 * ordinary, and one missing window would put "undefined left of undefined" on the screen.
 */
function snapshotOf(value: unknown): DenialSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const shaped = value as { limits?: unknown; remaining?: unknown; daily?: unknown; monthly?: unknown };

  if (!amounts(shaped.limits, ['perCallCap', 'approvalThreshold'])) return undefined;
  if (!amounts(shaped.remaining, ['daily', 'monthly'])) return undefined;
  if (!isWindow(shaped.daily) || !isWindow(shaped.monthly)) return undefined;

  return { limits: shaped.limits, remaining: shaped.remaining, daily: shaped.daily, monthly: shaped.monthly };
}

function amounts<K extends string>(value: unknown, keys: readonly K[]): value is Record<K, Micro> {
  if (typeof value !== 'object' || value === null) return false;
  const shaped = value as Record<string, unknown>;
  return keys.every((key) => typeof shaped[key] === 'bigint');
}

function isWindow(value: unknown): value is DenialWindow {
  return amounts(value, ['cap']) && (value as { resetsAt?: unknown }).resetsAt instanceof Date;
}

type Row = { label: string; value: ReactNode };

/**
 * The bucket that stopped the spend, quantified. Which one it is decides which figures to show.
 *
 * The clock stays a row of its own. A relative time baked into a sentence on the server is a
 * hydration mismatch, and `Instant` is where that is already handled.
 */
function limitRows(error: MandateShapedError): Row[] {
  const snapshot = snapshotOf(error.snapshot);
  const reason = denialReason(error);

  if (snapshot && reason === 'daily-cap') {
    return [
      { label: 'Left this period', value: usd(snapshot.remaining.daily) },
      { label: 'Period cap', value: usd(snapshot.daily.cap) },
      { label: 'Period rolls', value: <Instant at={snapshot.daily.resetsAt} relative /> },
    ];
  }

  if (snapshot && reason === 'monthly-cap') {
    return [
      { label: 'Left under the second cap', value: usd(snapshot.remaining.monthly) },
      { label: 'Second cap', value: usd(snapshot.monthly.cap) },
      { label: 'Window rolls', value: <Instant at={snapshot.monthly.resetsAt} relative /> },
    ];
  }

  if (snapshot && reason === 'total-budget') {
    return [
      { label: 'Left in the total budget', value: usd(snapshot.remaining.monthly) },
      { label: 'Total budget', value: usd(snapshot.monthly.cap) },
    ];
  }

  if (snapshot && reason === 'per-call-cap') {
    return [{ label: 'Most per payment', value: usd(snapshot.limits.perCallCap) }];
  }

  if (snapshot && reason === 'approval-required') {
    return [{ label: 'Approval needed at', value: usd(snapshot.limits.approvalThreshold) }];
  }

  if (error.resetsAt instanceof Date) {
    return [{ label: 'Limit frees up', value: <Instant at={error.resetsAt} relative /> }];
  }

  return [];
}

/** The properties the reader can act on, pulled off the error and never parsed out of its text. */
function ErrorFacts({ code, error }: { readonly code: string | undefined; readonly error: MandateShapedError }) {
  const rows: Row[] = [];

  if (code === 'mandate_denied') {
    if (isAddress(error.mandate)) rows.push({ label: 'Mandate', value: <Address value={error.mandate} /> });
    if (isAddress(error.merchant)) rows.push({ label: 'Merchant', value: <Address value={error.merchant} /> });
    if (typeof error.amount === 'bigint') rows.push({ label: 'Amount', value: usd(error.amount as Micro) });
    rows.push(...limitRows(error));
  }

  if (code === 'insufficient_funds') {
    if (isAddress(error.account)) rows.push({ label: 'Account', value: <Address value={error.account} /> });
    if (typeof error.balance === 'bigint') rows.push({ label: 'Holds', value: usd(error.balance as Micro) });
    if (typeof error.required === 'bigint') rows.push({ label: 'Needs', value: usd(error.required as Micro) });
  }

  if (code === 'gas_failure') {
    if (isAddress(error.sender)) rows.push({ label: 'Signer', value: <Address value={error.sender} /> });
    // The signer's ETH, never the mandate's USDG. Labelling it so is the difference between a
    // reader topping up the wallet that is short and topping up the account that is not.
    if (typeof error.balanceWei === 'bigint') rows.push({ label: 'Signer holds', value: formatEth(error.balanceWei as Wei) });
  }

  if (typeof error.hash === 'string' && error.hash.startsWith('0x')) {
    rows.push({ label: 'Transaction', value: <TxHash hash={error.hash as `0x${string}`} /> });
  }

  if (typeof error.errorName === 'string') rows.push({ label: 'Contract said', value: <code className="text-note">{error.errorName}</code> });
  if (typeof error.field === 'string') rows.push({ label: 'Field', value: error.field });

  if (rows.length === 0) return null;

  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-detail">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-[color:var(--color-muted)]">{row.label}</dt>
          <dd className="min-w-0">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function isAddress(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** One-line form for a table cell or a toast, where the full surface would not fit. */
export function errorLine(error: unknown, action?: string): string {
  if (error === null || error === undefined) return '';
  if (isUserRejection(error)) return 'Signature cancelled.';
  const shaped = error as MandateShapedError;
  if (typeof shaped.message === 'string') return shaped.message;
  return action ? `${action} failed.` : 'Something failed.';
}

/** Everything `shortAddress` is good for, exposed so a caller can build its own line. */
export { shortAddress };

/** Lives next to the revert classifier now. Re-exported so every caller keeps one import. */
export { isUserRejection };
