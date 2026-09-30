import { collateralDeployment, micro } from '@bursar/core';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';

import { ADDRESSES } from '@/chain';
import { TOKEN_ADDRESSES } from '@/chain/generated/token';
import {
  ADMIN_ACTIONS,
  GOVERNED,
  PAUSABLE,
  actionById,
  buildCall,
  emptyDraft,
  formatBps,
  formatUsdg,
  parseDecimal,
  pauseControllerOf,
  readCall,
} from '@/chain/admin-actions';
import type { AdminAction, AdminDraft } from '@/chain/admin-actions';

/**
 * The calldata builder is the point of the governance page.
 *
 * A signer approving a two-day change used to see a four-byte selector and a hex blob, which is a
 * change nobody read. Everything below holds the two halves together: what the form encodes and
 * what the card decodes are the same table, so a sentence under a pending proposal cannot describe
 * something other than the call it was built from.
 */

/**
 * The two proposals live on chain 4663 on 2026-09-22, read back with cast. The staking pool is
 * whichever one the address book names, so the reading holds after the pool is replaced.
 */
const AGENT_REGISTRY = '0x4a9e90F15c0FEC02f7592C6E618cd3B64076035b' as Address;
const STAKING = TOKEN_ADDRESSES.Staking;
const ACCEPT_ADMIN_CALLDATA = '0x0e18b681' as Hex;
const SET_TIERS_CALLDATA =
  '0xe2058f5f0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000054b40b1f852bda0000000000000000000000000000000000000000000000000000000000000000001f400000000000000000000000000000000000000000000152d02c7e14af680000000000000000000000000000000000000000000000000000000000000000003e80000000000000000000000000000000000000000000069e10de76676d080000000000000000000000000000000000000000000000000000000000000000007d000000000000000000000000000000000000000000002116545850052128000000000000000000000000000000000000000000000000000000000000000000bb8' as Hex;

function fill(action: AdminAction, values: Record<string, string>, rows: Record<string, string>[] = []): AdminDraft {
  return { ...emptyDraft(action), values, ...(rows.length > 0 ? { rows } : {}) };
}

function action(id: string): AdminAction {
  const found = actionById(id);
  if (!found) throw new Error(`no action ${id}`);
  return found;
}

