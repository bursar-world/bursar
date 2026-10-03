import { describe, expect, it } from 'vitest';
import { BaseError, RawContractError, decodeFunctionData, erc20Abi, toFunctionSelector } from 'viem';
import type { Hex } from 'viem';
import { agentRegistryAbi, deployment } from '@bursar/core';

import { CallRefusedError, InvalidArgumentError } from '../src/errors.js';
import { usdg } from '../src/money.js';
import { provider } from '../src/provider.js';
import { ADDRESSES, fakeConnection, type ReadCall } from './helpers/fake-connection.js';

const NOW = 1_800_000_000n;
const AGENT = { name: 'render_farm', stake: 25_000_000n, registeredAt: NOW - 86_400n, active: true };
const CURVE = { baseCap: 25_000_000n, capPerScore: 1_000_000n, maxCap: 250_000_000n };
const WEIGHTS = { minScored: 1_000_000n, edgeCap: 62_500_000n, fullCredit: 250_000_000n };
const PAYER = '0x00000000000000000000000000000000000000B1';
const OTHER_PAYER = '0x00000000000000000000000000000000000000b2';

function answers(overrides: Record<string, unknown> = {}) {
  return (call: ReadCall): unknown => {
    if (call.functionName in overrides) return overrides[call.functionName];

    switch (call.functionName) {
      case 'registry':
        return ADDRESSES.agentRegistry;
      case 'reputation':
        return ADDRESSES.reputation;
      case 'settlementAsset':
        return ADDRESSES.settlementAsset;
      case 'getAgent':
        return AGENT;
      case 'isRegistered':
        return true;
      case 'isActive':
        return true;
      case 'isBlacklisted':
        return false;
      case 'minStake':
        return 5_000_000n;
      case 'maxSlash':
        return 2_500_000n;
      case 'stakeOf':
        return 25_000_000n;
      case 'withdrawals':
        return [0n, 0n];
      case 'WITHDRAWAL_DELAY':
        return 604_800n;
      case 'paused':
        return false;
      case 'payeeStats':
        return [9n, 0n, 1n];
      case 'score':
        return 90;
      case 'capOf':
        return 115_000_000n;
      case 'curve':
        return CURVE;
      case 'weights':
        return WEIGHTS;
      case 'creditOf':
        return 250_000_000n;
      case 'edgeVolume':
        return 0n;
      case 'allowance':
        return 2n ** 255n;
      default:
        return undefined;
    }
  };
}

/** The error a call threw, typed as one, so a suite can read three fields off it. */
async function failureOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }

  throw new Error('the call was expected to fail');
}

async function client(options: Parameters<typeof fakeConnection>[0] = {}) {
  const fake = fakeConnection({ read: answers(), blockTimestamp: NOW, ...options });

  return { ...fake, provider: await provider(fake.connection) };
}

