import { describe, expect, it } from 'vitest';
import { BaseError, RawContractError, encodeErrorResult, toFunctionSelector } from 'viem';
import type { Abi, AbiParameter, Address, Hex } from 'viem';
import {
  DRAW_HALTS,
  assetRegistryAbi,
  collateralVaultAbi,
  creditPoolAbi,
  parkAdapterAbi,
  priceGuardAbi,
  stockSpendRouterAbi,
  treasuryParkAbi,
} from '@bursar/core';
import type { Chain, PublicClient, Transport } from 'viem';

import { collateral } from '../src/collateral.js';
import { connect } from '../src/connection.js';
import { CallRefusedError, InsufficientFundsError, MandateDeniedError } from '../src/errors.js';
import { LANE_TABLES, boundDraw, drawHaltRefusal, laneRefusal, type LaneCall, type LaneContext } from '../src/lane-refusals.js';
import { mandateAccount } from '../src/mandate.js';
import { usdg } from '../src/money.js';
import { rwa } from '../src/rwa.js';
import { WindowKind } from '../src/types.js';
import { ADDRESSES, fakeConnection, type ReadCall } from './helpers/fake-connection.js';
import { LOCAL_RECORD } from './helpers/local-record.js';

const SPY = LOCAL_RECORD.rwa.assets.SPY.address;
const NVDA = LOCAL_RECORD.rwa.assets.NVDA.address;
const MANDATE: Address = '0x1234567890123456789012345678901234567890';
const PROVIDER: Address = '0x2222222222222222222222222222222222222222';
const CONTEXT: LaneContext = { symbolOf: (token) => (token === SPY ? 'SPY' : token === NVDA ? 'NVDA' : token) };
const BOUNDS = { minAge: 300n, maxAge: 3_600n, maxFeedJumpBps: 1_500n };

type ErrorItem = { readonly type: 'error'; readonly name: string; readonly inputs: readonly AbiParameter[] };

function errorsOf(abi: Abi): readonly ErrorItem[] {
  return abi.filter((item): item is ErrorItem => item.type === 'error');
}

/** Arguments of the right type for every input, so a sentence that quotes them is exercised. */
function figuresFor(error: ErrorItem): unknown[] {
  return error.inputs.map((input) => {
    if (input.type === 'address') return SPY;
    if (input.type === 'uint8') return 0;
    return 1_250_000_000_000_000_000n;
  });
}

const CONTRACTS = [
  ['the stock router', stockSpendRouterAbi, LANE_TABLES.ROUTER, 'buy'],
  ['the price guard', priceGuardAbi, LANE_TABLES.GUARD, 'buy'],
  ['the asset registry', assetRegistryAbi, LANE_TABLES.ASSETS, 'buy'],
  ['the treasury park', treasuryParkAbi, LANE_TABLES.PARK, 'park'],
  ['a park adapter', parkAdapterAbi, LANE_TABLES.ADAPTER, 'park'],
  ['the collateral vault', collateralVaultAbi, LANE_TABLES.VAULT, 'vault'],
  ['the credit pool', creditPoolAbi, LANE_TABLES.POOL, 'repay'],
] as const satisfies readonly (readonly [string, Abi, object, LaneCall])[];

/**
 * The tables are keyed by the error names in the deployed ABIs, so an error added to a contract is
 * a compile error until someone writes its sentence. This asserts the same at runtime, which is
 * what catches an ABI regenerated without a rebuild of this package.
 */
describe.each(CONTRACTS)('what %s says no for', (_label, abi, table, call) => {
  const errors = errorsOf(abi as Abi);

  it('has a sentence for every error the contract declares', () => {
    expect(errors.map((e) => e.name).filter((name) => !(name in table))).toEqual([]);
  });

  const cases = errors.map((error) => [error.name, error] as const);

  it.each(cases)('reads %s with its figures and without', (name, error) => {
    for (const args of [figuresFor(error), []]) {
      const refusal = laneRefusal({ errorName: name, args }, call, CONTEXT);

      expect(refusal?.code).toBe(name);
      expect(refusal?.message.length ?? 0).toBeGreaterThan(40);
      expect(refusal?.message).toMatch(/\.$/u);
      expect(refusal?.message).not.toMatch(/undefined|plain-language|\s{2}/u);
    }
  });
});

