import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';

import { formatDuration } from '@/lib';
import { bps, usd } from '@/money';

import type { ProviderDesk, ProviderRecord, RegistryTerms, WithdrawalRequest } from './desk';

/**
 * What the registry will do with a form, worked out before a wallet opens.
 *
 * Every branch below is a revert `AgentRegistry` can produce. Reaching them from a signed
 * transaction costs the payee a fee and tells them `0xe450d38c`; reaching them here costs nothing
 * and names the condition. The contract is still the authority, so nothing is asserted that it
 * does not check, and a reading that did not land never becomes a green control: `unread` is its
 * own answer and it keeps the button off.
 */
export type Gate =
  /** Nothing stands in the way. Send it. */
  | { readonly kind: 'ready' }
  /** The registry has to be allowed to move this much USDG first. */
  | { readonly kind: 'approve'; readonly amount: bigint }
  | { readonly kind: 'blocked'; readonly reason: string }
  /** Named in the words a reader would use, because the sentence quotes it. */
  | { readonly kind: 'unread'; readonly missing: string };

/** The registry readings the staking lifecycle turns on, lifted off a desk. */
export type RegistryFacts = {
  readonly registered: boolean | undefined;
  readonly active: boolean | undefined;
  readonly barred: boolean | undefined;
  readonly paused: boolean | undefined;
  readonly stake: Micro | undefined;
  readonly minStake: Micro | undefined;
  readonly balance: Micro | undefined;
  readonly allowance: Micro | undefined;
  readonly withdrawal: WithdrawalRequest | null | undefined;
};

export function factsOf(desk: ProviderDesk): RegistryFacts {
  const { standing } = desk;

  return {
    registered: standing.registered,
    active: standing.active,
    barred: standing.barred,
    paused: standing.registryPaused,
    stake: standing.stake,
    minStake: standing.minStake,
    balance: desk.balance,
    allowance: standing.allowance,
    withdrawal: standing.withdrawal,
  };
}

export const NAME_MIN_LENGTH = 3;
export const NAME_MAX_LENGTH = 32;

/**
 * Why the registry would refuse this handle, or undefined while it would take it.
 *
 * The character set is checked before the length, which is the reverse of the contract's order and
 * the right way round for a person: a handle of two emoji is eight bytes, so the contract's length
 * check passes it and the character check is what refuses it. Reporting the length first
 * would send somebody off to add a third emoji.
 */
export function nameProblem(raw: string): string | undefined {
  if (raw === '') return undefined;
  if (!/^[0-9A-Za-z_]*$/.test(raw)) {
    return 'Letters, digits and underscore only. The registry refuses the rest so one handle cannot be dressed up as another.';
  }
  if (raw.length < NAME_MIN_LENGTH) return `At least ${NAME_MIN_LENGTH} characters.`;
  if (raw.length > NAME_MAX_LENGTH) return `At most ${NAME_MAX_LENGTH} characters.`;
  return undefined;
}

export type RegistrationForm = {
  readonly name: string;
  /** Micro-USD, or undefined while the field does not read as an amount. */
  readonly stake: bigint | undefined;
};

export function registrationGate(facts: RegistryFacts, form: RegistrationForm): Gate {
  if (facts.barred === true) return { kind: 'blocked', reason: 'This address is barred from the registry. An operator clears that; nothing on this page can.' };
  if (facts.registered === true) return { kind: 'blocked', reason: 'This address is already listed. Add to the stake instead.' };
  if (facts.paused === true) return { kind: 'blocked', reason: 'The registry is paused and is taking no new listings. It reopens when an operator unpauses it.' };

  const unread = firstUnread([
    [facts.registered, 'whether this address is already listed'],
    [facts.barred, 'whether this address is barred'],
    [facts.paused, 'whether the registry is open'],
    [facts.minStake, 'the stake the registry asks for'],
  ]);
  if (unread) return unread;

  const problem = nameProblem(form.name);
  if (problem) return { kind: 'blocked', reason: problem };
  if (form.name === '') return { kind: 'blocked', reason: 'Choose a handle. It is a display name, not an identity: nothing in the protocol resolves it.' };

  return fundingGate(facts, form.stake, facts.minStake);
}

