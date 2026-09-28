import { describe, expect, it } from 'vitest';
import { BaseError, RawContractError, decodeFunctionData, toFunctionSelector } from 'viem';
import type { Hex } from 'viem';
import { agentRegistryAbi } from '@bursar/core';

import { CallRefusedError, InvalidArgumentError } from '../src/errors.js';
import { provider } from '../src/provider.js';
import { ADDRESSES, fakeConnection, type ReadCall } from './helpers/fake-connection.js';

const NOW = 1_800_000_000n;
const AGENT = { name: 'render_farm', stake: 25_000_000n, registeredAt: NOW - 86_400n, active: true };
const CURVE = { baseCap: 25_000_000n, capPerScore: 1_000_000n, maxCap: 250_000_000n };

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
    await expect(desk.register({ name: 'rend‮er', stake: 25_000_000n as never })).rejects.toThrow(
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
    expect(reputation.next).toContain('90 of every 100 settled jobs');
    expect(reputation.next).toContain('115.00 USDG');
    expect(reputation.next).toContain('Finalizing a release is what records it');
  });

  it('says a new provider starts at the floor of the curve rather than at nothing', async () => {
    const { provider: desk } = await client({
      read: answers({ payeeStats: [0n, 0n, 0n], score: 0, capOf: 25_000_000n }),
    });

    const reputation = await desk.reputationOf();

    expect(reputation.settled).toBe(0n);
    expect(reputation.next).toContain('No jobs have settled');
    expect(reputation.next).toContain('at most 25.00 USDG');
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
