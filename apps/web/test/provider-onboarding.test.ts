import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import type { ProviderRecord, RegistryTerms, WithdrawalRequest } from '@/app/(app)/providers/desk';
import {
  capAtScore,
  creditLine,
  deactivateGate,
  nameProblem,
  reactivateGate,
  registrationGate,
  registryTermLines,
  topUpGate,
  withdrawalCancelGate,
  withdrawalExecuteGate,
  withdrawalRequestGate,
} from '@/app/(app)/providers/registry';
import type { Gate, RegistryFacts } from '@/app/(app)/providers/registry';

/**
 * A provider could not become payable at all through this product: `AgentRegistry`'s whole staking
 * lifecycle had no client. These hold the client to the contract.
 *
 * Every branch below is a revert `AgentRegistry` can produce. The gate exists so a payee meets the
 * condition in a sentence instead of in a failed transaction they paid for, which means the two
 * have to agree: a gate that says ready where the contract says `InsufficientStake` is worse than
 * no gate, because it spends somebody's fee to be wrong. And a reading that never landed is not a
 * condition that passed. `unread` is its own answer and it keeps the control off.
 *
 * Read from chain 4663 on 2026-09-22: minimum stake 5 USDG, a single ruling capped at 1000 bps,
 * seven days between asking for a stake and taking it.
 */
const MIN_STAKE = micro(5_000_000n);
const DAY = 86_400;
const NOW = new Date('2026-09-22T12:00:00.000Z');

function facts(over: Partial<RegistryFacts> = {}): RegistryFacts {
  return {
    registered: true,
    active: true,
    barred: false,
    paused: false,
    stake: micro(10_000_000n),
    minStake: MIN_STAKE,
    balance: micro(50_000_000n),
    allowance: micro(50_000_000n),
    withdrawal: null,
    ...over,
  };
}

function pending(over: Partial<WithdrawalRequest> = {}): WithdrawalRequest {
  const requestedAt = new Date(NOW.getTime() - DAY * 1000);
  return {
    amount: micro(3_000_000n),
    requestedAt,
    maturesAt: new Date(requestedAt.getTime() + 7 * DAY * 1000),
    matured: false,
    ...over,
  };
}

function reason(gate: Gate): string {
  return gate.kind === 'blocked' ? gate.reason : gate.kind === 'unread' ? `unread: ${gate.missing}` : gate.kind;
}

describe('a handle the registry would take', () => {
  it('accepts letters, digits and underscore', () => {
    expect(nameProblem('acme_transcribe_01')).toBeUndefined();
  });

  it('says nothing about a field nobody has typed in yet', () => {
    expect(nameProblem('')).toBeUndefined();
  });

  it('refuses the characters the contract refuses, and names the reason it refuses them', () => {
    expect(nameProblem('acme transcribe')).toContain('Letters, digits and underscores only');
    expect(nameProblem('acme-transcribe')).toBeDefined();
    expect(nameProblem('acme.co')).toBeDefined();
  });

  /**
   * The contract checks `bytes(name).length` first and the character set second, so two emoji are
   * eight bytes and pass its length check. Reporting the length first would send somebody off to
   * add a third emoji to a handle that can never be accepted.
   */
  it('names the character set for a handle that is short in characters and long in bytes', () => {
    expect(nameProblem('🙂🙂')).toContain('Letters, digits and underscores only');
  });

  it('holds the registry length bounds', () => {
    expect(nameProblem('ab')).toContain('At least 3');
    expect(nameProblem('a'.repeat(32))).toBeUndefined();
    expect(nameProblem('a'.repeat(33))).toContain('At most 32');
  });
});