describe('the two proposals live on chain right now', () => {
  it('reads proposal 0 as taking administration of the registry, not as a selector', () => {
    const reading = readCall(AGENT_REGISTRY, ACCEPT_ADMIN_CALLDATA);

    expect(reading.recognised).toBe(true);
    expect(reading.functionName).toBe('acceptAdmin');
    expect(reading.targetName).toBe('the provider registry');
    expect(reading.sentence).toContain('Takes administration of the provider registry');
    expect(reading.sentence).not.toContain('0x0e18b681');
  });

  it('reads proposal 1 as the four rebate rungs it writes', () => {
    const reading = readCall(STAKING, SET_TIERS_CALLDATA);

    expect(reading.recognised).toBe(true);
    expect(reading.functionName).toBe('setTiers');
    expect(reading.signature).toBe('setTiers((uint256,uint16)[])');
    expect(reading.sentence).toContain('4 rungs');
    expect(reading.sentence).toContain('25,000 BRSR for 5%');
    expect(reading.sentence).toContain('100,000 BRSR for 10%');
    expect(reading.sentence).toContain('500,000 BRSR for 20%');
    expect(reading.sentence).toContain('2,500,000 BRSR for 30%');
  });

  it('lists every rung as its own row, so nothing is hidden behind a count', () => {
    expect(readCall(STAKING, SET_TIERS_CALLDATA).rows).toHaveLength(4);
  });

  it('rebuilds proposal 1 byte for byte from the form', () => {
    const built = buildCall(action('staking.setTiers'), {
      values: {},
      rows: [
        { minStake: '25000', rebateBps: '500' },
        { minStake: '100000', rebateBps: '1000' },
        { minStake: '500000', rebateBps: '2000' },
        { minStake: '2500000', rebateBps: '3000' },
      ],
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.data).toBe(SET_TIERS_CALLDATA);
    expect(built.target.toLowerCase()).toBe(STAKING.toLowerCase());
  });
});

describe('an unrecognised call', () => {
  it('says the hex is the whole story rather than inventing a description', () => {
    const reading = readCall('0x000000000000000000000000000000000000dEaD' as Address, '0xdeadbeef' as Hex);

    expect(reading.recognised).toBe(false);
    expect(reading.sentence).toContain('this build does not recognise');
    expect(reading.sentence).toContain('the whole story');
    expect(reading.rows).toEqual([]);
  });

  it('still names the contract when the target is one this build knows', () => {
    const reading = readCall(ADDRESSES.escrow, '0xdeadbeef' as Hex);

    expect(reading.recognised).toBe(false);
    expect(reading.targetName).toBe('the escrow');
    expect(reading.selector).toBe('0xdeadbeef');
  });
});

describe('the builder refuses what the contract refuses', () => {
  it('refuses a cap curve whose ceiling is under its floor', () => {
    const built = buildCall(action('reputation.setCurve'), fill(action('reputation.setCurve'), { baseCap: '250', capPerScore: '1', maxCap: '25' }));

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.join(' ')).toContain('ceiling cannot be below');
  });

  it('accepts a curve whose ceiling a perfect score reaches', () => {
    const built = buildCall(action('reputation.setCurve'), fill(action('reputation.setCurve'), { baseCap: '25', capPerScore: '2.25', maxCap: '250' }));

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(readCall(ADDRESSES.reputation, built.data).sentence).toContain('25 USDG at a score of zero');
  });

  it('refuses a ceiling no score reaches, which reputation would publish and never pay', () => {
    const built = buildCall(action('reputation.setCurve'), fill(action('reputation.setCurve'), { baseCap: '25', capPerScore: '1', maxCap: '250' }));

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.join(' ')).toContain('No score reaches that ceiling');
  });

  it('refuses tiers that do not ascend in both columns', () => {
    const built = buildCall(action('staking.setTiers'), {
      values: {},
      rows: [
        { minStake: '25000', rebateBps: '1000' },
        { minStake: '100000', rebateBps: '500' },
      ],
    });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.join(' ')).toContain('rebate has to be above rung 1');
  });

  it('refuses a rebate above half the fee', () => {
    const built = buildCall(action('staking.setTiers'), { values: {}, rows: [{ minStake: '25000', rebateBps: '6000' }] });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.join(' ')).toContain('above 5000');
  });

  it('refuses a dispute bond that matures before the windows it voted in close', () => {
    const built = buildCall(
      action('oracleRegistry.setConfig'),
      fill(action('oracleRegistry.setConfig'), {
        commitWindow: '21600',
        revealWindow: '21600',
        unbondingPeriod: '3600',
        quorum: '2',
        maxVoters: '64',
        maxDeviation: '20',
        slashBps: '1000',
      }),
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.join(' ')).toContain('cover both windows');
  });

  const rules = (over: Record<string, string>) =>
    buildCall(
      action('oracleRegistry.setConfig'),
      fill(action('oracleRegistry.setConfig'), {
        commitWindow: '21600',
        revealWindow: '21600',
        unbondingPeriod: '604800',
        quorum: '2',
        maxVoters: '64',
        maxDeviation: '20',
        slashBps: '1000',
        ...over,
      }),
    );

  it('refuses a voter cap that would let the first resolvers to commit shut the rest out', () => {
    const built = rules({ maxVoters: '5' });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.join(' ')).toContain('seat the whole 64-resolver roster');
  });

  it('refuses a quorum above the roster, which no vote could reach', () => {
    const built = rules({ quorum: '65', maxVoters: '80' });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.join(' ')).toContain('Quorum cannot be above the 64-seat roster');
  });

  it('refuses a window under ten minutes', () => {
    const built = rules({ revealWindow: '300' });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.join(' ')).toContain('at least ten minutes');
  });

  it('encodes dispute rules that seat the whole roster and reads them back in words', () => {
    const built = rules({});

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const sentence = readCall(ADDRESSES.oracleRegistry, built.data).sentence;
    expect(sentence).toContain('6h to commit');
    expect(sentence).toContain('2 reveals needed with up to 64 resolvers voting');
    expect(sentence).toContain('10% of the bond slashed');
  });

  it('refuses a buyback floor above its own per-call target', () => {
    const built = buildCall(
      action('buyback.setParams'),
      fill(action('buyback.setParams'), {
        spendPerCallMicroUsd: '0.50',
        maxSpendPerWindowMicroUsd: '5.00',
        minSpendMicroUsd: '1.00',
        maxPriceMicroUsdPerBrsr: '0.05',
        window: '86400',
        minInterval: '3600',
      }),
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.join(' ')).toContain('floor cannot be above the per-call target');
  });

  it('says a zero price ceiling refuses every trade rather than leaving it as a number', () => {
    const built = buildCall(
      action('buyback.setParams'),
      fill(action('buyback.setParams'), {
        spendPerCallMicroUsd: '0.50',
        maxSpendPerWindowMicroUsd: '5.00',
        minSpendMicroUsd: '0.10',
        maxPriceMicroUsdPerBrsr: '0',
        window: '86400',
        minInterval: '3600',
      }),
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(readCall(built.target, built.data).sentence).toContain('price ceiling is zero, which refuses every trade');
  });

  it('refuses a staking exit wait under the contract floor', () => {
    const built = buildCall(action('staking.setUnbondingPeriod'), fill(action('staking.setUnbondingPeriod'), { period: '3600' }));

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.join(' ')).toContain('under seven days');
  });

  it('refuses a provider slash share above half the stake', () => {
    const built = buildCall(action('agentRegistry.setSlashBps'), fill(action('agentRegistry.setSlashBps'), { newSlashBps: '9000' }));

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.join(' ')).toContain('above 5000');
  });

  it('refuses an address that is not one', () => {
    const built = buildCall(action('staking.setCreditManager'), fill(action('staking.setCreditManager'), { account: 'the treasury' }));

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.join(' ')).toContain('not a 20-byte address');
  });

  it('allows the zero address where the contract does, and says what it means', () => {
    const zero = '0x0000000000000000000000000000000000000000';
    const cleared = (id: string, field: string) => {
      const built = buildCall(action(id), fill(action(id), { [field]: zero }));
      expect(built.ok, id).toBe(true);
      return built.ok ? readCall(built.target, built.data).sentence : '';
    };

    expect(cleared('staking.setCreditManager', 'account')).toContain('Clears the credit manager');
    expect(cleared('staking.setSlasher', 'account')).toContain('Clears the staking pool’s slasher');
    expect(cleared('buyback.setKeeper', 'keeper_')).toContain('Clears the buyback keeper');
    expect(cleared('agentRegistry.setSlasher', 'newSlasher')).toContain('Clears the second address');
  });

  it('collects every problem at once rather than one per attempt', () => {
    const built = buildCall(
      action('oracleRegistry.setConfig'),
      fill(action('oracleRegistry.setConfig'), {
        commitWindow: '',
        revealWindow: 'soon',
        unbondingPeriod: '604800',
        quorum: '2',
        maxVoters: '5',
        maxDeviation: '20',
        slashBps: '1000',
      }),
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.length).toBeGreaterThan(1);
  });
});