/**
 * No revert carries a draw halt. The vault answers one per asset, as a number, and the table is
 * keyed by the guard's names for them, so a member added to the enum is a compile error here until
 * someone writes its sentence.
 */
describe('why a draw counts nothing for a position', () => {
  const halts = DRAW_HALTS.filter((halt) => halt !== 'None');

  it('has a sentence for every condition the price guard declares', () => {
    expect(halts.filter((halt) => !(halt in LANE_TABLES.DRAW_HALT))).toEqual([]);
  });

  it.each(halts.map((halt) => [halt] as const))('reads %s with the guard’s bounds and without', (halt) => {
    for (const bounds of [BOUNDS, undefined]) {
      const refusal = drawHaltRefusal(halt, SPY, CONTEXT, bounds);

      expect(refusal?.code).toBe(halt);
      expect(refusal?.message).toMatch(/^SPY counts for nothing toward a draw/u);
      expect(refusal?.message).toMatch(/\.$/u);
      expect(refusal?.message).not.toMatch(/undefined|\s{2}/u);
    }
  });

  it('answers nothing while the draw counts the position, and for a number this build does not know', () => {
    expect(drawHaltRefusal('None', SPY, CONTEXT)).toBeNull();
    expect(drawHaltRefusal(0, SPY, CONTEXT)).toBeNull();
    expect(drawHaltRefusal(42, SPY, CONTEXT)).toBeNull();
  });

  it('reads the number the vault answers as the condition it stands for', () => {
    expect(drawHaltRefusal(4, SPY, CONTEXT)?.code).toBe('NoObservation');
    expect(drawHaltRefusal(8, SPY, CONTEXT)?.code).toBe('SpotOffBand');
  });

  it('says what clears a missing reading, and who may send it', () => {
    const refusal = drawHaltRefusal('NoObservation', SPY, CONTEXT, BOUNDS);

    expect(refusal?.message).toContain('a reading taken at least 5m earlier');
    expect(refusal?.message).toContain('a second call 5m later puts it in force');
    expect(refusal?.message).toContain('Anyone may send both.');
    expect(refusal?.owner).toBe('caller');
  });

  it('quotes how old a reading may be and how far the feed may move', () => {
    expect(drawHaltRefusal('ObservationExpired', SPY, CONTEXT, BOUNDS)?.message).toContain('more than 1h old');
    expect(drawHaltRefusal('FeedJump', SPY, CONTEXT, BOUNDS)?.message).toContain('moved more than 15% since');
    expect(drawHaltRefusal('FeedJump', SPY, CONTEXT, { ...BOUNDS, maxFeedJumpBps: 1_250n })?.message).toContain('12.5%');
  });

  it('puts the positions a health check could not count into its sentence', () => {
    const refusal = laneRefusal(
      {
        errorName: 'HealthTooLow',
        args: [
          1_104_000_000_000_000_000n,
          1_250_000_000_000_000_000n,
          [
            { asset: SPY, halt: 'NoObservation' },
            { asset: NVDA, halt: 'SpotOffBand' },
          ],
          BOUNDS,
        ],
      },
      'vault',
      CONTEXT,
    );

    expect(refusal?.message).toMatch(/^This would leave the line’s health at 1\.10, under the 1\.25/u);
    expect(refusal?.message).toContain('SPY counts for nothing toward a draw yet');
    expect(refusal?.message).toContain('NVDA counts for nothing toward a draw right now: its pool trades outside');
    expect(refusal?.message).toContain('The same call may pass once SPY and NVDA count again.');
    expect(refusal?.message).not.toContain('whose price is stale or paused');
  });
});

/**
 * Reading what a health check left out, against the vault. A vault from before v4 has no
 * `drawHalt` and the refusal stands as it came; one that answers `None` for every position held is
 * a line that is short of collateral, and the refusal stands as well.
 */