describe('registering', () => {
  const form = { name: 'acme_transcribe', stake: 5_000_000n };

  it('is ready with a handle, the minimum stake and an allowance that covers it', () => {
    expect(registrationGate(facts({ registered: false }), form)).toEqual({ kind: 'ready' });
  });

  it('asks for the approval first when the registry may not move the stake yet', () => {
    const gate = registrationGate(facts({ registered: false, allowance: micro(0n) }), form);
    expect(gate).toEqual({ kind: 'approve', amount: 5_000_000n });
  });

  it('refuses a stake under the registry minimum rather than letting the wallet find out', () => {
    const gate = registrationGate(facts({ registered: false }), { ...form, stake: 4_999_999n });
    expect(reason(gate)).toContain('Below the minimum stake');
  });

  it('refuses a stake the address cannot pay for', () => {
    const gate = registrationGate(facts({ registered: false, balance: micro(1_000_000n) }), form);
    expect(reason(gate)).toContain('More USDG than this wallet holds');
  });

  it('sends an address that is already listed to the top-up instead', () => {
    expect(reason(registrationGate(facts(), form))).toContain('already listed');
  });

  it('names governance as the owner of a barred address, because nothing on the page clears it', () => {
    const gate = registrationGate(facts({ registered: false, barred: true }), form);
    expect(reason(gate)).toContain('Only governance can lift that');
  });

  it('says the registry is closed rather than blaming the form', () => {
    const gate = registrationGate(facts({ registered: false, paused: true }), form);
    expect(reason(gate)).toContain('paused');
  });

  it('holds the control when the minimum could not be read, instead of assuming zero', () => {
    const gate = registrationGate(facts({ registered: false, minStake: undefined }), form);
    expect(gate).toEqual({ kind: 'unread', missing: 'the stake the registry asks for' });
  });

  it('holds the control when the allowance could not be read, instead of assuming none', () => {
    const gate = registrationGate(facts({ registered: false, allowance: undefined }), form);
    expect(gate.kind).toBe('unread');
  });

  it('asks for a handle before it asks for anything else', () => {
    expect(reason(registrationGate(facts({ registered: false }), { ...form, name: '' }))).toContain('Choose a handle');
  });
});

describe('adding to a stake', () => {
  it('takes any amount, because the minimum binds on registration and not on a top-up', () => {
    expect(topUpGate(facts(), 1n)).toEqual({ kind: 'ready' });
  });

  it('asks for the approval when the registry may not move that much', () => {
    expect(topUpGate(facts({ allowance: micro(500_000n) }), 1_000_000n)).toEqual({ kind: 'approve', amount: 1_000_000n });
  });

  it('refuses before the wallet opens when the address is not listed', () => {
    expect(reason(topUpGate(facts({ registered: false }), 1_000_000n))).toContain('not listed yet');
  });

  it('refuses an empty field', () => {
    expect(reason(topUpGate(facts(), undefined))).toContain('Enter an amount');
  });
});

describe('asking to take a stake out', () => {
  it('is ready for an amount that leaves the minimum behind', () => {
    expect(withdrawalRequestGate(facts(), 5_000_000n)).toEqual({ kind: 'ready' });
  });

  /** `requestWithdrawal` reverts `InsufficientStake` when an active agent drops under the floor. */
  it('refuses to strip a listed address under the floor, and says what to do instead', () => {
    const gate = withdrawalRequestGate(facts(), 6_000_000n);
    expect(reason(gate)).toContain('Stop taking work to withdraw all of it');
  });

  it('lets a stopped address take the whole stake', () => {
    expect(withdrawalRequestGate(facts({ active: false }), 10_000_000n)).toEqual({ kind: 'ready' });
  });

  it('refuses more than the registry holds', () => {
    expect(reason(withdrawalRequestGate(facts(), 11_000_000n))).toContain('More than the stake held');
  });

  it('refuses a second request while one is waiting, which is what the contract does', () => {
    const gate = withdrawalRequestGate(facts({ withdrawal: pending() }), 1_000_000n);
    expect(reason(gate)).toContain('One request at a time');
  });

  it('holds the control when the stake could not be read', () => {
    expect(withdrawalRequestGate(facts({ stake: undefined }), 1_000_000n).kind).toBe('unread');
  });
});

