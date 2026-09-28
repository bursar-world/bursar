import type { AssetMeta } from './domain.js';
import { describe, refuse, type MethodFailure } from './method.js';
import type { ControlReading, IssuerControls } from './ports.js';
import { REASON, type InvalidReason } from './reasons.js';

/**
 * What the token itself says about a payment, and what that means for the payer.
 *
 * Every other refusal in this package is about the authorisation: its shape, its signature, its
 * nonce, the balance behind it. These are about the asset. USDG on Robinhood Chain carries two
 * issuer controls and both were read on chain on 2026-09-22: `paused()` stops every transfer at
 * once, `isFrozen(address)` stops one address's. Neither is the operator's to clear and neither is
 * the payer's, so they are the only refusals here that a retry cannot fix, and they say so.
 *
 * A control that does not answer is refused too. That is the discipline everywhere else in this
 * repo and it holds here: the alternative is settling a payment on the absence of information.
 * What this file will not do is flatten the two ways a read fails into one sentence. USDG is a
 * diamond, so a selector it no longer routes reverts `FacetNotFound` and says the control has left
 * the token; a read that times out says nothing about the token at all.
 */

/** What a diamond answers for a selector none of its facets declare. Read from USDG on 4663. */
export const FACET_NOT_FOUND = '0x800ab12c';

/** The parties to one payment, as the token sees them. */
export type PaymentParties = {
  readonly payer: `0x${string}`;
  readonly payee: `0x${string}`;
};

/**
 * Every sentence and every revert payload an error chain carries, lowercased into one string.
 *
 * viem, the RPC pool and the node each wrap a revert differently and put the useful part in a
 * different field. Reading all of them costs nothing and means a caller of this file never has to
 * know which library was in the way.
 */
export function revertText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cursor: unknown = error;

  while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    if (typeof cursor === 'string') {
      parts.push(cursor);
      break;
    }
    if (typeof cursor !== 'object') break;

    const record = cursor as Record<string, unknown>;
    for (const field of ['shortMessage', 'message', 'details', 'reason', 'data', 'raw'] as const) {
      const value = record[field];
      if (typeof value === 'string') parts.push(value);
      else if (value !== null && typeof value === 'object') {
        const nested = (value as { data?: unknown }).data;
        if (typeof nested === 'string') parts.push(nested);
      }
    }
    cursor = record['cause'];
  }

  return parts.join(' ').toLowerCase();
}

/**
 * Whether a failed read is the contract answering "no" rather than the chain not answering.
 *
 * A probe that reads every failure as "not implemented" turns one RPC timeout at startup into a
 * transfer path silently dropped until the next restart. Only a revert, or a call that came back
 * with no data at all, is the contract speaking; anything else is a transport fault and is
 * rethrown by the caller.
 */
export function isRevert(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (typeof cursor === 'object' && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const record = cursor as Record<string, unknown>;
    const name = record['name'];
    if (name === 'ContractFunctionRevertedError' || name === 'ContractFunctionZeroDataError') return true;
    // JSON-RPC code 3 is "execution reverted" with revert data attached.
    if (record['code'] === 3 || record['rpcCode'] === 3) return true;
    cursor = record['cause'];
  }
  const text = revertText(error);
  return text.includes('revert') || text.includes('returned no data');
}

/**
 * Why a control read failed, as a reading rather than as a throw.
 *
 * `FacetNotFound` is matched on the selector the diamond returns and on the name, because a node
 * that decodes the error hands back the name and one that does not hands back the four bytes.
 */
export function controlFailure(error: unknown): ControlReading {
  const text = revertText(error);
  const detail = describe(error);
  return text.includes(FACET_NOT_FOUND) || text.includes('facetnotfound')
    ? { state: 'absent', detail }
    : { state: 'unreadable', detail };
}

/** Runs one control read and keeps whatever came back, including the failure. */
export async function readControl(read: () => Promise<boolean>): Promise<ControlReading> {
  try {
    return { state: 'read', value: await read() };
  } catch (error) {
    return controlFailure(error);
  }
}

type Unresolved = Exclude<ControlReading, { state: 'read' }>;

function unresolvedDetail(reading: Unresolved, asset: AssetMeta, call: string): string {
  return reading.state === 'absent'
    ? `${asset.name} reverted FacetNotFound on ${call}, so the token no longer carries the control this facilitator reads. An issuer control that cannot be read is never taken as clear, so nothing settles in this asset until an operator has checked what the token exposes now.`
    : `${call} on ${asset.name} did not answer: ${reading.detail}. An issuer control that cannot be read is never taken as clear, so the payment is refused rather than settled on a guess. Present it again once the chain answers.`;
}

function unresolvedReason(reading: Unresolved): InvalidReason {
  return reading.state === 'absent' ? REASON.assetControlAbsent : REASON.assetControlUnreadable;
}

