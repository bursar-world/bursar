import { BursarError } from '@bursar/core';
import { revertFrom } from '@bursar/sdk';
import type { RevertInfo } from '@bursar/sdk';

import { failureFrom, isUserRejection } from '@/lib/revert';
import { formatBrsr } from '@/money';
import type { Brsr } from '@/money';

/**
 * A refusal from the dispute layer, in the resolver's own words.
 *
 * The SDK decodes revert data against the union of the deployment's ABIs, so a call into
 * `OracleRegistry` comes back with the contract's own error name and its arguments. The name alone
 * is not an answer: `BondTooSmall` tells a resolver nothing about who moved the floor or what
 * clears it. Each line below names the condition, whoever owns it, and the one thing that changes
 * it. Anything not listed falls through to the classifier the rest of the app uses, which is what
 * keeps one taxonomy behind the console, the provider desk and this one.
 */
export class ResolverRefusedError extends BursarError {
  readonly errorName: string;

  constructor(errorName: string, message: string, cause?: unknown) {
    super('resolver_refused', message, { errorName });
    this.errorName = errorName;
    if (cause !== undefined) this.cause = cause;
  }
}

export type RefusalContext = {
  /** The call in the resolver's words. Quoted back in the heading. */
  readonly action: string;
};

export function resolverFailure(error: unknown, context: RefusalContext): unknown {
  if (isUserRejection(error)) return error;

  const revert = revertFrom(error);
  const sentence = revert === undefined ? undefined : sentenceFor(revert);
  if (revert !== undefined && sentence !== undefined) {
    return new ResolverRefusedError(revert.errorName, sentence, error);
  }

  return failureFrom(error, { action: context.action });
}

function sentenceFor(revert: RevertInfo): string | undefined {
  switch (revert.errorName) {
    case 'BondNotAccepted':
      return bondNotAccepted(revert);
    case 'BondTooSmall':
      return 'Your bond is under the floor governance sets, so you cannot vote. Top the bond back up to at least the floor shown above, then seal the score again.';
    case 'BondLocked':
      return 'A dispute you voted on is still open, so your bond stays until it closes. Reveal any score you sealed, wait for those disputes to close, then complete the exit.';
    case 'UnbondNotRequested':
      return 'No exit is in progress. Ask to unbond first to start the cooldown.';
    case 'UnbondAlreadyRequested':
      return 'This address is already unbonding. Cancel the exit to stay active, or complete it when the cooldown ends.';
    case 'UnbondNotMatured':
      return 'The cooldown has not ended yet. You can complete the exit when the countdown on this card runs out.';
    case 'StakingNotSet':
      return 'This registry has no staking pool set, so it cannot take a bond.';
    case 'AlreadyRegistered':
      return 'This address already has a bond. Use "Add to the bond" to raise it.';
    case 'NotRegistered':
      return 'This address has no bond yet, so there is nothing to change. Post a bond first.';
    case 'NotActive':
      return 'This address is unbonding, so it cannot vote or add to its bond. Cancel the exit to go back to active.';
    case 'RosterFull':
      return 'All 64 resolver seats are taken. A seat opens when a resolver completes its exit or governance removes one.';
    case 'AlreadyCommitted':
      return 'You have already sealed a score on this dispute, and it cannot be replaced. Reveal it when the sealing window closes.';
    case 'NoCommitment':
      return 'This address sealed no score on this dispute, so there is nothing to reveal. Reveal from the wallet that sealed the score.';
    case 'AlreadyRevealed':
      return 'This score is already revealed. Nothing more is needed until the dispute closes.';
    case 'BadReveal':
      return 'The score and salt do not match what this address sealed. Check the salt you kept, character for character, and the exact score. A refused reveal does not touch the bond, but the reveal window keeps running.';
    case 'BadScore':
      return 'A score is a whole number from 0 to 100. Nothing was sent.';
    case 'CommitWindowClosed':
      return 'The sealing window on this dispute has closed, so no more scores can be sealed.';
    case 'CommitWindowOpen':
      return 'The sealing window is still open, so nothing can be revealed or closed yet. The countdown on the card shows when that changes.';
    case 'RevealWindowClosed':
      return 'The reveal window has closed, so this score can no longer be revealed. An unrevealed score is slashed when the dispute closes.';
    case 'RevealWindowOpen':
      return 'The reveal window is still open and some sealed scores are not revealed yet. The dispute can be closed once the window ends or every score is revealed.';
    case 'QuorumNotMet':
      return 'Too few resolvers revealed, so there is no ruling to finalise. Close it without a ruling instead: the payment goes back on hold for the payee with a new deadline, and the contest bond is returned.';
    case 'PartyCannotVote':
      return 'This wallet is the payer, the payee, or the principal the paying account named when the dispute opened, so it cannot vote on this dispute.';
    case 'BadStatus':
      return 'This dispute is already closed. Read the page again to see the latest.';
    case 'DisputeNotFound':
      return 'There is no dispute with that number. Dispute numbers differ from settlement numbers.';
    case 'NothingToClaim':
      return 'Nothing to claim yet. Rewards arrive when a dispute you ruled on settles.';
    case 'ZeroAmount':
      return 'Enter an amount above zero.';
    case 'ZeroAddress':
      return 'This transaction was missing a required address.';
    case 'ERC20InsufficientAllowance':
      return 'The registry is not allowed to move that much BRSR yet. Allow the amount first, then post the bond.';
    case 'ERC20InsufficientBalance':
      return 'This wallet does not hold that much BRSR.';
    default:
      return undefined;
  }
}

function bondNotAccepted(revert: RevertInfo): string {
  const offered = revert.args[0];
  const required = revert.args[1];
  if (typeof offered !== 'bigint' || typeof required !== 'bigint') {
    return 'The staking pool refused this bond. Check your floor above and try again.';
  }

  // The registry reports both figures for exactly this reading: a bond at or above the floor that
  // was still refused is a bar on the address, not a shortfall, and the two have different fixes.
  if (offered >= required) {
    return 'Governance has barred this address from bonding, so no amount is accepted. Only governance can lift the bar.';
  }

  return `The bond has to be at least ${formatBrsr(required as Brsr)} BRSR, and this offered ${formatBrsr(
    offered as Brsr,
  )} BRSR. Add the difference and try again.`;
}