describe('taking a matured stake, and cancelling one that is not', () => {
  it('waits while the clock is running, and says so rather than dimming a button', () => {
    expect(reason(withdrawalExecuteGate(facts({ withdrawal: pending() })))).toContain('waiting period has not ended');
  });

  it('is ready once the request has matured', () => {
    expect(withdrawalExecuteGate(facts({ withdrawal: pending({ matured: true }) }))).toEqual({ kind: 'ready' });
  });

  it('says nothing was asked for when nothing was', () => {
    expect(reason(withdrawalExecuteGate(facts()))).toContain('No withdrawal has been requested');
  });

  it('separates a request that is not there from one nobody could read', () => {
    expect(withdrawalExecuteGate(facts({ withdrawal: undefined })).kind).toBe('unread');
    expect(withdrawalExecuteGate(facts({ withdrawal: null })).kind).toBe('blocked');
  });

  /** The delay is a live parameter, so a request whose maturity is unknown is not a matured one. */
  it('does not offer to take a stake whose maturity could not be read', () => {
    const gate = withdrawalExecuteGate(facts({ withdrawal: pending({ maturesAt: null, matured: undefined }) }));
    expect(gate).toEqual({ kind: 'unread', missing: 'how long the wait is' });
  });

  it('cancels whatever is waiting, matured or not', () => {
    expect(withdrawalCancelGate(facts({ withdrawal: pending() }))).toEqual({ kind: 'ready' });
    expect(withdrawalCancelGate(facts({ withdrawal: pending({ matured: true }) }))).toEqual({ kind: 'ready' });
  });
});

describe('stopping and starting', () => {
  it('stops an address that is taking work', () => {
    expect(deactivateGate(facts())).toEqual({ kind: 'ready' });
  });

  it('says an address is already stopped rather than sending a call that reverts NotActive', () => {
    expect(reason(deactivateGate(facts({ active: false })))).toContain('Already stopped');
  });

  it('starts a stopped address whose stake still clears the floor', () => {
    expect(reactivateGate(facts({ active: false }))).toEqual({ kind: 'ready' });
  });

  it('refuses to start one whose stake fell under the floor, and names the fix', () => {
    const gate = reactivateGate(facts({ active: false, stake: micro(1_000_000n) }));
    expect(reason(gate)).toContain('Top it up');
  });

  it('refuses to start a barred address', () => {
    expect(reason(reactivateGate(facts({ active: false, barred: true })))).toContain('barred');
  });

  it('refuses to start while the registry is paused, because reactivate is gated on the pause', () => {
    expect(reason(reactivateGate(facts({ active: false, paused: true })))).toContain('paused');
  });

  it('holds both controls when the registry did not answer whether the address is taking work', () => {
    expect(deactivateGate(facts({ active: undefined })).kind).toBe('unread');
    expect(reactivateGate(facts({ active: undefined })).kind).toBe('unread');
  });
});

/**
 * The curve is the price list on finishing a job rather than letting it run out, so it has to read
 * the same on screen as it does in `Reputation.capOf`.
 *
 * Chain 4663, 2026-09-22: 25 USDG at a score of nothing, 1 USDG a point, 250 USDG ceiling.
 */
describe('what a score is worth', () => {
  const record = {
    released: 0n,
    timedOut: 0n,
    disputed: 0n,
    score: 0,
    cap: micro(25_000_000n),
    baseCap: micro(25_000_000n),
    capPerScore: micro(1_000_000n),
    maxCap: micro(250_000_000n),
    credit: null,
    minScored: null,
    edgeCap: null,
    fullCredit: null,
  } satisfies ProviderRecord;

  it('matches capOf at the ends of the scale', () => {
    expect(capAtScore(record, 0)).toBe(25_000_000n);
    expect(capAtScore(record, 100)).toBe(125_000_000n);
  });

  it('clamps at the ceiling the way the contract does', () => {
    const steep = { ...record, capPerScore: micro(10_000_000n) } satisfies ProviderRecord;
    expect(capAtScore(steep, 100)).toBe(250_000_000n);
  });

  it('is undefined when the curve was not read, rather than a cap of zero', () => {
    expect(capAtScore({ ...record, baseCap: undefined }, 50)).toBeUndefined();
  });
});