/**
 * The verdict on the issuer's controls, or null when the token permits this payment to be tried.
 *
 * Established conditions are reported before unestablished ones. A payer whose address the issuer
 * has frozen is owed that sentence even if the pause read timed out in the same batch: one of the
 * two is an answer and the other is the absence of one.
 */
export function issuerRefusal(
  asset: AssetMeta,
  controls: IssuerControls,
  parties: PaymentParties,
): MethodFailure | null {
  const frozen = (address: `0x${string}`): ControlReading | null =>
    controls.parties.find((party) => party.address.toLowerCase() === address.toLowerCase())?.frozen ?? null;

  const payerReading = frozen(parties.payer);
  const payeeReading = frozen(parties.payee);

  if (controls.paused.state === 'read' && controls.paused.value) {
    return refuse(
      REASON.assetPaused,
      parties.payer,
      `${asset.name} transfers are paused by the token issuer, so no payment in this asset settles for anyone. Only the issuer can lift a pause, and the payment can be presented again after that.`,
    );
  }
  if (payerReading?.state === 'read' && payerReading.value) {
    return refuse(
      REASON.payerFrozen,
      parties.payer,
      `The token issuer has frozen ${parties.payer}, so ${asset.name} cannot move out of that address whatever its balance says. Only the issuer can lift a freeze; until it does, pay from an address it has not frozen.`,
    );
  }
  if (payeeReading?.state === 'read' && payeeReading.value) {
    return refuse(
      REASON.payeeFrozen,
      parties.payer,
      `The token issuer has frozen the payee ${parties.payee}, so ${asset.name} cannot reach that address. Only the issuer can lift a freeze; until it does, the payee has to be paid at an address the issuer has not frozen.`,
    );
  }

  if (controls.paused.state !== 'read') {
    return refuse(
      unresolvedReason(controls.paused),
      parties.payer,
      unresolvedDetail(controls.paused, asset, 'paused()'),
    );
  }

  for (const [address, reading] of [
    [parties.payer, payerReading],
    [parties.payee, payeeReading],
  ] as const) {
    // A party nobody read is not a party anybody cleared, so a missing reading refuses like an
    // unreadable one. It is what a chain client returning a short list would look like.
    const resolved: ControlReading = reading ?? {
      state: 'unreadable',
      detail: `the chain client returned no reading for ${address}`,
    };
    if (resolved.state === 'read') continue;
    return refuse(
      unresolvedReason(resolved),
      parties.payer,
      unresolvedDetail(resolved, asset, `isFrozen(${address})`),
    );
  }

  return null;
}

/**
 * What stopped a simulated settlement.
 *
 * The simulation is the last check before a broadcast. The issuer's conditions are read and named
 * above, so anything arriving here is a refusal those reads did not cover.
 *
 * The token's own words are still worth reading. A pause or a freeze landing between the reads
 * and this call reverts here, and the sentence the node hands back is the only evidence of that.
 * Which errors USDG reverts with is not something this repo has read off the chain, so the match
 * is on what the node said rather than on a decoded error set, and anything unrecognised keeps
 * `invalid_transaction_state` with the token's sentence attached.
 */
export function simulationRefusal(error: unknown, asset: AssetMeta, parties: PaymentParties): MethodFailure {
  const text = revertText(error);
  const detail = describe(error);

  if (/paus/.test(text)) {
    return refuse(
      REASON.assetPaused,
      parties.payer,
      `${asset.name} refused the transfer as paused: ${detail}. A pause stops every transfer of this asset and only the token issuer can lift it.`,
    );
  }

  if (/frozen|freeze|blacklist/.test(text)) {
    // The token names the address inside the revert on the paths that carry one, which is the only
    // thing here that can tell the two parties apart. Guessing between them would send somebody to
    // argue their own address is clear when it is the other one that is frozen.
    if (text.includes(parties.payee.toLowerCase().slice(2)) && !text.includes(parties.payer.toLowerCase().slice(2))) {
      return refuse(
        REASON.payeeFrozen,
        parties.payer,
        `${asset.name} refused the transfer because the payee ${parties.payee} is frozen: ${detail}. Only the token issuer can lift a freeze.`,
      );
    }
    if (text.includes(parties.payer.toLowerCase().slice(2))) {
      return refuse(
        REASON.payerFrozen,
        parties.payer,
        `${asset.name} refused the transfer because ${parties.payer} is frozen: ${detail}. Only the token issuer can lift a freeze.`,
      );
    }
    return refuse(
      REASON.state,
      parties.payer,
      `${asset.name} refused the transfer as frozen without naming the address: ${detail}. A freeze belongs to the token issuer, and neither address read as frozen a moment earlier, so check both with the issuer.`,
    );
  }

  return refuse(REASON.state, parties.payer, detail);
}