describe('the staking pool and buyback settings added with the exit pool and the keeper', () => {
  const PERSON = '0x000000000000000000000000000000000000bEEF';

  it('names a keeper as the only address that can trigger a buy', () => {
    const built = buildCall(action('buyback.setKeeper'), fill(action('buyback.setKeeper'), { keeper_: PERSON }));

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const reading = readCall(built.target, built.data);
    expect(reading.targetName).toBe('the buyback');
    expect(reading.sentence).toContain('the only address that can trigger a buy');
  });

  it('says a slasher other than the credit pool can take stake, held to the cap', () => {
    const built = buildCall(action('staking.setSlasher'), fill(action('staking.setSlasher'), { account: PERSON }));

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(readCall(built.target, built.data).sentence).toContain('the one address that can take stake, held to the slash cap');
  });

  it('writes the slash cap and its refill window, and refuses a cap of zero or a window out of range', () => {
    const built = buildCall(action('staking.setSlashLimit'), fill(action('staking.setSlashLimit'), { capBps: '1000', window: '604800' }));
    expect(built.ok).toBe(true);
    if (built.ok) expect(readCall(built.target, built.data).sentence).toContain('at most 10% of the staking pool');

    const zero = buildCall(action('staking.setSlashLimit'), fill(action('staking.setSlashLimit'), { capBps: '0', window: '604800' }));
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.problems.join(' ')).toContain('A cap of zero is refused');

    const short = buildCall(action('staking.setSlashLimit'), fill(action('staking.setSlashLimit'), { capBps: '1000', window: '3600' }));
    expect(short.ok).toBe(false);
  });

  it.each([
    ['staking.setUnbondWindow', 'window'],
    ['staking.setMaxExitHold', 'hold'],
    ['buyback.setMaxCeilingAge', 'age'],
  ])('holds %s between one and thirty days', (id, field) => {
    expect(buildCall(action(id), fill(action(id), { [field]: '3600' })).ok).toBe(false);
    expect(buildCall(action(id), fill(action(id), { [field]: '3000000' })).ok).toBe(false);
    expect(buildCall(action(id), fill(action(id), { [field]: '604800' })).ok).toBe(true);
  });

  it('reads an eviction as unseating the resolver and returning its bond', () => {
    const built = buildCall(action('oracleRegistry.evict'), fill(action('oracleRegistry.evict'), { resolver: PERSON }));

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const reading = readCall(built.target, built.data);
    expect(reading.targetName).toBe('the dispute registry');
    expect(reading.sentence).toContain('returns what is left of its bond');
  });
});