describe('reading a refused draw against the vault', () => {
  const VAULT: Address = LOCAL_RECORD.rwa.collateral.CollateralVault;
  const HEALTH = { errorName: 'HealthTooLow', args: [1_104_000_000_000_000_000n, 1_250_000_000_000_000_000n] } as const;
  const position = (asset: Address, raw: bigint) => ({ asset, tier: 2, raw, priceE8: 0n, updatedAt: 0n, fresh: true, haircutBps: 0, value: 0n, adjusted: 0n });

  function vaultClient(answer: (functionName: string, args: readonly unknown[]) => unknown) {
    const reads: { functionName: string; args: readonly unknown[] }[] = [];
    const client = {
      readContract: async (call: { functionName: string; args?: readonly unknown[] }) => {
        reads.push({ functionName: call.functionName, args: call.args ?? [] });
        const value = answer(call.functionName, call.args ?? []);
        if (value === undefined) throw new Error(`no ${call.functionName}`);
        return value;
      },
    } as unknown as PublicClient<Transport, Chain>;
    return { client, reads };
  }

  it('names each held position the draw rule holds out, with the guard’s bounds', async () => {
    const { client, reads } = vaultClient((fn, args) => {
      if (fn === 'positions') return [position(SPY, 10n), position(NVDA, 0n), position(LOCAL_RECORD.rwa.assets.SGOV.address, 5n)];
      if (fn === 'drawHalt') return args[0] === SPY ? 4 : 0;
      if (fn === 'guard') return '0x9999999999999999999999999999999999999999';
      if (fn === 'MIN_OBSERVATION_AGE') return 300n;
      if (fn === 'MAX_OBSERVATION_AGE') return 3_600n;
      if (fn === 'MAX_FEED_JUMP_BPS') return 1_500n;
      return undefined;
    });

    const bound = await boundDraw(HEALTH, { client, vault: VAULT, mandate: MANDATE });

    expect(bound.args[2]).toEqual([{ asset: SPY, halt: 'NoObservation' }]);
    expect(bound.args[3]).toEqual(BOUNDS);
    // An empty position is never asked about.
    expect(reads.filter((read) => read.functionName === 'drawHalt').map((read) => read.args[0])).toEqual([SPY, LOCAL_RECORD.rwa.assets.SGOV.address]);
  });

  it('leaves the refusal as it came when every held position counts', async () => {
    const { client } = vaultClient((fn) => (fn === 'positions' ? [position(SPY, 10n)] : fn === 'drawHalt' ? 0 : undefined));

    expect(await boundDraw(HEALTH, { client, vault: VAULT, mandate: MANDATE })).toBe(HEALTH);
  });

  it('leaves the refusal as it came on a vault with no draw rule to read', async () => {
    const { client } = vaultClient((fn) => (fn === 'positions' ? [position(SPY, 10n)] : undefined));

    expect(await boundDraw(HEALTH, { client, vault: VAULT, mandate: MANDATE })).toBe(HEALTH);
  });

  it('carries the positions without the bounds when the guard cannot be read', async () => {
    const { client } = vaultClient((fn) => (fn === 'positions' ? [position(SPY, 10n)] : fn === 'drawHalt' ? 7 : undefined));

    const bound = await boundDraw(HEALTH, { client, vault: VAULT, mandate: MANDATE });

    expect(bound.args[2]).toEqual([{ asset: SPY, halt: 'FeedJump' }]);
    expect(bound.args[3]).toBeUndefined();
    expect(laneRefusal(bound, 'vault', CONTEXT)?.message).toContain('further since the price guard’s last reading');
  });

  it('touches nothing for a refusal that is not a health check', async () => {
    const { client, reads } = vaultClient(() => undefined);
    const other = { errorName: 'NoLine', args: [MANDATE] };

    expect(await boundDraw(other, { client, vault: VAULT, mandate: MANDATE })).toBe(other);
    expect(reads).toEqual([]);
  });
});