describe('a provider getting listed and staying listed', () => {
  it('opens against the registry the escrow reads, and names the asset a stake is in', async () => {
    const { provider: desk } = await client();

    expect(desk.address).toBe(ADDRESSES.agentRegistry);
    expect(desk.stakeAsset).toBe(ADDRESSES.settlementAsset);
    expect(desk.reputation).toBe(ADDRESSES.reputation);
  });

  it('reports the collateral posted and what one ruling could take from it', async () => {
    const status = await (await client()).provider.status();

    expect(status.registered).toBe(true);
    expect(status.active).toBe(true);
    expect(status.stake).toBe(25_000_000n);
    expect(status.minStake).toBe(5_000_000n);
    expect(status.maxSlash).toBe(2_500_000n);
    expect(status.withdrawal).toBeNull();
    expect(status.next).toContain('25.00 USDG of collateral posted');
    expect(status.next).toContain('2.50 USDG of it at risk');
  });

  it('tells an unlisted address what listing costs and that the collateral is at risk', async () => {
    const { provider: desk } = await client({
      read: answers({ isRegistered: false, isActive: false, getAgent: { ...AGENT, name: '', stake: 0n, registeredAt: 0n, active: false } }),
    });

    const status = await desk.status();

    expect(status.registered).toBe(false);
    expect(status.next).toContain('at least 5.00 USDG of collateral');
    expect(status.next).toContain('at risk');
    expect(status.next).not.toMatch(/yield|interest|earn/iu);
  });

  it('says a deactivated provider still has its collateral posted and slashable', async () => {
    const { provider: desk } = await client({
      read: answers({ getAgent: { ...AGENT, active: false }, isActive: false }),
    });

    expect((await desk.status()).next).toContain('still posted and still slashable');
  });

  it('names when a withdrawal matures and that it stays slashable until it leaves', async () => {
    const { provider: desk } = await client({
      read: answers({ withdrawals: [10_000_000n, NOW] }),
    });

    const status = await desk.status();

    expect(status.withdrawal?.amount).toBe(10_000_000n);
    expect(status.withdrawal?.maturesAt.toISOString()).toBe(new Date(Number(NOW + 604_800n) * 1000).toISOString());
    expect(status.next).toContain('stays slashable until it leaves');
  });

  it('approves the registry for exactly the stake when the signer has not, then registers', async () => {
    const { provider: desk, sent, account } = await client({ read: answers({ allowance: 0n }) });

    await desk.register({ name: 'render_farm', stake: 25_000_000n as never });

    expect(sent.map((transaction) => transaction.to)).toEqual([ADDRESSES.settlementAsset, ADDRESSES.agentRegistry]);
    const approval = decodeFunctionData({ abi: erc20Abi, data: sent[0]?.data ?? '0x' });
    expect(approval.functionName).toBe('approve');
    expect(approval.args).toEqual([ADDRESSES.agentRegistry, 25_000_000n]);
    expect(decodeFunctionData({ abi: agentRegistryAbi, data: sent[1]?.data ?? '0x' }).args).toEqual([
      'render_farm',
      25_000_000n,
    ]);
    expect(account.address).toBeDefined();
  });

  it('refuses a name outside 3 to 32 letters, digits and underscores before anything is sent', async () => {
    const { provider: desk, sent } = await client({ read: answers({ allowance: 0n }) });

    for (const name of ['ab', 'render farm', 'render-farm', 'r'.repeat(33), 'réndér']) {
      await expect(desk.register({ name, stake: 25_000_000n as never })).rejects.toBeInstanceOf(InvalidArgumentError);
    }
    expect(sent).toHaveLength(0);
  });

  it('encodes every step of the lifecycle against the registry', async () => {
    const { provider: desk, sent } = await client();

    await desk.register({ name: 'render_farm', stake: 25_000_000n as never });
    await desk.addStake(5_000_000n as never);
    await desk.requestWithdrawal(10_000_000n as never);
    await desk.cancelWithdrawal();
    await desk.executeWithdrawal();
    await desk.deactivate();
    await desk.reactivate();

    expect(
      sent.map((transaction) => decodeFunctionData({ abi: agentRegistryAbi, data: transaction.data }).functionName),
    ).toEqual([
      'register',
      'addStake',
      'requestWithdrawal',
      'cancelWithdrawal',
      'executeWithdrawal',
      'deactivate',
      'reactivate',
    ]);
    expect(sent.every((transaction) => transaction.to === ADDRESSES.agentRegistry)).toBe(true);
  });

  /** The registry refuses a handle carrying invisible characters, and so does this, for free. */
  it('refuses a name the registry would reject, before it costs a transaction', async () => {
    const { provider: desk, sent } = await client();

    await expect(desk.register({ name: 'ok', stake: 25_000_000n as never })).rejects.toThrow(InvalidArgumentError);
    await expect(desk.register({ name: 'rend\u202Eer', stake: 25_000_000n as never })).rejects.toThrow(
      /letters, digits and underscore/u,
    );
    expect(sent).toHaveLength(0);
  });
});

describe('the history a provider earns and the ceiling it buys', () => {
  it('reports the score, the counts behind it and the cap it earns', async () => {
    const reputation = await (await client()).provider.reputationOf();

    expect(reputation.score).toBe(90);
    expect(reputation.released).toBe(9n);
    expect(reputation.disputed).toBe(1n);
    expect(reputation.settled).toBe(10n);
    expect(reputation.cap).toBe(115_000_000n);
    expect(reputation.maxCap).toBe(250_000_000n);
    expect(reputation.next).toContain('9 of 10 counted jobs were released');
    expect(reputation.next).toContain('so it scores 90 of 100');
    expect(reputation.next).toContain('115.00 USDG');
    expect(reputation.next).toContain('Finalising a release is what records it');
  });

  it('says a new provider starts at the floor of the curve rather than at nothing', async () => {
    const { provider: desk } = await client({
      read: answers({ payeeStats: [0n, 0n, 0n], score: 0, capOf: 25_000_000n, creditOf: 0n }),
    });

    const reputation = await desk.reputationOf();

    expect(reputation.settled).toBe(0n);
    expect(reputation.next).toContain('No jobs have settled');
    expect(reputation.next).toContain('at most 25.00 USDG');
    expect(reputation.next).toContain('a full score takes 250.00 USDG');
  });
});

