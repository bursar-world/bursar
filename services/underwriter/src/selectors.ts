import { escrowAbi, escrowAbiV1, mandateAccountAbi, mandateAccountAbiV1 } from '@bursar/core';
import { toFunctionSelector } from 'viem';

import { type Bucket, RefuseReason, bucketFor } from './decision.js';
import type { Hex32 } from './document.js';

export type Selector = `0x${string}`;

export type ChainRefusal = {
  readonly selector: Selector;
  /** The Solidity error name, kept for diagnostics and support transcripts. */
  readonly error: string;
  readonly reason: RefuseReason;
  readonly bucket: Bucket | null;
};

/**
 * Which refusal each of the account's errors means to a caller. `previewSpend` answers with a
 * selector, so this table is what turns four opaque bytes into the name of the limit that ran
 * out.
 *
 * Two entries are not refusals and the underwriter intercepts both before they become one.
 * `ApprovalRequired` is a hold, routed to `spendApproved`. `MerkleGateActive` is the account
 * saying it cannot answer the merchant term without a proof, which is the gap `previewSpend`
 * documents; that term is settled off chain against the same root.
 */
const ACCOUNT_REASONS: Readonly<Record<string, RefuseReason>> = {
  IsPaused: RefuseReason.Paused,
  IsRevoked: RefuseReason.Revoked,
  NotYetValid: RefuseReason.NotYetValid,
  Expired: RefuseReason.Expired,
  PerCallCapExceeded: RefuseReason.OverPerCallCap,
  DailyCapExceeded: RefuseReason.DailyCapExceeded,
  MonthlyCapExceeded: RefuseReason.MonthlyCapExceeded,
  MerchantNotAllowed: RefuseReason.MerchantNotAllowed,
  CapabilityNotAllowed: RefuseReason.CapabilityNotAllowed,
  BadMerkleProof: RefuseReason.BadMerkleProof,
  MerkleGateActive: RefuseReason.MerchantGateUndecidable,
  AllowlistGateActive: RefuseReason.StaleMerchantProof,
  ApprovalRequired: RefuseReason.ApprovalRequired,
  ZeroAmount: RefuseReason.ZeroAmount,
  ZeroAddress: RefuseReason.ZeroAddress,
  NotAgent: RefuseReason.NotAgent,
  // v2 only. A class the mandate leaves out is a capability it does not allow, and the lifetime
  // total is the cumulative ceiling the source document already names.
  ClassNotAllowed: RefuseReason.CapabilityNotAllowed,
  TotalCapExceeded: RefuseReason.OverCumulativeCeiling,
};

/** Used to read a revert back from a full `spend` simulation, which previewSpend cannot cover. */
const ESCROW_REASONS: Readonly<Record<string, RefuseReason>> = {
  BadTtl: RefuseReason.TtlOutOfBounds,
  PartyNotAllowed: RefuseReason.MerchantNotParty,
  PayeeCapExceeded: RefuseReason.PayeeCapExceeded,
  ZeroAmount: RefuseReason.ZeroAmount,
  ZeroAddress: RefuseReason.ZeroAddress,
};

type AbiErrorItem = { readonly type: string; readonly name?: string; readonly inputs?: readonly { readonly type: string }[] };

export function errorSelector(name: string, inputs: readonly { readonly type: string }[] = []): Selector {
  return toFunctionSelector(`${name}(${inputs.map((input) => input.type).join(',')})`);
}

function buildTable(abi: readonly unknown[], reasons: Readonly<Record<string, RefuseReason>>): Map<Selector, ChainRefusal> {
  const table = new Map<Selector, ChainRefusal>();
  for (const item of abi as readonly AbiErrorItem[]) {
    if (item.type !== 'error' || item.name === undefined) continue;
    const selector = errorSelector(item.name, item.inputs ?? []);
    const reason = reasons[item.name] ?? RefuseReason.ChainRefusedUnrecognised;
    table.set(selector, { selector, error: item.name, reason, bucket: bucketFor(reason) });
  }
  return table;
}

// Both sets, so a v1 mandate's revert decodes as well as a v2 one. v2 only adds errors.
export const ACCOUNT_SELECTORS: ReadonlyMap<Selector, ChainRefusal> = buildTable(
  [...mandateAccountAbiV1, ...mandateAccountAbi],
  ACCOUNT_REASONS,
);
export const ESCROW_SELECTORS: ReadonlyMap<Selector, ChainRefusal> = buildTable([...escrowAbiV1, ...escrowAbi], ESCROW_REASONS);

export const APPROVAL_REQUIRED_SELECTOR: Selector = errorSelector('ApprovalRequired');
export const MERKLE_GATE_ACTIVE_SELECTOR: Selector = errorSelector('MerkleGateActive');
export const ZERO_SELECTOR: Selector = '0x00000000';

function normalise(selector: string): Selector {
  return selector.toLowerCase() as Selector;
}

/**
 * A selector this build does not recognise still blocks the spend. The account reverted, and
 * not knowing which error it used is not a reason to let the payment through.
 */
export function accountRefusal(selector: Hex32 | Selector): ChainRefusal {
  const key = normalise(selector);
  return (
    ACCOUNT_SELECTORS.get(key) ?? {
      selector: key,
      error: 'unknown',
      reason: RefuseReason.ChainRefusedUnrecognised,
      bucket: null,
    }
  );
}

export function isApprovalRequired(selector: Hex32 | Selector): boolean {
  return normalise(selector) === APPROVAL_REQUIRED_SELECTOR;
}

export function isMerkleGateActive(selector: Hex32 | Selector): boolean {
  return normalise(selector) === MERKLE_GATE_ACTIVE_SELECTOR;
}

/**
 * Decodes a revert from a full `spend` simulation. The account is tried first: it and the
 * escrow share several error names, and the account is the contract that was called.
 */
export function spendRefusal(selector: Hex32 | Selector): ChainRefusal {
  const key = normalise(selector);
  return ACCOUNT_SELECTORS.get(key) ?? ESCROW_SELECTORS.get(key) ?? accountRefusal(key);
}