describe('the figures a refusal quotes', () => {
  it('says how far over the per-trade cap a purchase is', () => {
    const refusal = laneRefusal({ errorName: 'TradeCapExceeded', args: [30_000_000n, 25_000_000n] }, 'buy', CONTEXT);

    expect(refusal?.message).toMatch(/^This purchase of 30\.00 USDG is over the 25\.00 USDG the registry allows/u);
  });

  it('names the stale feed, its age and the bound', () => {
    const refusal = laneRefusal({ errorName: 'StalePrice', args: [SPY, 97_200n, 93_600n] }, 'buy', CONTEXT);

    expect(refusal?.message).toMatch(
      /^The SPY feed last answered 1d 3h ago, and a trade needs an answer no older than 1d 2h\./u,
    );
    expect(refusal?.owner).toBe('clock');
  });

  it('quotes the pool and the feed a trade was refused between', () => {
    const refusal = laneRefusal(
      { errorName: 'PoolPriceDeviation', args: [SPY, 78_500_000_000n, 77_121_266_423n] },
      'buy',
      CONTEXT,
    );

    expect(refusal?.message).toContain('The SPY pool trades at 785.00 USD and its feed reads 771.21 USD');
  });

  it('writes health as a ratio', () => {
    const refusal = laneRefusal(
      { errorName: 'HealthTooLow', args: [1_104_000_000_000_000_000n, 1_250_000_000_000_000_000n] },
      'spend',
      CONTEXT,
    );

    expect(refusal?.message).toMatch(/^This would leave the line’s health at 1\.10, under the 1\.25/u);
  });

  it('reads one name as the contract the call reaches', () => {
    const figures = [14_000_000n, 10_000_000n];

    expect(laneRefusal({ errorName: 'MandateCapExceeded', args: figures }, 'park', CONTEXT)?.message).toMatch(
      /^Parking this would bring what the mandate holds in the fund to 14\.00 USDG/u,
    );
    expect(laneRefusal({ errorName: 'MandateCapExceeded', args: figures }, 'spend', CONTEXT)?.message).toMatch(
      /^This draw would bring the mandate’s debt to 14\.00 USDG, over the 10\.00 USDG/u,
    );
  });

  it('answers nothing for a name no contract on the call declares', () => {
    expect(laneRefusal({ errorName: 'DailyCapExceeded', args: [] }, 'buy', CONTEXT)).toBeNull();
    expect(laneRefusal({ errorName: 'StalePrice', args: [] }, 'repay', CONTEXT)).toBeNull();
  });
});

const LIMITS = {
  perCallCap: 10_000_000n,
  dailyCap: 50_000_000n,
  monthlyCap: 200_000_000n,
  dailyWindow: 86_400n,
  monthlyWindow: 2_592_000n,
  approvalThreshold: 20_000_000n,
  validFrom: 0n,
  validUntil: 0n,
  classMask: 3,
  totalCap: 0n,
  lane: 1,
};

const WINDOW = { cap: 50_000_000n, spent: 0n, duration: 86_400n, start: 1_800_000_000n, epoch: 0n };

function answers(overrides: Record<string, unknown> = {}) {
  return (call: ReadCall): unknown => {
    if (call.functionName in overrides) return overrides[call.functionName];

    switch (call.functionName) {
      case 'escrow':
        return ADDRESSES.escrow;
      case 'settlementAsset':
        return ADDRESSES.settlementAsset;
      case 'minTtl':
        return 60n;
      case 'maxTtl':
        return 86_400n;
      case 'minLock':
        return 10_000n;
      case 'reputation':
        return ADDRESSES.reputation;
      case 'registry':
        return ADDRESSES.agentRegistry;
      case 'limits':
        return LIMITS;
      case 'remaining':
        return [10_000_000n, 50_000_000n, 200_000_000n];
      case 'window':
        return { ...WINDOW, cap: call.args[0] === WindowKind.Daily ? 50_000_000n : 200_000_000n };
      case 'balanceOf':
        return 3_000_000n;
      case 'tradePrice':
        return 77_121_266_423n;
      case 'minOutFor':
        return 6_000_000_000_000_000n;
      case 'buffer':
        return 20_000_000n;
      case 'vaultOf':
        return '0x7777777777777777777777777777777777777777';
      case 'position':
        return [0n, 0n, 0n, 0n, 0n, false];
      case 'totalBasis':
        return 0n;
      case 'caps':
        return [100_000_000n, 1_000_000_000n];
      case 'vault':
        return LOCAL_RECORD.rwa.collateral.CollateralVault;
      case 'positions':
        return [{ asset: SPY, tier: 2, raw: 10n, priceE8: 0n, updatedAt: 0n, fresh: false, haircutBps: 0, value: 0n, adjusted: 0n }];
      case 'drawHalt':
        return 6;
      case 'guard':
        return '0x9999999999999999999999999999999999999999';
      case 'MIN_OBSERVATION_AGE':
        return 300n;
      case 'MAX_OBSERVATION_AGE':
        return 3_600n;
      case 'MAX_FEED_JUMP_BPS':
        return 1_500n;
      default:
        return undefined;
    }
  };
}