/** Topping up. The registry cancels any pending withdrawal when it lands, which the copy says. */
export function topUpGate(facts: RegistryFacts, amount: bigint | undefined): Gate {
  if (facts.registered === false) return { kind: 'blocked', reason: 'This address is not listed yet. Register first.' };
  if (facts.barred === true) return { kind: 'blocked', reason: 'This address is barred from the registry, so it takes no more stake.' };
  if (facts.paused === true) return { kind: 'blocked', reason: 'The registry is paused and is taking no stake. It reopens when an operator unpauses it.' };

  const unread = firstUnread([
    [facts.registered, 'whether this address is listed'],
    [facts.barred, 'whether this address is barred'],
    [facts.paused, 'whether the registry is open'],
  ]);
  if (unread) return unread;

  return fundingGate(facts, amount, undefined);
}

/** Asking to take stake out. Step one of three. */
export function withdrawalRequestGate(facts: RegistryFacts, amount: bigint | undefined): Gate {
  if (facts.registered === false) return { kind: 'blocked', reason: 'This address is not listed, so it has no stake to take out.' };
  if (facts.paused === true) return { kind: 'blocked', reason: 'The registry is paused. A request already matured can still be taken; a new one waits for the unpause.' };
  if (facts.withdrawal) return { kind: 'blocked', reason: 'One request at a time. Cancel the one waiting, or take it once it matures.' };

  const unread = firstUnread([
    [facts.registered, 'whether this address is listed'],
    [facts.paused, 'whether the registry is open'],
    [facts.withdrawal, 'whether a request is already waiting'],
    [facts.stake, 'the stake held for this address'],
    [facts.minStake, 'the stake the registry asks for'],
    [facts.active, 'whether this address is taking work'],
  ]);
  if (unread) return unread;

  if (amount === undefined || amount <= 0n) return { kind: 'blocked', reason: 'Enter an amount.' };

  const stake = facts.stake as Micro;
  const floor = facts.minStake as Micro;
  if (amount > stake) return { kind: 'blocked', reason: 'More than the registry holds for this address.' };

  if (facts.active === true && stake - amount < floor) {
    return {
      kind: 'blocked',
      reason: 'A listed address has to leave the minimum behind. Stop taking work first, then the whole stake can go.',
    };
  }

  return { kind: 'ready' };
}

/** Step three. Open while the registry is paused: a matured request is the payee's own money. */
export function withdrawalExecuteGate(facts: RegistryFacts): Gate {
  if (facts.withdrawal === undefined) return { kind: 'unread', missing: 'whether a request is waiting' };
  if (facts.withdrawal === null) return { kind: 'blocked', reason: 'Nothing has been asked for.' };
  if (facts.withdrawal.matured === undefined) return { kind: 'unread', missing: 'how long the wait is' };
  if (!facts.withdrawal.matured) return { kind: 'blocked', reason: 'The wait is still running.' };
  return { kind: 'ready' };
}

export function withdrawalCancelGate(facts: RegistryFacts): Gate {
  if (facts.withdrawal === undefined) return { kind: 'unread', missing: 'whether a request is waiting' };
  if (facts.withdrawal === null) return { kind: 'blocked', reason: 'Nothing has been asked for.' };
  return { kind: 'ready' };
}

export function deactivateGate(facts: RegistryFacts): Gate {
  if (facts.registered === false) return { kind: 'blocked', reason: 'This address is not listed.' };
  if (facts.active === false) return { kind: 'blocked', reason: 'Already stopped. No payer can open a lock against this address.' };

  const unread = firstUnread([
    [facts.registered, 'whether this address is listed'],
    [facts.active, 'whether this address is taking work'],
  ]);
  if (unread) return unread;

  return { kind: 'ready' };
}

export function reactivateGate(facts: RegistryFacts): Gate {
  if (facts.registered === false) return { kind: 'blocked', reason: 'This address is not listed.' };
  if (facts.active === true) return { kind: 'blocked', reason: 'Already taking work.' };
  if (facts.barred === true) return { kind: 'blocked', reason: 'This address is barred from the registry. An operator clears that; nothing on this page can.' };
  if (facts.paused === true) return { kind: 'blocked', reason: 'The registry is paused, so it is admitting nobody. It reopens when an operator unpauses it.' };

  const unread = firstUnread([
    [facts.registered, 'whether this address is listed'],
    [facts.active, 'whether this address is taking work'],
    [facts.barred, 'whether this address is barred'],
    [facts.paused, 'whether the registry is open'],
    [facts.stake, 'the stake held for this address'],
    [facts.minStake, 'the stake the registry asks for'],
  ]);
  if (unread) return unread;

  if ((facts.stake as Micro) < (facts.minStake as Micro)) {
    return { kind: 'blocked', reason: 'The stake is under the minimum. Top it up first.' };
  }

  return { kind: 'ready' };
}

