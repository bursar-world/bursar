import { describe, expect, it } from 'vitest';
import {
  BaseError,
  RawContractError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  toFunctionSelector,
} from 'viem';
import type { Address, Hex, Log } from 'viem';
import { mandateAccountFactoryAbi } from '@bursar/core';

import { CallRefusedError } from '../src/errors.js';
import { deployMandate, mandatesOf, predictMandate } from '../src/factory.js';
import { usdg } from '../src/money.js';
import { privateKeyToAccount } from 'viem/accounts';

import { ADDRESSES, FAKE_HASH, TEST_KEY, fakeConnection, type ReadCall } from './helpers/fake-connection.js';

// The factory creates a mandate only for the principal sending the transaction.
const PRINCIPAL: Address = privateKeyToAccount(TEST_KEY).address;
const AGENT: Address = '0x2222222222222222222222222222222222222222';
const DEPLOYED: Address = '0x3333333333333333333333333333333333333333';
const PREDICTED: Address = '0x4444444444444444444444444444444444444444';
const SALT: Hex = `0x${'0f'.repeat(32)}`;

const SEED = {
  principal: PRINCIPAL,
  agent: AGENT,
  salt: SALT,
  limits: {
    perCallCap: usdg('5'),
    dailyCap: usdg('50'),
    monthlyCap: usdg('500'),
    dailyWindow: 86_400,
    monthlyWindow: 2_592_000,
    approvalThreshold: usdg('25'),
  },
};

function createdLog(account: Address, emitter: Address = ADDRESSES.mandateAccountFactory): Log {
  return {
    address: emitter,
    blockHash: `0x${'cd'.repeat(32)}` as Hex,
    blockNumber: 100n,
    logIndex: 0,
    transactionHash: FAKE_HASH,
    transactionIndex: 0,
    removed: false,
    data: encodeAbiParameters([{ type: 'bytes32' }], [SALT]),
    topics: encodeEventTopics({
      abi: mandateAccountFactoryAbi,
      eventName: 'Created',
      args: { account, principal: PRINCIPAL, agent: AGENT },
    }),
  } as unknown as Log;
}

const reads = (call: ReadCall): unknown =>
  call.functionName === 'predict'
    ? PREDICTED
    : call.functionName === 'accountsOf'
      ? [DEPLOYED, PREDICTED]
      : undefined;

describe('deployMandate', () => {
  it('takes the account address from the factory event', async () => {
    const fake = fakeConnection({ logs: [createdLog(DEPLOYED)], read: reads });

    const deployed = await deployMandate(fake.connection, SEED);

    expect(deployed.address).toBe(DEPLOYED);
    expect(deployed.salt).toBe(SALT);
    expect(fake.reads).toHaveLength(0);
  });

  it('sets the limits in the constructor, so no block leaves a funded account unbounded', async () => {
    const fake = fakeConnection({ logs: [createdLog(DEPLOYED)], read: reads });

    await deployMandate(fake.connection, SEED);
    const call = decodeFunctionData({
      abi: mandateAccountFactoryAbi,
      data: fake.sent[0]?.data ?? '0x',
    });

    expect(call.functionName).toBe('create');
    expect(call.args?.[3]).toMatchObject({ perCallCap: 5_000_000n, approvalThreshold: 25_000_000n });
  });

  it('falls back to the predicted address when a node prunes the receipt logs', async () => {
    const fake = fakeConnection({ logs: [], read: reads });

    expect((await deployMandate(fake.connection, SEED)).address).toBe(PREDICTED);
    expect(fake.reads[0]?.functionName).toBe('predict');
  });

  it('ignores a Created event another contract emitted in the same transaction', async () => {
    const fake = fakeConnection({
      logs: [createdLog(DEPLOYED, '0x9999999999999999999999999999999999999999')],
      read: reads,
    });

    expect((await deployMandate(fake.connection, SEED)).address).toBe(PREDICTED);
  });

  it('picks a salt when the caller does not care which address it gets', async () => {
    const fake = fakeConnection({ logs: [createdLog(DEPLOYED)], read: reads });
    const { salt, ...seed } = SEED;

    const first = await deployMandate(fake.connection, seed);
    const second = await deployMandate(fake.connection, seed);

    expect(first.salt).not.toBe(second.salt);
    expect(salt).toBe(SALT);
  });

  it('explains a collision in terms of the inputs that fix the address', async () => {
    const fake = fakeConnection({
      read: reads,
      simulate: () => {
        throw new BaseError('reverted', {
          cause: new RawContractError({ data: toFunctionSelector('AlreadyDeployed()') }),
        });
      },
    });

    const failure = deployMandate(fake.connection, SEED);

    await expect(failure).rejects.toBeInstanceOf(CallRefusedError);
    await expect(failure).rejects.toThrow(/salt, the principal, the agent and the limits/);
  });
});

describe('who may create', () => {
  it('refuses a seed whose principal is not the signer, before any gas is spent', async () => {
    const fake = fakeConnection({ logs: [createdLog(DEPLOYED)], read: reads });
    const other: Address = '0x1111111111111111111111111111111111111111';

    await expect(deployMandate(fake.connection, { ...SEED, principal: other })).rejects.toThrow(
      /has to be created by its principal/,
    );
    expect(fake.sent).toHaveLength(0);
  });

  it('writes the class mask, the total and the lane into the constructor limits', async () => {
    const fake = fakeConnection({ logs: [createdLog(DEPLOYED)], read: reads });
    const deployed = await deployMandate(fake.connection, {
      ...SEED,
      limits: { ...SEED.limits, classes: ['service'], totalCap: usdg('100') },
    });

    expect(deployed.limits).toMatchObject({ classMask: 1, totalCap: usdg('100'), lane: 0 });
  });
});

describe('predictMandate', () => {
  it('reads the address a seed will produce before it exists', async () => {
    const fake = fakeConnection({ read: reads });

    expect(await predictMandate(fake.connection, SEED)).toBe(PREDICTED);
    expect(fake.reads[0]).toMatchObject({
      address: ADDRESSES.mandateAccountFactory,
      functionName: 'predict',
    });
  });
});

describe('mandatesOf', () => {
  it('lists what a principal has deployed', async () => {
    const fake = fakeConnection({ read: reads });

    expect(await mandatesOf(fake.connection, PRINCIPAL)).toEqual([DEPLOYED, PREDICTED]);
  });
});

describe('arguments this package refuses itself', () => {
  it('names the field that would have deployed the account somewhere else', async () => {
    const fake = fakeConnection({ logs: [], read: reads });

    await expect(deployMandate(fake.connection, { ...SEED, principal: 'nope' as Address })).rejects.toThrow(
      /^principal is not a 0x address/u,
    );
    await expect(deployMandate(fake.connection, { ...SEED, salt: '0xdead' as Hex })).rejects.toThrow(
      /^salt must be 32 bytes of hex/u,
    );
    await expect(predictMandate(fake.connection, { ...SEED, agent: 'nope' as Address })).rejects.toThrow(
      /^agent is not a 0x address/u,
    );
    await expect(mandatesOf(fake.connection, 'nope' as Address)).rejects.toThrow(
      /^principal is not a 0x address/u,
    );
  });
});