/**
 * From v4 a point is paid for in delivered volume from more than one payer. The line a reader sees
 * before connecting has to say what counts, how much one payer can add and how many payers a full
 * score takes, and it has to keep an unread weighing apart from contracts that have none.
 */
describe('how a point is earned', () => {
  const weights = { minScored: micro(1_000_000n), edgeCap: micro(62_500_000n), fullCredit: micro(250_000_000n) };

  it('names the job that counts, the cap per payer and the fewest payers a full score takes', () => {
    expect(creditLine(weights)).toBe(
      'Score comes from delivered work. Jobs of $1.00 or more count, each payer adds up to $62.50 of credit, and a full ' +
        'score takes $250.00 of credit from at least 4 payers.',
    );
  });

  it('rounds the payers up when the cap does not divide the full credit', () => {
    expect(creditLine({ ...weights, edgeCap: micro(100_000_000n) })).toContain('from at least 3 payers.');
    expect(creditLine({ ...weights, edgeCap: micro(250_000_000n) })).toMatch(/of credit\.$/);
  });

  it('is null on contracts that weigh nothing, and undefined while unread', () => {
    expect(creditLine({ minScored: null, edgeCap: null, fullCredit: null })).toBeNull();
    expect(creditLine({ minScored: undefined, edgeCap: micro(1n), fullCredit: micro(2n) })).toBeUndefined();
  });
});

describe('the registry terms a reader sees before connecting anything', () => {
  const terms: RegistryTerms = {
    minStake: MIN_STAKE,
    slashBps: 1_000,
    maxSlashBps: 5_000,
    withdrawalDelay: 604_800n,
    baseCap: micro(25_000_000n),
    capPerScore: micro(1_000_000n),
    maxCap: micro(250_000_000n),
    minScored: null,
    edgeCap: null,
    fullCredit: null,
    paused: false,
    listed: 0n,
  };

  it('quotes the chain and not a constant in the copy', () => {
    const lines = registryTermLines(terms);
    expect(lines.creditLine).toBeNull();
    expect(lines.minStake).toBe('$5.00');
    expect(lines.slashBps).toBe('10%');
    expect(lines.withdrawalDelay).toBe('7 days');
    expect(lines.curveLine).toContain('$25.00');
    expect(lines.curveLine).toContain('$250.00');
  });

  it('leaves a figure the registry did not answer undefined, so the page can say it was not read', () => {
    const lines = registryTermLines({ ...terms, minStake: undefined, baseCap: undefined });
    expect(lines.minStake).toBeUndefined();
    expect(lines.curveLine).toBeUndefined();
  });

  it('says nothing about a pause that is off, and says so when it is on', () => {
    expect(registryTermLines(terms).pausedLine).toBeUndefined();
    expect(registryTermLines({ ...terms, paused: true }).pausedLine).toContain('Listings reopen when governance unpauses it');
  });

  it('answers a reading that never happened without inventing one', () => {
    const lines = registryTermLines(undefined);
    expect(Object.values(lines).every((line) => line === undefined)).toBe(true);
  });
});

/** Guards the branded arithmetic: a stake compared against a balance in the wrong unit is silent. */
describe('amounts stay in micro-USD', () => {
  it('reads the registry minimum as five dollars and not five units', () => {
    const five: Micro = MIN_STAKE;
    expect(five).toBe(5_000_000n);
  });
});