/**
 * From v4 a score is paid for in settled volume from more than one payer, so a record with every
 * job delivered can still sit a long way under 100. The reading has to say which of the two it is.
 */
describe('the credit behind a score', () => {
  it('reports the credit earned and the weights it is measured by', async () => {
    const { provider: desk } = await client({
      read: answers({ payeeStats: [2n, 0n, 0n], score: 25, capOf: 50_000_000n, creditOf: 62_500_000n }),
    });

    const reputation = await desk.reputationOf();

    expect(reputation.credit).toBe(usdg('62.5'));
    expect(reputation.weights).toEqual({ minScored: usdg('1'), edgeCap: usdg('62.5'), fullCredit: usdg('250') });
  });

  it('says a clean record scores 25 because a quarter of the credit is earned', async () => {
    const { provider: desk } = await client({
      read: answers({ payeeStats: [2n, 0n, 0n], score: 25, capOf: 50_000_000n, creditOf: 62_500_000n }),
    });

    const { next } = await desk.reputationOf();

    expect(next).toContain('2 of 2 counted jobs were released');
    expect(next).toContain('62.50 USDG of the 250.00 USDG of credit a full score takes, so it scores 25 of 100');
    expect(next).toContain('each payer for up to 62.50 USDG of credit');
    expect(next).toContain('A job of 1.00 USDG or more counts');
  });

  it('counts credit past the top as full, and leaves the price of a point out once it is paid', async () => {
    const { provider: desk } = await client({ read: answers({ creditOf: 900_000_000n }) });

    const { next } = await desk.reputationOf();

    expect(next).toContain('9 of 10 counted jobs were released');
    expect(next).toContain('250.00 USDG of the 250.00 USDG of credit');
    expect(next).not.toContain('each payer for up to');
  });

  it('reads what one payer has released to a provider, uncapped', async () => {
    const { provider: desk, reads, account } = await client({ read: answers({ edgeVolume: 72_500_000n }) });

    expect(await desk.edgeVolume(PAYER)).toBe(usdg('72.5'));
    expect(reads.find((read) => read.functionName === 'edgeVolume')).toMatchObject({
      address: ADDRESSES.reputation,
      args: [PAYER, account.address],
    });
  });

  it('projects recording two releases from one payer to 25 and 81.25, as the contract would', async () => {
    const { provider: desk } = await client({
      read: answers({ payeeStats: [0n, 0n, 0n], creditOf: 0n, curve: { ...CURVE, capPerScore: 2_250_000n } }),
    });

    const projection = await desk.projectReleases([
      { payer: PAYER, amount: usdg('25') },
      { payer: PAYER, amount: usdg('47.5') },
    ]);

    expect(projection.score).toBe(25);
    expect(projection.cap).toBe(usdg('81.25'));
    expect(projection.credit).toBe(usdg('62.5'));
  });

  it('starts a projection from the volume each payer has already released', async () => {
    const volumes: Record<string, bigint> = { [PAYER]: 80_000_000n, [OTHER_PAYER]: 0n };
    const base = answers({ payeeStats: [3n, 1n, 0n], creditOf: 100_000_000n, curve: { ...CURVE, capPerScore: 2_250_000n } });
    const { provider: desk, reads } = await client({
      read: (call) => (call.functionName === 'edgeVolume' ? volumes[String(call.args[0])] : base(call)),
    });

    const projection = await desk.projectReleases([
      { payer: PAYER, amount: usdg('50') },
      { payer: OTHER_PAYER, amount: usdg('50') },
      { payer: PAYER, amount: usdg('5') },
    ]);

    // The first payer is past its cap, so only the second payer's 50 is new credit.
    expect(projection.credit).toBe(usdg('150'));
    expect(projection.score).toBe(51);
    expect(reads.filter((read) => read.functionName === 'edgeVolume')).toHaveLength(2);
  });
});

/**
 * The record deployed before the audit keeps counts and weighs nothing: its reputation contract
 * has no `weights`, no `creditOf` and no `edgeVolume`, and asking it for one reverts.
 */
