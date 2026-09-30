import { BursarError, micro } from '@bursar/core';
import { revertFrom } from '@bursar/sdk';
import type { RevertInfo } from '@bursar/sdk';

import { formatInstant } from '@/lib';
import { failureFrom, isUserRejection } from '@/lib/revert';
import { usdExact } from '@/money';

/**
 * A refusal from the staking pool or the buyback, in the staker's words.
 *
 * The SDK decodes the error name and its arguments; the name alone is not an answer. `UnbondLapsed`
 * tells a staker nothing about where their stake went or what brings it back. Each line below says
 * what happened, whose it is, and the one thing that changes it. Anything not listed falls through
 * to the classifier the rest of the app uses.
 */
export class TokenRefusedError extends BursarError {
  readonly errorName: string;

  constructor(errorName: string, message: string, cause?: unknown) {
    super('token_refused', message, { errorName });
    this.errorName = errorName;
    if (cause !== undefined) this.cause = cause;
  }
}

export type TokenContract = 'staking' | 'buyback';

export function tokenFailure(error: unknown, context: { readonly action: string; readonly contract: TokenContract }): unknown {
  if (isUserRejection(error)) return error;

  const revert = revertFrom(error);
  const sentence = revert === undefined ? undefined : sentenceFor(revert, context.contract);
  if (revert !== undefined && sentence !== undefined) return new TokenRefusedError(revert.errorName, sentence, error);

  return failureFrom(error, { action: context.action });
}

function sentenceFor(revert: RevertInfo, contract: TokenContract): string | undefined {
  switch (revert.errorName) {
    case 'UnbondLapsed':
      return `${at('This request lapsed', revert.args[0])} without being completed. The stake is still yours and still in the pool, earning nothing. Put it back to work, then ask to leave again if you still want to.`;
    case 'ExitsHeld':
      return `${at('The pool is paused, and the pause keeps exits from completing until', revert.args[0])}. The same time is added to this request before it lapses, so waiting it out costs nothing.`;
    case 'UnbondNotMatured':
      return 'The exit wait on this request has not run out, and nothing shortens it. The countdown on this card is the moment it can complete.';
    case 'UnbondAlreadyRequested':
      return 'An exit request is already open, and there is one at a time. Complete it once it is ready, or cancel it to put the stake back to work.';
    case 'UnbondNotRequested':
      return 'No exit request is open for this wallet, so there is nothing to complete or cancel. The reading on this page is behind the chain; read it again.';
    case 'InsufficientShares':
      return 'That is more than this wallet has earning in the pool. The figure on this card is what it holds right now.';
    case 'DustAmount':
      return 'That amount is too small to count as a share of the pool at its current price. Enter a larger amount.';
    case 'PoolCollapsed':
      return 'A loss has taken almost all of the pool, and it takes no new stake until it recovers: a deposit now would be priced against almost nothing. Exits and claims are unaffected.';
    case 'EnforcedPause':
      return contract === 'buyback'
        ? 'The buyback is paused, so it cannot spend. Governance restarts it by proposal.'
        : 'The staking pool is paused, so it takes no new stake. Exit requests, cancellations and claims stay open. Governance lifts a pause by proposal.';
    case 'NothingToClaim':
      return 'There is no spread to claim yet. Spread reaches earning stake only when the credit pool pays it in.';
    case 'NotSlasher':
      return 'Only the slasher governance names can take stake, and this wallet is not it.';
    case 'NotKeeper':
      return 'Only the keeper governance names can trigger a buy, and this wallet is not it. The keeper is shown on this card.';
    case 'PriceCeilingUnset':
      return 'The buyback has no price ceiling, so it refuses every buy. Governance sets one by proposal.';
    case 'PriceCeilingStale':
      return `${at('The price ceiling went stale on', revert.args[0])}, and the buyback refuses to trade on a price nobody has restated. Governance sets it again by proposal, and buys resume from then.`;
    case 'TooSoon':
      return `${at('The last buy was too recent. The next one can run from', revert.args[0])}.`;
    case 'BelowMinimumSpend':
      return belowMinimum(revert);
    case 'NoStakeToDistributeTo':
      return 'Nothing is earning in the staking pool, so a buy would have nobody to compound into. It can run once stake is earning again.';
    case 'MinimumOutNotMet':
      return 'The pool would have filled this buy above the price ceiling, so it was refused rather than overpaying. Nothing was spent.';
    case 'ERC20InsufficientAllowance':
      return 'This wallet has not let the staking contract move that much BRSR. Allow the amount first, then stake it.';
    case 'ERC20InsufficientBalance':
      return 'This wallet does not hold that much BRSR. The balance on this page is what it holds right now.';
    default:
      return undefined;
  }
}

function at(lead: string, value: unknown): string {
  if (typeof value !== 'bigint' || value === 0n) return lead;
  return `${lead} ${formatInstant(new Date(Number(value) * 1000))}`;
}

function belowMinimum(revert: RevertInfo): string {
  const [available, minimum] = revert.args;
  if (typeof available !== 'bigint' || typeof minimum !== 'bigint') {
    return 'There is too little to spend right now for a buy to be worth making, so it was refused.';
  }
  return `A buy could spend ${usdExact(micro(available))} right now and the buyback refuses anything under ${usdExact(
    micro(minimum),
  )}. It waits for the balance or the window to allow more.`;
}