describe('amounts take the separator a person uses', () => {
  it('reads 25.000,50 and 25,000.50 as the same amount', () => {
    const european = parseDecimal('25.000,50', 6);
    const anglo = parseDecimal('25,000.50', 6);

    expect(european.ok && anglo.ok).toBe(true);
    if (!european.ok || !anglo.ok) return;
    expect(european.value).toBe(anglo.value);
    expect(european.value).toBe(25_000_500_000n);
  });

  it('refuses more decimal places than the asset holds', () => {
    const parsed = parseDecimal('1.0000001', 6);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toContain('At most 6 decimal places');
  });

  it('formats micro-USD and basis points the way the sentences read them', () => {
    expect(formatUsdg(micro(250_000_000n))).toBe('250 USDG');
    expect(formatBps(500n)).toBe('5%');
    expect(formatBps(1_050n)).toBe('10.50%');
  });
});

describe('the catalogue', () => {
  it('names a contract this build holds for every action', () => {
    for (const entry of ADMIN_ACTIONS) {
      expect(GOVERNED.some((contract) => contract.key === entry.contract)).toBe(true);
    }
  });

  it('carries no duplicate ids', () => {
    expect(new Set(ADMIN_ACTIONS.map((entry) => entry.id)).size).toBe(ADMIN_ACTIONS.length);
  });

  it('covers every setter the build plan names', () => {
    for (const id of [
      'reputation.setCurve',
      'oracleRegistry.setConfig',
      'agentRegistry.setMinStake',
      'staking.setTiers',
      'staking.setCreditManager',
      'staking.setSlasher',
      'staking.setSlashLimit',
      'staking.setUnbondWindow',
      'staking.setMaxExitHold',
      'buyback.setParams',
      'buyback.setKeeper',
      'buyback.setMaxCeilingAge',
      'oracleRegistry.evict',
      'agentRegistry.acceptAdmin',
    ]) {
      expect(actionById(id)).toBeDefined();
    }
  });

  it('offers an unpause for every contract the guardian can stop, and a pause for none of them', () => {
    for (const key of PAUSABLE) {
      expect(ADMIN_ACTIONS.some((entry) => entry.contract === key && entry.functionName === 'unpause')).toBe(true);
    }
    expect(ADMIN_ACTIONS.some((entry) => entry.functionName === 'pause')).toBe(false);
  });

  it('encodes every action that takes no argument', () => {
    for (const entry of ADMIN_ACTIONS.filter((candidate) => candidate.shape.kind === 'none')) {
      const built = buildCall(entry, emptyDraft(entry));
      expect(built.ok).toBe(true);
    }
  });
});

describe('the proposals on the token governance delay', () => {
  const STAKING_ADDRESS = TOKEN_ADDRESSES.Staking;

  it('reads proposal 10 as naming a credit manager on the staking pool', () => {
    const reading = readCall(STAKING_ADDRESS, '0x69dd793b000000000000000000000000c217af334e6eac06b774b5059b16257695937b0a');
    expect(reading.recognised).toBe(true);
    expect(reading.targetName).toBe('the staking pool');
    expect(reading.functionName).toBe('setCreditManager');
    expect(reading.sentence).toContain('credit manager');
  });

  // Built from whichever credit pool the address book names, so it holds before and after the
  // contracts the collateral lane runs on are replaced.
  it('says naming the lane’s credit pool pays its spread to stakers, and that the role takes no stake', () => {
    const pool = collateralDeployment(4663)?.CreditPool;
    if (pool === undefined) return;
    const built = buildCall(action('staking.setCreditManager'), fill(action('staking.setCreditManager'), { account: pool }));

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const sentence = readCall(built.target, built.data).sentence;
    expect(sentence).toContain('credit pool');
    expect(sentence).toContain('spread is paid to stakers');
    expect(action('staking.setCreditManager').consequence).toContain('It cannot take stake');
  });

  it('reads a per-resolver bond floor in BRSR', () => {
    const reading = readCall(
      STAKING_ADDRESS,
      '0x4ee6aa36000000000000000000000000d8d90e4c8f3419b1b8305df2905eb31d3fbbf59900000000000000000000000000000000000000000000054b40b1f852bda00000',
    );
    expect(reading.functionName).toBe('setBondFloor');
    expect(reading.sentence).toContain('25,000');
  });

  it('keeps finished handovers out of the builder', () => {
    expect(ADMIN_ACTIONS.filter((entry) => entry.functionName === 'acceptAdmin').every((entry) => entry.retired)).toBe(true);
  });

  it('knows the escrow answers its brake to a pauser, not an admin', () => {
    expect(PAUSABLE).toContain('escrow');
    expect(pauseControllerOf('escrow')).toBe('pauser');
    expect(pauseControllerOf('staking')).toBe('admin');
  });
});
