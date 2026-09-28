import { type Micro, microToAtomicString } from '@bursar/core';

import { type AnchorStatus, verifyAnchor } from './anchor.js';
import type { AccountState } from './chain.js';
import type { Address, Hex32, MandateDocument } from './document.js';

export type DivergenceKind =
  | 'version'
  | 'anchor'
  | 'unanchored'
  | 'per_call_cap'
  | 'daily_limit'
  | 'daily_window'
  | 'monthly_limit'
  | 'monthly_window'
  | 'approval_threshold'
  | 'valid_from'
  | 'valid_until'
  | 'merchant_gate'
  | 'merchant_root'
  | 'merchant_allowlist'
  | 'capability';

/**
 * `document_looser` is the one that matters. It means the document promises room the contract
 * will not give, so anyone reading the document alone would misjudge what the agent can spend.
 * `document_tighter` is safe by construction: this service refuses more than the chain would.
 * `document_silent` means the chain enforces a limit the document never mentions.
 */
export type DivergenceDirection = 'document_looser' | 'document_tighter' | 'document_silent' | 'mismatch';

export type DivergenceSeverity = 'critical' | 'warn' | 'info';

export type Divergence = {
  readonly kind: DivergenceKind;
  readonly direction: DivergenceDirection;
  readonly severity: DivergenceSeverity;
  readonly document: string;
  readonly chain: string;
};

export type ReconcileContext = {
  readonly chainId: number;
  /** The merchant this request names, with what the account's allowlist says about it. */
  readonly merchant?: { readonly address: Address; readonly allowed: boolean };
  readonly capability?: { readonly id: Hex32; readonly allowed: boolean };
};

export type Reconciliation = {
  readonly anchor: AnchorStatus;
  readonly divergences: readonly Divergence[];
  readonly critical: boolean;
};

function severityFor(direction: DivergenceDirection): DivergenceSeverity {
  if (direction === 'document_looser' || direction === 'mismatch') return 'critical';
  if (direction === 'document_silent') return 'warn';
  return 'info';
}

function push(out: Divergence[], kind: DivergenceKind, direction: DivergenceDirection, document: string, chain: string): void {
  out.push({ kind, direction, severity: severityFor(direction), document, chain });
}

function compareCap(out: Divergence[], kind: DivergenceKind, documentValue: Micro | null, chainValue: Micro): void {
  if (documentValue === null) {
    push(out, kind, 'document_silent', 'not declared', microToAtomicString(chainValue));
    return;
  }
  if (documentValue === chainValue) return;
  push(
    out,
    kind,
    documentValue > chainValue ? 'document_looser' : 'document_tighter',
    microToAtomicString(documentValue),
    microToAtomicString(chainValue),
  );
}

function compareSeconds(out: Divergence[], kind: DivergenceKind, documentValue: number | null, chainValue: number): void {
  if (documentValue === null) {
    push(out, kind, 'document_silent', 'not declared', `${chainValue}s`);
    return;
  }
  if (documentValue === chainValue) return;
  // A longer period is a slower refill, so the longer window is the tighter one.
  push(
    out,
    kind,
    documentValue < chainValue ? 'document_looser' : 'document_tighter',
    `${documentValue}s`,
    `${chainValue}s`,
  );
}

function secondsOf(timestamp: string): bigint {
  return BigInt(Math.floor(Date.parse(timestamp) / 1000));
}

/**
 * Reads the document against the account and reports every place they disagree.
 *
 * Nothing here changes a decision. The account decides; this exists so a disagreement is recorded
 * as a trust event, and so an operator finds out that a document they are circulating no longer
 * describes the limits anyone is held to.
 */
