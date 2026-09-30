import { describe, expect, it } from 'vitest';
import { BaseError, RawContractError, encodeErrorResult, toFunctionSelector } from 'viem';
import type { Abi, AbiParameter, Address, Hex } from 'viem';
import {
  assetRegistryAbi,
  collateralVaultAbi,
  creditPoolAbi,
  parkAdapterAbi,
  priceGuardAbi,
  stockSpendRouterAbi,
  treasuryParkAbi,
} from '@bursar/core';

import { collateral } from '../src/collateral.js';
import { connect } from '../src/connection.js';
import { CallRefusedError, InsufficientFundsError, MandateDeniedError } from '../src/errors.js';
import { LANE_TABLES, laneRefusal, type LaneCall, type LaneContext } from '../src/lane-refusals.js';
import { mandateAccount } from '../src/mandate.js';
import { usdg } from '../src/money.js';
import { rwa } from '../src/rwa.js';
import { WindowKind } from '../src/types.js';
import { ADDRESSES, fakeConnection, type ReadCall } from './helpers/fake-connection.js';
import { LOCAL_RECORD } from './helpers/local-record.js';

const SPY = LOCAL_RECORD.rwa.assets.SPY.address;
const MANDATE: Address = '0x1234567890123456789012345678901234567890';
const PROVIDER: Address = '0x2222222222222222222222222222222222222222';
const CONTEXT: LaneContext = { symbolOf: (token) => (token === SPY ? 'SPY' : token) };

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
