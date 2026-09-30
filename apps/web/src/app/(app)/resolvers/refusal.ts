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
      return 'Your bond is under the floor the staking pool holds for you, so the registry will not take a vote from you. Governance owns that floor and can raise it for one resolver or for everyone. Top the bond back up to at least the floor shown above, then seal the score again.';
    case 'BondLocked':
      return 'A dispute you committed to has not settled, and the bond behind it cannot leave until it does. Nobody can release it early. Reveal the scores you sealed, wait for those disputes to be closed, then complete the exit.';
    case 'UnbondNotRequested':
      return 'This address has no exit in progress, so there is nothing to complete or cancel. Ask to unbond first, which starts the cooldown.';
    case 'UnbondAlreadyRequested':
      return 'This address has already asked to unbond and the cooldown is running. Cancel the exit to go back to active, or wait it out and complete it.';
    case 'UnbondNotMatured':
      return 'The cooldown on this exit has not run out yet, and nobody can shorten it. The countdown on this card is the moment the bond can leave.';
    case 'StakingNotSet':
      return 'This registry has no staking pool named, so it holds no bond currency and can take no bond. That pairing is set once by the deployer and cannot be set from here. Nothing on this page can be bonded until it is.';
    case 'AlreadyRegistered':
      return 'This address already holds a bond on the registry. Use "Add to the bond" to raise it. Registering again is refused so a second bond cannot overwrite the first.';
    case 'NotRegistered':
      return 'This address holds no bond on the registry, so there is nothing to change. Bond BRSR first.';
    case 'NotActive':
      return 'This address has asked to unbond, and an unbonding resolver takes no new votes and no top-ups. Cancel the exit to go back to active, which returns the bond to work without moving it.';
    case 'RosterFull':
      return 'Every seat on the registry is taken. It holds 64 resolvers, and every one of them may vote on every dispute. A seat frees when a resolver completes its exit or governance evicts one, and registering works again from then.';
    case 'AlreadyCommitted':
      return 'You have already sealed a score on this dispute. One commitment per resolver, and it cannot be replaced. Reveal it when the commit window closes.';
    case 'NoCommitment':
      return 'The registry holds no sealed score from this address on this dispute, so there is nothing to reveal. A reveal only works against a commitment made from the same wallet.';
    case 'AlreadyRevealed':
      return 'This score is already revealed and on the registry. Nothing further is owed on this dispute until somebody closes it.';
    case 'BadReveal':
      return 'The score and salt do not hash to the commitment this address sealed. One of the two is wrong, or they belong to a different dispute. Check the salt you kept, character for character, and the exact score you sealed. The bond is not touched by a refused reveal, but the reveal window keeps running.';
    case 'BadScore':
      return 'A score is a whole number from 0 to 100. Nothing was sent.';
    case 'CommitWindowClosed':
      return 'The commit window on this dispute has closed and no further scores can be sealed. Only the resolvers who sealed one in time can take part in the ruling.';
    case 'CommitWindowOpen':
      return 'The commit window is still open, so nothing can be revealed and the dispute cannot be closed yet. The countdown on the card is the moment that changes.';
    case 'RevealWindowClosed':
      return 'The reveal window has closed. A commitment left unrevealed is slashed when this dispute is closed, and there is no way to reveal it now.';
    case 'RevealWindowOpen':
      return 'The reveal window is still open and not every sealed score has been published, so the panel is not finished. The dispute can be closed once the window ends or once every commitment has been revealed.';
    case 'QuorumNotMet':
      return 'Too few resolvers revealed for the panel to produce a result, so there is no ruling to finalise. Close it without a ruling instead, which puts the payment back on hold for the payee with a new deadline and returns the contest bond.';
    case 'PartyCannotVote':
      return 'This wallet is the payer, the payee, or the principal the paying account named when the dispute opened, so the registry will not take its vote on this dispute. Another resolver has to rule on it.';
    case 'BadStatus':
      return 'This dispute has already been closed, so neither exit is open. The reading on this page is behind the chain. Read it again.';
    case 'DisputeNotFound':
      return 'The registry has no dispute under that id. A dispute id is minted by the escrow when a payer contests a settlement, and it is not the settlement id.';
    case 'NothingToClaim':
      return 'There is nothing to pay out. Rewards land on a resolver only when a dispute they ruled on settles and the escrow returns its resolver fee.';
    case 'ZeroAmount':
      return 'A bond of zero is refused. Enter an amount above zero.';
    case 'ZeroAddress':
      return 'The call carried the zero address where a real one was required.';
    case 'ERC20InsufficientAllowance':
      return 'This wallet has not let the registry move that much BRSR. Approve the amount first, then bond it. The approval and the bond are two transactions.';
    case 'ERC20InsufficientBalance':
      return 'This wallet does not hold that much BRSR. The balance on this page is what it holds right now.';
    default:
      return undefined;
  }
}

function bondNotAccepted(revert: RevertInfo): string {
  const offered = revert.args[0];
  const required = revert.args[1];
  if (typeof offered !== 'bigint' || typeof required !== 'bigint') {
    return 'The staking pool refused this bond. It holds the floor, and governance moves it.';
  }

  // The registry reports both figures for exactly this reading: a bond at or above the floor that
  // was still refused is a bar on the address, not a shortfall, and the two have different fixes.
  if (offered >= required) {
    return `Governance has barred this address from bonding, so any amount is refused. It offered ${formatBrsr(
      offered as Brsr,
    )} BRSR against a floor of ${formatBrsr(required as Brsr)} BRSR. The bar is held in the staking pool and only governance lifts it.`;
  }

  return `The bond has to be at least ${formatBrsr(required as Brsr)} BRSR and this call offered ${formatBrsr(
    offered as Brsr,
  )} BRSR. The floor is held in the staking pool, and governance can raise it for one address above the global one. Post the difference and send it again.`;
}