export function reconcile(document: MandateDocument, state: AccountState, context: ReconcileContext): Reconciliation {
  const out: Divergence[] = [];
  const anchor = verifyAnchor(document, state, context.chainId);

  if (document.version === null) {
    push(out, 'version', 'document_silent', 'not declared', state.version.toString(10));
  } else if (document.version !== state.version) {
    // Any version other than the live one describes limits that have since been rewritten.
    push(out, 'version', 'mismatch', document.version.toString(10), state.version.toString(10));
  }

  if (anchor.unanchored) {
    push(out, 'unanchored', 'document_silent', anchor.documentHash, 'nothing anchored');
  } else if (!anchor.matches) {
    push(out, 'anchor', 'mismatch', anchor.expected, anchor.anchored);
  }

  compareCap(out, 'per_call_cap', document.perCallCapMicros, state.limits.perCallCapMicros);
  compareCap(out, 'daily_limit', document.daily?.limitMicros ?? null, state.limits.dailyCapMicros);
  compareSeconds(out, 'daily_window', document.daily?.seconds ?? null, state.limits.dailyWindowSeconds);
  compareCap(out, 'monthly_limit', document.monthly?.limitMicros ?? null, state.limits.monthlyCapMicros);
  compareSeconds(out, 'monthly_window', document.monthly?.seconds ?? null, state.limits.monthlyWindowSeconds);

  // The threshold is the amount at and above which consent is needed, so a higher one asks for
  // consent less often. A document threshold above the chain's promises autonomy it will refuse.
  compareCap(out, 'approval_threshold', document.approvalThresholdMicros, state.limits.approvalThresholdMicros);

  const documentFrom = document.validFrom === null ? null : secondsOf(document.validFrom);
  if (documentFrom === null) {
    if (state.limits.validFrom !== 0n) {
      push(out, 'valid_from', 'document_silent', 'not declared', state.limits.validFrom.toString(10));
    }
  } else if (documentFrom !== state.limits.validFrom) {
    push(
      out,
      'valid_from',
      documentFrom < state.limits.validFrom ? 'document_looser' : 'document_tighter',
      documentFrom.toString(10),
      state.limits.validFrom.toString(10),
    );
  }

  const documentUntil = secondsOf(document.expiresAt);
  if (state.limits.validUntil === 0n) {
    // The account never expires, so the document only ever narrows it.
    push(out, 'valid_until', 'document_tighter', documentUntil.toString(10), 'no expiry');
  } else if (documentUntil !== state.limits.validUntil) {
    push(
      out,
      'valid_until',
      documentUntil > state.limits.validUntil ? 'document_looser' : 'document_tighter',
      documentUntil.toString(10),
      state.limits.validUntil.toString(10),
    );
  }

  const documentGate = document.merchantGate;
  const chainGate = state.merchantGate;
  if (documentGate === null) {
    push(out, 'merchant_gate', 'document_silent', 'not declared', chainGate.kind);
  } else if (documentGate.kind !== chainGate.kind) {
    push(out, 'merchant_gate', 'mismatch', documentGate.kind, chainGate.kind);
  } else if (documentGate.kind === 'merkleRoot' && chainGate.kind === 'merkleRoot') {
    if (documentGate.root !== chainGate.root) {
      push(out, 'merchant_root', 'mismatch', documentGate.root, chainGate.root);
    }
  } else if (documentGate.kind === 'allowlist' && context.merchant !== undefined) {
    const wanted = context.merchant.address.toLowerCase();
    const listed = documentGate.merchants.some((entry) => entry.toLowerCase() === wanted);
    if (listed !== context.merchant.allowed) {
      push(
        out,
        'merchant_allowlist',
        listed ? 'document_looser' : 'document_tighter',
        listed ? 'allowed' : 'not listed',
        context.merchant.allowed ? 'allowed' : 'not allowed',
      );
    }
  }

  if (context.capability !== undefined) {
    if (document.capabilities === null) {
      push(out, 'capability', 'document_silent', 'not declared', context.capability.allowed ? 'allowed' : 'not allowed');
    } else {
      const id = context.capability.id.toLowerCase();
      const listed = document.capabilities.some((c) => c.toLowerCase() === id);
      if (listed !== context.capability.allowed) {
        push(
          out,
          'capability',
          listed ? 'document_looser' : 'document_tighter',
          listed ? 'allowed' : 'not listed',
          context.capability.allowed ? 'allowed' : 'not allowed',
        );
      }
    }
  }

  return { anchor, divergences: out, critical: out.some((d) => d.severity === 'critical') };
}