/**
 * The part every stake-moving call shares: an amount, a balance to pay it from, and an allowance
 * for the registry to pull it with. `floor` is the registry's minimum where one binds, which is
 * registration and nothing else; a top-up of any size is accepted.
 */
function fundingGate(facts: RegistryFacts, amount: bigint | undefined, floor: Micro | undefined): Gate {
  const unread = firstUnread([
    [facts.balance, 'the USDG this address holds'],
    [facts.allowance, 'what the registry may already move from this address'],
  ]);
  if (unread) return unread;

  if (amount === undefined || amount <= 0n) return { kind: 'blocked', reason: 'Enter an amount.' };
  if (floor !== undefined && amount < floor) return { kind: 'blocked', reason: 'Under the minimum the registry asks for.' };
  if (amount > (facts.balance as Micro)) return { kind: 'blocked', reason: 'More USDG than this address holds.' };
  if (amount > (facts.allowance as Micro)) return { kind: 'approve', amount };

  return { kind: 'ready' };
}

function firstUnread(readings: readonly (readonly [unknown, string])[]): Gate | undefined {
  for (const [value, missing] of readings) {
    if (value === undefined) return { kind: 'unread', missing };
  }
  return undefined;
}

/**
 * The cap a given score earns, from the curve the reputation contract publishes.
 *
 * `capOf` on chain is `min(baseCap + capPerScore * score, maxCap)`. Repeating it here is what lets
 * the panel show what a score is worth before a payee has earned it, which is what turns the curve
 * from a formula into a reason to finish the next job.
 */
export function capAtScore(record: ProviderRecord, score: number): Micro | undefined {
  if (record.baseCap === undefined || record.capPerScore === undefined || record.maxCap === undefined) return undefined;

  const cap = record.baseCap + record.capPerScore * BigInt(Math.max(0, Math.round(score)));
  return micro(cap > record.maxCap ? record.maxCap : cap);
}

/**
 * The registry's terms as sentences, with an unread figure left undefined rather than rendered as
 * a zero. Every line here is a chain reading, so the page that shows them is never quoting a
 * constant somebody typed into the copy.
 */
export type RegistryTermLines = {
  readonly minStake: string | undefined;
  readonly slashBps: string | undefined;
  readonly withdrawalDelay: string | undefined;
  readonly baseCap: string | undefined;
  readonly curveLine: string | undefined;
  readonly pausedLine: string | undefined;
};

export function registryTermLines(terms: RegistryTerms | undefined): RegistryTermLines {
  if (terms === undefined) {
    return {
      minStake: undefined,
      slashBps: undefined,
      withdrawalDelay: undefined,
      baseCap: undefined,
      curveLine: undefined,
      pausedLine: undefined,
    };
  }

  const curveLine =
    terms.baseCap === undefined || terms.capPerScore === undefined || terms.maxCap === undefined
      ? undefined
      : `A payer may lock up to ${usd(terms.baseCap)} against a new payee, plus ${usd(terms.capPerScore)} for every score point, to a ceiling of ${usd(terms.maxCap)}.`;

  return {
    minStake: terms.minStake === undefined ? undefined : usd(terms.minStake),
    slashBps: terms.slashBps === undefined ? undefined : bps(terms.slashBps),
    withdrawalDelay: terms.withdrawalDelay === undefined ? undefined : formatDuration(Number(terms.withdrawalDelay)),
    baseCap: terms.baseCap === undefined ? undefined : usd(terms.baseCap),
    curveLine,
    pausedLine:
      terms.paused === undefined
        ? undefined
        : terms.paused
          ? 'The registry is paused and is taking no new listings. It reopens when an operator unpauses it.'
          : undefined,
  };
}
