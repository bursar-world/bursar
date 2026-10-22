import { describe, expect, it } from 'vitest';
import {
  BaseError,
  RawContractError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  erc20Abi,
  zeroAddress,
} from 'viem';
import type { Address, Log } from 'viem';
import { endowmentAbi, endowmentFactoryAbi, micro } from '@bursar/core';

import { CallRefusedError, InvalidArgumentError, MissingEventError } from '../src/errors.js';
import { EndowmentClient, EndowmentFactoryClient, drawsInto } from '../src/endowment.js';
import { UnknownAssetError } from '../src/rwa.js';
import { fakeConnection } from './helpers/fake-connection.js';
import type { FakeOptions } from './helpers/fake-connection.js';

const FACTORY: Address = '0xb22Ff7d1f434C65feC0a0dcDA13Db65Db347C565';
const ENDOWMENT: Address = '0x3333333333333333333333333333333333333333';
const MANDATE: Address = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c';
const SPY: Address = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C';
const NVDA: Address = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';

const STATE = {
  agentId: 8756n,
  successorId: 0n,
  mandate: MANDATE,
  accepted: true,
  frozen: false,
  nav: 60_120_000n,
  navFresh: true,
  averageNav: 60_000_000n,
  drawPerYear: 2_400_000n,
  accrued: 591_780n,
  cash: 591_000n,
  sleeveTarget: 591_780n,
  given: 60_000_000n,
  unattributed: 0n,
  earned: 2_000_000n,
  earnedToPrincipal: 1_000_000n,
  drawn: 0n,
  fees: 0n,
  patrons: 3n,
  snapshotsTaken: 1n,
  createdAt: 1_800_000_000n,
  lastDrawAt: 1_800_000_000n,
  lastActive: 1_800_000_000n,
  unacceptedSince: 1_799_000_000n,
};

function log(address: Address, topics: readonly `0x${string}`[], data: `0x${string}`): Log {
  return { address, topics, data } as unknown as Log;
}

function on(options: FakeOptions = {}) {
  const fake = fakeConnection({ read: () => undefined, ...options });
  return { fake, endowment: new EndowmentClient(fake.connection, ENDOWMENT), factory: new EndowmentFactoryClient(fake.connection, FACTORY) };
}

function reverting(errorName: string, args: readonly unknown[] = []) {
  const data = encodeErrorResult({ abi: endowmentAbi, errorName, args } as Parameters<typeof encodeErrorResult>[0]);
  return () => {
    throw new BaseError('execution reverted', { cause: new RawContractError({ data }) });
  };
}

describe('an endowment', () => {
  it('reads its standing in plain units', async () => {
    const { endowment } = on({ read: (call) => (call.functionName === 'state' ? STATE : undefined) });

    const state = await endowment.state();

    expect(state).toMatchObject({
      agentId: 8756n,
      mandate: MANDATE,
      accepted: true,
      averageNav: micro(60_000_000n),
      drawPerYear: micro(2_400_000n),
      patrons: 3,
      snapshotsTaken: 1,
    });
    expect(state.createdAt.toISOString()).toBe('2027-01-15T08:00:00.000Z');
    expect(drawsInto(state, MANDATE)).toBe(true);
  });

  it('reads an unaccepted endowment as having no mandate and no draw yet', async () => {
    const { endowment } = on({
      read: (call) =>
        call.functionName === 'state' ? { ...STATE, mandate: zeroAddress, accepted: false, lastDrawAt: 0n, lastActive: 0n } : undefined,
    });

    const state = await endowment.state();

    expect(state.mandate).toBeUndefined();
    expect(state.lastDrawAt).toBeUndefined();
    expect(drawsInto(state, MANDATE)).toBe(false);
  });

  it('lists its holdings with their weights', async () => {
    const { endowment } = on({ read: (call) => (call.functionName === 'assets' ? [[SPY, NVDA], [7_000, 3_000]] : undefined) });

    expect(await endowment.assets()).toEqual([
      { asset: SPY, weightBps: 7_000 },
      { asset: NVDA, weightBps: 3_000 },
    ]);
  });

  it('approves the endowment for a gift when the allowance is short, then gives', async () => {
    const { fake, endowment } = on({ read: (call) => (call.functionName === 'allowance' ? 0n : undefined) });

    const result = await endowment.give(micro(5_000_000n));

    expect(result.approve).toBeDefined();
    expect(fake.sent).toHaveLength(2);
    expect(decodeFunctionData({ abi: erc20Abi, data: fake.sent[0]!.data })).toEqual({
      functionName: 'approve',
      args: [ENDOWMENT, 5_000_000n],
    });
    expect(fake.sent[1]?.to).toBe(ENDOWMENT);
    expect(decodeFunctionData({ abi: endowmentAbi, data: fake.sent[1]!.data })).toEqual({
      functionName: 'give',
      args: [5_000_000n],
    });
  });

  it('gives without an approval when the allowance covers it', async () => {
    const { fake, endowment } = on({ read: (call) => (call.functionName === 'allowance' ? 10_000_000n : undefined) });

    const result = await endowment.give(micro(5_000_000n));

    expect(result.approve).toBeUndefined();
    expect(fake.sent).toHaveLength(1);
  });

  it('refuses a gift of nothing before anything is sent', async () => {
    const { fake, endowment } = on();
    await expect(endowment.give(micro(0n))).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(fake.sent).toHaveLength(0);
  });

  it('draws and reads what reached the mandate and the fee off the receipt', async () => {
    const drawn = log(
      ENDOWMENT,
      encodeEventTopics({ abi: endowmentAbi, eventName: 'Drawn', args: { mandate: MANDATE } }) as `0x${string}`[],
      encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [562_191n, 29_589n]),
    );
    const { fake, endowment } = on({ logs: [drawn] });

    const receipt = await endowment.draw();

    expect(receipt).toMatchObject({ amount: micro(562_191n), fee: micro(29_589n) });
    expect(decodeFunctionData({ abi: endowmentAbi, data: fake.sent[0]!.data }).functionName).toBe('draw');
  });

  it('says so when a draw lands with no event', async () => {
    const { endowment } = on({ logs: [] });
    await expect(endowment.draw()).rejects.toBeInstanceOf(MissingEventError);
  });

  it('turns a refusal into a sentence before any gas is spent', async () => {
    const { fake, endowment } = on({ simulate: reverting('NothingToDraw') });

    const failure = endowment.draw();

    await expect(failure).rejects.toBeInstanceOf(CallRefusedError);
    await expect(failure).rejects.toThrow(/Nothing has accrued since the last draw/);
    expect(fake.sent).toHaveLength(0);
  });

  it('accepts into a mandate and sends the keeping calls as they are', async () => {
    const { fake, endowment } = on();

    await endowment.accept(MANDATE);
    await endowment.invest();
    await endowment.refill();
    await endowment.snapshot();

    expect(fake.sent.map((tx) => decodeFunctionData({ abi: endowmentAbi, data: tx.data }).functionName)).toEqual([
      'accept',
      'invest',
      'refill',
      'snapshot',
    ]);
    expect(decodeFunctionData({ abi: endowmentAbi, data: fake.sent[0]!.data }).args).toEqual([MANDATE]);
  });
});