describe('a deployment from before v4', () => {
  async function earlier(overrides: Record<string, unknown> = {}) {
    const fake = fakeConnection({
      read: (call) => {
        if (['weights', 'creditOf', 'edgeVolume'].includes(call.functionName)) return undefined;
        return answers(overrides)(call);
      },
      blockTimestamp: NOW,
    });
    const escrow = deployment('rhc-mainnet-v3').contracts.Escrow;
    const connection = { ...fake.connection, addresses: { ...fake.connection.addresses, escrow } };

    return { ...fake, provider: await provider(connection) };
  }

  it('is read by the set its escrow belongs to', async () => {
    expect((await earlier()).provider.contractSet).toBe('v3');
    expect((await client()).provider.contractSet).toBe('v4');
  });

  it('reports the score as the released share, with no credit and no weights', async () => {
    const { provider: desk, reads } = await earlier();

    const reputation = await desk.reputationOf();

    expect(reputation.score).toBe(90);
    expect(reputation.credit).toBeNull();
    expect(reputation.weights).toBeNull();
    expect(reputation.next).toContain('90 of every 100 settled jobs');
    expect(reads.some((read) => ['weights', 'creditOf'].includes(read.functionName))).toBe(false);
  });

  it('answers no volume for a payer, and never a zero', async () => {
    expect(await (await earlier()).provider.edgeVolume(PAYER)).toBeNull();
  });

  it('projects on the released share alone', async () => {
    const { provider: desk } = await earlier({ payeeStats: [1n, 1n, 0n] });

    const projection = await desk.projectReleases([{ payer: PAYER, amount: usdg('0.01') }]);

    expect(projection.score).toBe(66);
    expect(projection.credit).toBeUndefined();
    expect(projection.cap).toBe(usdg('91'));
  });
});

describe('what a provider is told when the registry says no', () => {
  async function refusalFor(
    data: Hex,
    call: (desk: Awaited<ReturnType<typeof client>>['provider']) => Promise<unknown>,
  ): Promise<Error> {
    const { provider: desk } = await client({
      simulate: () => {
        throw new BaseError('execution reverted', { cause: new RawContractError({ data }) });
      },
    });

    return failureOf(call(desk));
  }

  /**
   * One error covers three different shortfalls and the fix is different for each, so the
   * sentence is chosen by what the provider was trying to do rather than by the error name.
   */
  it('tells a withdrawal that crossed the floor to take less or deactivate first', async () => {
    const failure = await refusalFor(toFunctionSelector('InsufficientStake()'), (desk) =>
      desk.requestWithdrawal(24_000_000n as never),
    );

    expect(failure).toBeInstanceOf(CallRefusedError);
    expect(failure.message).toContain('holds 25.00 USDG of collateral');
    expect(failure.message).toContain('keep at least 5.00 USDG');
    expect(failure.message).toContain('deactivate first');
  });

  it('tells a registration that came up short what listing costs', async () => {
    const failure = await refusalFor(toFunctionSelector('InsufficientStake()'), (desk) =>
      desk.register({ name: 'render_farm', stake: 1_000_000n as never }),
    );

    expect(failure.message).toContain('at least 5.00 USDG of collateral');
    expect(failure.message).toContain('Nothing was staked');
  });

  it('names the maturity on a withdrawal taken too early, and why the delay exists', async () => {
    const { provider: desk } = await client({
      read: answers({ withdrawals: [10_000_000n, NOW] }),
      simulate: () => {
        throw new BaseError('execution reverted', {
          cause: new RawContractError({ data: toFunctionSelector('WithdrawalNotMatured()') }),
        });
      },
    });

    const failure = await failureOf(desk.executeWithdrawal());

    expect(failure.message).toContain(new Date(Number(NOW + 604_800n) * 1000).toISOString());
    expect(failure.message).toContain('7d delay');
    expect(failure.message).toContain('between a bad job and the ruling on it');
  });

  it('says a barred address is barred and who lifts it', async () => {
    const failure = await refusalFor(toFunctionSelector('IsBlacklisted()'), (desk) => desk.reactivate());

    expect(failure.message).toContain('barred from the registry');
    expect(failure.message).toContain("registry’s admin");
  });

  it('says a paused registry admits nothing new but does not hold matured collateral', async () => {
    const failure = await refusalFor(toFunctionSelector('EnforcedPause()'), (desk) =>
      desk.addStake(1_000_000n as never),
    );

    expect(failure.message).toContain('paused');
    expect(failure.message).toContain('already matured is unaffected');
  });
});