function reverting(data: Hex) {
  return () => {
    throw new BaseError('execution reverted', { cause: new RawContractError({ data }) });
  };
}

/** A mandate on the local record, over a fake node that answers `read` and reverts with `simulate`. */
async function onLocal(options: Parameters<typeof fakeConnection>[0] = {}) {
  const fake = fakeConnection({ read: answers(), ...options });
  const connection = { ...fake.connection, deployment: connect({ deployment: LOCAL_RECORD }).deployment };
  return { ...fake, mandate: await mandateAccount(MANDATE, connection) };
}

async function failureOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }

  throw new Error('the call was expected to fail');
}

describe('a refused purchase', () => {
  it('reads the router’s refusal, with the asset by name', async () => {
    const data = encodeErrorResult({ abi: stockSpendRouterAbi, errorName: 'AssetNotAllowed', args: [SPY] });
    const { mandate, sent } = await onLocal({ simulate: reverting(data) });

    const failure = await failureOf(rwa(mandate).buy('SPY', usdg('5')));

    expect(failure).toBeInstanceOf(CallRefusedError);
    expect((failure as CallRefusedError).errorName).toBe('AssetNotAllowed');
    expect(failure.message).toMatch(/^SPY is not on this mandate’s purchase list/u);
    expect(sent).toHaveLength(0);
  });

  it('quotes the mandate’s own limit the way pay does', async () => {
    const { mandate } = await onLocal({ simulate: reverting(toFunctionSelector('ClassNotAllowed()')) });

    const failure = await failureOf(rwa(mandate).buy('SPY', usdg('5')));

    expect(failure).toBeInstanceOf(MandateDeniedError);
    expect((failure as MandateDeniedError).reason).toBe('class-not-allowed');
  });

  it('says a purchase at the approval threshold cannot carry an approval', async () => {
    const { mandate } = await onLocal({ simulate: reverting(toFunctionSelector('ApprovalRequired()')) });

    const failure = await failureOf(rwa(mandate).buy('SPY', usdg('20')));

    expect(failure.message).toContain('approval threshold of 20.00 USDG');
    expect(failure.message).toContain('setLimits');
  });

  it('reads a quote refused by the price guard, rather than handing back the decoding error', async () => {
    const stale = encodeErrorResult({ abi: priceGuardAbi, errorName: 'StalePrice', args: [SPY, 97_200n, 93_600n] });
    const read = answers();
    const { mandate } = await onLocal({
      read: (call) => {
        if (call.functionName === 'tradePrice') reverting(stale)();
        return read(call);
      },
    });

    const failure = await failureOf(rwa(mandate).buy('SPY', usdg('5')));

    expect(failure).toBeInstanceOf(CallRefusedError);
    expect(failure.message).toMatch(/^The SPY feed last answered 1d 3h ago/u);
  });
});

