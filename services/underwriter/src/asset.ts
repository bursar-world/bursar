import type { ControlReading, IssuerControls } from './chain.js';
import { RefuseReason } from './decision.js';
import type { Address } from './document.js';

/*
 * What the settlement asset says about a spend, and who has to fix it when it says no.
 *
 * Every other refusal this service issues names a term somebody here agreed to: a cap the
 * principal set, a gate the escrow owner set, a rule in the document. These name a control the
 * token issuer holds. USDG carries two of them and both answered when the token was read on chain
 * 4663 on 2026-09-22: `paused()` stops every transfer at once, `isFrozen(address)` stops one
 * address's. Neither the principal nor the operator nor this underwriter can clear either, so the
 * refusal has to say so instead of pointing at a limit that was never in the way.
 *
 * `previewSpend` cannot see any of this. The account would allow the spend; the token would refuse
 * the pull inside `Escrow.lock` and the agent would have paid for the gas to find out.
 */

/** The two addresses the token is asked about: the account the escrow pulls from, and the payee. */
export type SpendParties = {
  readonly payer: Address;
  readonly payee: Address;
};

/**
 * A refusal the settlement asset produced, kept whole for the quote and for support transcripts.
 *
 * `party` is the address the token reported on, which is the difference between a principal
 * checking their own account with the issuer and chasing the payee to check theirs.
 */
export type AssetCondition = {
  readonly asset: Address;
  readonly reason: RefuseReason;
  readonly party: Address | null;
  readonly detail: string;
};

function unresolvedReason(reading: Exclude<ControlReading, { state: 'read' }>): RefuseReason {
  return reading.state === 'absent' ? RefuseReason.AssetControlAbsent : RefuseReason.AssetControlUnreadable;
}

function unresolvedDetail(
  reading: Exclude<ControlReading, { state: 'read' }>,
  asset: Address,
  call: string,
): string {
  return reading.state === 'absent'
    ? `${asset} reverted FacetNotFound on ${call}, so the settlement asset no longer carries the control this underwriter reads. A control that cannot be read is never taken as clear, so no spend is authorised against this asset until an operator has checked what the token exposes now.`
    : `${call} on ${asset} did not answer: ${reading.detail}. A control that cannot be read is never taken as clear, so the spend is refused rather than authorised on a guess. Ask again once the chain answers.`;
}

/**
 * The verdict on the issuer's controls, or null when the token permits this spend to go on.
 *
 * Established conditions are reported before unestablished ones. A payee the issuer has frozen is
 * worth saying even if the pause read timed out in the same batch: one of the two is an answer and
 * the other is the absence of one.
 */
export function assetCondition(controls: IssuerControls, parties: SpendParties): AssetCondition | null {
  const asset = controls.asset;
  const readingFor = (address: Address): ControlReading | null =>
    controls.parties.find((party) => party.address.toLowerCase() === address.toLowerCase())?.frozen ?? null;

  const payer = readingFor(parties.payer);
  const payee = readingFor(parties.payee);

  if (controls.paused.state === 'read' && controls.paused.value) {
    return {
      asset,
      reason: RefuseReason.AssetPaused,
      party: null,
      detail: `The token issuer has paused ${asset}, so nothing denominated in it moves for anyone, including a withdrawal back to the principal. Only the token issuer can lift a pause. Fees are paid in ETH, which is a different asset, so pausing and revoking this mandate still work.`,
    };
  }

  if (payer?.state === 'read' && payer.value) {
    return {
      asset,
      reason: RefuseReason.PayerFrozen,
      party: parties.payer,
      detail: `The token issuer has frozen ${parties.payer}, so the escrow cannot pull from it whatever its balance says and whatever this mandate allows. Only the token issuer can lift a freeze; raising a limit or funding the account changes nothing here.`,
    };
  }

  if (payee?.state === 'read' && payee.value) {
    return {
      asset,
      reason: RefuseReason.PayeeFrozen,
      party: parties.payee,
      detail: `The token issuer has frozen the payee ${parties.payee}, so a lock opened in their favour cannot be released to them while the freeze stands. Only the token issuer can lift a freeze; until it does, this payee has to be paid at an address the issuer has not frozen.`,
    };
  }

  if (controls.paused.state !== 'read') {
    return {
      asset,
      reason: unresolvedReason(controls.paused),
      party: null,
      detail: unresolvedDetail(controls.paused, asset, 'paused()'),
    };
  }

  for (const [address, reading] of [
    [parties.payer, payer],
    [parties.payee, payee],
  ] as const) {
    // A party nobody read is a party nobody cleared, so a missing reading refuses like an
    // unreadable one. It is what a chain client answering a short list would look like.
    const resolved: ControlReading = reading ?? {
      state: 'unreadable',
      detail: `the chain client returned no reading for ${address}`,
    };
    if (resolved.state === 'read') continue;
    return {
      asset,
      reason: unresolvedReason(resolved),
      party: address,
      detail: unresolvedDetail(resolved, asset, `isFrozen(${address})`),
    };
  }

  return null;
}