describe('the endowment factory', () => {
  it('starts an endowment with a first gift and reads its address off the receipt', async () => {
    const created = log(
      FACTORY,
      encodeEventTopics({
        abi: endowmentFactoryAbi,
        eventName: 'Created',
        args: { endowment: ENDOWMENT, agentId: 8756n, settlor: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A' },
      }) as `0x${string}`[],
      encodeAbiParameters([{ type: 'uint16' }, { type: 'uint16' }], [400, 5_000]),
    );
    const { fake, factory } = on({ read: (call) => (call.functionName === 'allowance' ? 0n : undefined), logs: [created] });

    const result = await factory.create(
      { agentId: 8756n, holdings: [{ asset: SPY, weightBps: 7_000 }, { asset: NVDA, weightBps: 3_000 }] },
      micro(60_000_000n),
    );

    expect(result.endowment).toBe(ENDOWMENT);
    expect(fake.sent).toHaveLength(2);
    expect(decodeFunctionData({ abi: endowmentFactoryAbi, data: fake.sent[1]!.data })).toEqual({
      functionName: 'create',
      args: [
        { agentId: 8756n, successorId: 0n, assets: [SPY, NVDA], weightsBps: [7_000, 3_000], drawBps: 400, earnShareBps: 5_000 },
        60_000_000n,
      ],
    });
  });

  it('refuses weights that do not make a whole before anything is sent', async () => {
    const { fake, factory } = on();
    await expect(factory.create({ agentId: 1n, holdings: [{ asset: SPY, weightBps: 9_000 }] })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    expect(fake.sent).toHaveLength(0);
  });

  it('names a stock by the symbol the lane records, and refuses one it does not', async () => {
    const { factory } = on();
    await expect(factory.create({ agentId: 1n, holdings: [{ asset: 'SPY', weightBps: 10_000 }] })).rejects.toBeInstanceOf(
      UnknownAssetError,
    );
  });

  it('lists endowments oldest first and per agent', async () => {
    const all = [ENDOWMENT, MANDATE, SPY];
    const { factory } = on({
      read: (call) => {
        if (call.functionName === 'count') return 3n;
        if (call.functionName === 'all') return all[Number(call.args[0])];
        if (call.functionName === 'endowmentsOf') return [ENDOWMENT];
        return undefined;
      },
    });

    expect(await factory.list(1, 5)).toEqual([MANDATE, SPY]);
    expect(await factory.endowmentsOf(8756n)).toEqual([ENDOWMENT]);
    expect(factory.at(ENDOWMENT).address).toBe(ENDOWMENT);
  });
});
