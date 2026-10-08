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
      return `${at('This request lapsed', revert.args[0])} without being completed. The stake is still yours, in the pool and earning nothing. Put it back to work, then request the withdrawal again.`;
    case 'ExitsHeld':
      return `${at('The pool is paused, and the pause keeps exits from completing until', revert.args[0])}. The same time is added before this request lapses, so you lose nothing by waiting.`;
    case 'UnbondNotMatured':
      return 'The exit wait has not ended yet. You can complete the withdrawal when the countdown on this card runs out.';
    case 'UnbondAlreadyRequested':
      return 'An exit request is already open, and only one is allowed at a time. Complete it once it is ready, or cancel it to put the stake back to work.';
    case 'UnbondNotRequested':
      return 'No exit request is open for this wallet. Read the page again to see the latest.';
    case 'InsufficientShares':
      return 'That is more than this wallet has earning in the pool.';
    case 'DustAmount':
      return 'That amount is too small to count as a share of the pool at its current price. Enter a larger amount.';
    case 'PoolCollapsed':
      return 'The pool is not taking new stake after a loss took almost all of it. Exits and claims still work.';
    case 'EnforcedPause':
      return contract === 'buyback'
        ? 'The buyback is paused, so it cannot spend. Governance restarts it by proposal.'
        : 'The staking pool is paused, so it takes no new stake. Exit requests, cancellations and claims stay open. Governance lifts a pause by proposal.';
    case 'NothingToClaim':
      return 'There is no spread to claim yet. It arrives when the credit pool pays it in.';
    case 'NotSlasher':
      return 'Only the slasher governance names can take stake, and this wallet is not it.';
    case 'NotKeeper':
      return 'Only the keeper governance names can trigger a buy, and this wallet is not the keeper.';
    case 'PriceCeilingUnset':
      return 'The buyback has no price ceiling, so it refuses every buy. Governance sets one by proposal.';
    case 'PriceCeilingStale':
      return `${at('The price ceiling went stale on', revert.args[0])}, so the buyback refuses every buy. Buys resume once governance sets it again.`;
    case 'TooSoon':
      return `${at('The last buy was too recent. The next one can run from', revert.args[0])}.`;
    case 'BelowMinimumSpend':
      return belowMinimum(revert);
    case 'NoStakeToDistributeTo':
      return 'No stake is earning in the pool, so a buy would have nobody to pay into. It can run once stake is earning again.';
    case 'MinimumOutNotMet':
      return 'This buy would have paid more than the price ceiling, so it was refused. Nothing was spent.';
    case 'ERC20InsufficientAllowance':
      return 'The staking contract is not allowed to move that much BRSR yet. Allow the amount first, then stake it.';
    case 'ERC20InsufficientBalance':
      return 'This wallet does not hold that much BRSR.';
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
    return 'There is too little to spend right now, so the buy was refused.';
  }
  return `A buy could spend ${usdExact(micro(available))} right now, and the minimum is ${usdExact(
    micro(minimum),
  )}. It can run once the balance or the window allows more.`;
}