describe('a refused draw on credit', () => {
  it('reads the vault’s health check inside pay', async () => {
    const data = encodeErrorResult({
      abi: collateralVaultAbi,
      errorName: 'HealthTooLow',
      args: [1_104_000_000_000_000_000n, 1_250_000_000_000_000_000n],
    });
    const { mandate } = await onLocal({ simulate: reverting(data) });

    const failure = await failureOf(mandate.pay({ to: PROVIDER, amount: usdg('8'), capability: 'gpu.render:1' }));

    expect(failure).toBeInstanceOf(CallRefusedError);
    expect((failure as CallRefusedError).errorName).toBe('HealthTooLow');
    expect(failure.message).toContain('health at 1.10, under the 1.25');
  });

  // The fake vault holds SPY out of every draw with ObservationOffBand, so the refusal names the
  // position the check could not count instead of the general rule.
  it('says which position the health check could not count, and why', async () => {
    const data = encodeErrorResult({
      abi: collateralVaultAbi,
      errorName: 'HealthTooLow',
      args: [1_104_000_000_000_000_000n, 1_250_000_000_000_000_000n],
    });
    const { mandate, reads } = await onLocal({ simulate: reverting(data) });

    const failure = await failureOf(mandate.pay({ to: PROVIDER, amount: usdg('8'), capability: 'gpu.render:1' }));

    expect((failure as CallRefusedError).errorName).toBe('HealthTooLow');
    expect(failure.message).toContain('SPY counts for nothing toward a draw right now: at the price guard’s last reading its pool traded outside its band');
    expect(failure.message).toContain('and again 5m later.');
    expect(failure.message).toContain('The same call may pass once SPY counts again.');
    expect(reads.find((read) => read.functionName === 'drawHalt')).toMatchObject({
      address: LOCAL_RECORD.rwa.collateral.CollateralVault,
      args: [SPY],
    });
  });

  it('says the same for a withdrawal the vault refused on health', async () => {
    const data = encodeErrorResult({
      abi: collateralVaultAbi,
      errorName: 'HealthTooLow',
      args: [1_000_000_000_000_000_000n, 1_250_000_000_000_000_000n],
    });
    const { mandate } = await onLocal({ simulate: reverting(data) });

    const failure = await failureOf(collateral(mandate).withdraw('SPY', 1n, PROVIDER));

    expect((failure as CallRefusedError).errorName).toBe('HealthTooLow');
    expect(failure.message).toContain('SPY counts for nothing toward a draw right now');
  });

  it('reads the pool’s total cap as the pool’s, not as the mandate’s total budget', async () => {
    const data = encodeErrorResult({
      abi: creditPoolAbi,
      errorName: 'TotalCapExceeded',
      args: [104_000_000n, 100_000_000n],
    });
    const { mandate } = await onLocal({ simulate: reverting(data) });

    const failure = await failureOf(mandate.pay({ to: PROVIDER, amount: usdg('8'), capability: 'gpu.render:1' }));

    expect(failure).not.toBeInstanceOf(MandateDeniedError);
    expect(failure.message).toMatch(
      /^This draw would bring what the pool has lent across every mandate to 104\.00 USDG/u,
    );
  });

  /**
   * The pool checks its cash before its two caps, so `InsufficientCash` is what comes back whenever
   * the pool is short, even for a draw a cap refuses anyway. The reading names the limit that holds
   * however much the pool is lent.
   */
  describe('names the limit that bound a draw the pool was short for', () => {
    const SHORT = encodeErrorResult({
      abi: creditPoolAbi,
      errorName: 'InsufficientCash',
      args: [5_000_000n, 9_000_000n],
    });

    function pool(debt: bigint, lent: bigint) {
      return answers({ debtOf: debt, perMandateCap: 10_000_000n, totalDebt: lent, totalDebtCap: 100_000_000n });
    }

    it('the mandate’s own cap, when the draw takes its debt past it', async () => {
      const { mandate, reads } = await onLocal({ simulate: reverting(SHORT), read: pool(5_000_000n, 5_000_000n) });

      const failure = await failureOf(mandate.pay({ to: PROVIDER, amount: usdg('9'), capability: 'gpu.render:1' }));

      expect((failure as CallRefusedError).errorName).toBe('MandateCapExceeded');
      expect(failure.message).toBe(
        'This draw would bring the mandate’s debt to 14.00 USDG, over the 10.00 USDG one mandate may owe the ' +
          'pool. Repay some of it, or spend less on credit.',
      );
      expect(reads.find((read) => read.functionName === 'debtOf')).toMatchObject({
        address: LOCAL_RECORD.rwa.collateral.CreditPool,
        args: [MANDATE],
      });
    });

    it('the pool’s total, when the mandate has room and the pool is lent out to its cap', async () => {
      const { mandate } = await onLocal({ simulate: reverting(SHORT), read: pool(0n, 95_000_000n) });

      const failure = await failureOf(mandate.pay({ to: PROVIDER, amount: usdg('9'), capability: 'gpu.render:1' }));

      expect((failure as CallRefusedError).errorName).toBe('TotalCapExceeded');
      expect(failure.message).toMatch(
        /^This draw would bring what the pool has lent across every mandate to 104\.00 USDG, over the 100\.00 USDG/u,
      );
    });

    it('the pool’s cash, when neither cap is in the way', async () => {
      const { mandate } = await onLocal({ simulate: reverting(SHORT), read: pool(0n, 45_000_000n) });

      const failure = await failureOf(mandate.pay({ to: PROVIDER, amount: usdg('9'), capability: 'gpu.render:1' }));

      expect((failure as CallRefusedError).errorName).toBe('InsufficientCash');
      expect(failure.message).toMatch(/^The credit pool has 5\.00 USDG free to lend and this needs 9\.00 USDG\./u);
    });

    it('the pool’s own words, when its caps cannot be read', async () => {
      const { mandate } = await onLocal({ simulate: reverting(SHORT) });

      const failure = await failureOf(mandate.pay({ to: PROVIDER, amount: usdg('9'), capability: 'gpu.render:1' }));

      expect((failure as CallRefusedError).errorName).toBe('InsufficientCash');
    });

    it('the same way inside a purchase that draws', async () => {
      const { mandate } = await onLocal({ simulate: reverting(SHORT), read: pool(5_000_000n, 5_000_000n) });

      const failure = await failureOf(rwa(mandate).buy('SPY', usdg('9')));

      expect((failure as CallRefusedError).errorName).toBe('MandateCapExceeded');
      expect(failure.message).toMatch(/^This draw would bring the mandate’s debt to 14\.00 USDG/u);
    });
  });

  it('reads a repayment of a line that owes nothing', async () => {
    const data = encodeErrorResult({ abi: creditPoolAbi, errorName: 'NoDebt', args: [MANDATE] });
    const { mandate } = await onLocal({ simulate: reverting(data), read: answers({ allowance: 2n ** 255n }) });

    const failure = await failureOf(collateral(mandate).repay(usdg('1')));

    expect(failure.message).toBe(`Mandate ${MANDATE} owes the credit pool nothing, so there is nothing to repay.`);
  });
});

describe('parking', () => {
  it('refuses a park that would dip under the buffer before anything leaves the mandate', async () => {
    const { mandate, sent } = await onLocal({ read: answers({ balanceOf: 30_000_000n }) });

    const failure = await failureOf(rwa(mandate).park(usdg('15')));

    expect(failure).toBeInstanceOf(CallRefusedError);
    expect(failure.message).toMatch(/^After this move the mandate holds 15\.00 USDG, under the 20\.00 USDG/u);
    expect(sent).toHaveLength(0);
  });

  it('refuses a park over the fund’s per-mandate cap before anything leaves the mandate', async () => {
    const { mandate, sent } = await onLocal({ read: answers({ balanceOf: 200_000_000n }) });

    const failure = await failureOf(rwa(mandate).park(usdg('150')));

    expect(failure.message).toMatch(
      /^Parking this would bring what the mandate holds in the fund to 150\.00 USDG, over the 100\.00 USDG/u,
    );
    expect(sent).toHaveLength(0);
  });

  it('refuses a park the mandate cannot fund', async () => {
    const { mandate, sent } = await onLocal();

    await expect(rwa(mandate).park(usdg('50'))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(sent).toHaveLength(0);
  });
});
