import { describe, expect, it } from 'vitest';
import {
  BaseError,
  RawContractError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  toFunctionSelector,
} from 'viem';
import type { Address, Log } from 'viem';
import { escrowAbi, micro } from '@bursar/core';

import { canonicalStringify, commitCanonical, toDataUri } from '../src/commit.js';
import { escrow } from '../src/escrow.js';
import { CallRefusedError, InvalidArgumentError } from '../src/errors.js';
import { LockStatus } from '../src/types.js';
import { ADDRESSES, fakeConnection, type ReadCall } from './helpers/fake-connection.js';

const PAYER: Address = '0x1111111111111111111111111111111111111111';
const PAYEE: Address = '0x2222222222222222222222222222222222222222';
const V2_ESCROW: Address = '0x4315F8be7C9661345710910577Ec31cb867f3c20';

function owedClaimed(party: Address, amount: bigint): Log {
  return {
    address: ADDRESSES.escrow,
    topics: encodeEventTopics({ abi: escrowAbi, eventName: 'OwedClaimed', args: { party } }),
    data: encodeAbiParameters([{ type: 'uint128' }], [amount]),
    blockHash: `0x${'00'.repeat(32)}`,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: `0x${'ab'.repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  } as Log;
}

const LOCK = {
  payer: PAYER,
  payee: PAYEE,
  disputer: '0x0000000000000000000000000000000000000000',
  capabilityId: `0x${'11'.repeat(32)}`,
  inputCommit: `0x${'22'.repeat(32)}`,
  outputCommit: `0x${'00'.repeat(32)}`,
  inputURI: 'ipfs://input',
  outputURI: '',
  amount: 2_500_000n,
  deadline: 1_800_000_300n,
  releasedAt: 0n,
  bond: 0n,
  disputedAt: 0n,
  status: 1,
  counted: false,
};

function answers(overrides: Record<string, unknown> = {}) {
  return (call: ReadCall): unknown => {
    if (call.functionName in overrides) return overrides[call.functionName];

    switch (call.functionName) {
      case 'settlementAsset':
        return ADDRESSES.settlementAsset;
      case 'minTtl':
        return 60n;
      case 'maxTtl':
        return 86_400n;
      case 'disputeWindow':
        return 3_600n;
      case 'minLock':
        return 10_000n;
      case 'owed':
        return 1_250_000n;
      case 'feeBps':
        return 50;
      case 'resolverFeeBps':
        return 100;
      case 'disputeBondBps':
        return 500;
      case 'getLock':
        return LOCK;
      default:
        return undefined;
    }
  };
}

function reverting(selector: `0x${string}`) {
  return () => {
    throw new BaseError('execution reverted', { cause: new RawContractError({ data: selector }) });
  };
}

describe('escrow', () => {
  it('reads the terms that bound every lock it holds', async () => {
    const jobs = await escrow(fakeConnection({ read: answers() }).connection);

    expect(jobs.address).toBe(ADDRESSES.escrow);
    expect(jobs.terms).toMatchObject({ minTtl: 60n, maxTtl: 86_400n, minLock: 10_000n, feeBps: 50, disputeBondBps: 500 });
  });

  /** The v2 escrow on chain 4663 has no floor to read, and asking it for one reverts. */
  it('reads an earlier escrow without asking it for a floor it does not have', async () => {
    const fake = fakeConnection({ read: answers() });
    const jobs = await escrow(fake.connection, V2_ESCROW);

    expect(jobs.contractSet).toBe('v2');
    expect(jobs.terms.minLock).toBe(1n);
    expect(fake.reads.map((read) => read.functionName)).not.toContain('minLock');
    expect(await jobs.owed(PAYEE)).toBe(0n);
    await expect(jobs.claim(PAYEE)).rejects.toThrow(/Nothing is owed on this escrow/);
  });

  it('reads what a settlement could not pay a party', async () => {
    const fake = fakeConnection({ read: answers() });
    const jobs = await escrow(fake.connection);

    expect(await jobs.owed(PAYEE)).toBe(1_250_000n);
    expect(fake.reads.find((read) => read.functionName === 'owed')?.args).toEqual([PAYEE]);
  });

  it('claims for the party it names and reports what arrived', async () => {
    const fake = fakeConnection({ read: answers(), logs: [owedClaimed(PAYEE, 1_250_000n)] });
    const jobs = await escrow(fake.connection);

    const receipt = await jobs.claim(PAYEE);

    expect(decodeFunctionData({ abi: escrowAbi, data: fake.sent[0]?.data ?? '0x' })).toEqual({
      functionName: 'claim',
      args: [PAYEE],
    });
    expect(receipt.party).toBe(PAYEE);
    expect(receipt.amount).toBe(1_250_000n);
  });

  it('claims for the signer when no party is named', async () => {
    const fake = fakeConnection({ read: answers(), logs: [owedClaimed(PAYER, 5n)] });
    const jobs = await escrow(fake.connection);

    await jobs.claim();

    expect(decodeFunctionData({ abi: escrowAbi, data: fake.sent[0]?.data ?? '0x' }).args).toEqual([
      fake.account.address,
    ]);
  });

  it('says so when nothing is owed rather than quoting the zero-amount error', async () => {
    const jobs = await escrow(
      fakeConnection({ read: answers(), simulate: reverting(toFunctionSelector('ZeroAmount()')) }).connection,
    );

    await expect(jobs.claim(PAYEE)).rejects.toThrow(`Nothing is owed to ${PAYEE} here.`);
  });

  it('decodes a lock into the six-decimal amounts the asset counts in', async () => {
    const jobs = await escrow(fakeConnection({ read: answers() }).connection);
    const lock = await jobs.get(1n);

    expect(lock.amount).toBe(2_500_000n);
    expect(lock.status).toBe(LockStatus.Locked);
    expect(lock.payee).toBe(PAYEE);
  });

  it('quotes the bond a dispute costs and what a release pays out', async () => {
    const jobs = await escrow(fakeConnection({ read: answers() }).connection);

    expect(jobs.bondFor(micro(2_500_000n))).toBe(125_000n);
    expect(jobs.payoutFor(micro(2_500_000n))).toBe(2_487_500n);
  });

  it('commits the delivered output as canonical json', async () => {
    const fake = fakeConnection({ read: answers() });
    const jobs = await escrow(fake.connection);

    await jobs.release({ id: 7n, output: { frames: 120 }, outputURI: 'ipfs://out' });

    const call = decodeFunctionData({ abi: escrowAbi, data: fake.sent[0]?.data ?? '0x' });

    expect(call.functionName).toBe('release');
    expect(call.args).toEqual([7n, commitCanonical({ frames: 120 }), 'ipfs://out']);
  });

  /**
   * The payer's only check on a delivery is to recompute the hash over the bytes it read. A
   * commitment released with nowhere to read them from cannot be checked at all.
   */
  it('publishes the delivered output inline when the payee hosts it nowhere else', async () => {
    const fake = fakeConnection({ read: answers() });
    const jobs = await escrow(fake.connection);
    const output = { frames: 120, url: 'https://cdn.test/render.mp4' };

    await jobs.release({ id: 7n, output });

    const call = decodeFunctionData({ abi: escrowAbi, data: fake.sent[0]?.data ?? '0x' });

    expect(call.args).toEqual([7n, commitCanonical(output), toDataUri(canonicalStringify(output))]);
  });

  it('writes no uri when nothing was committed to publish', async () => {
    const fake = fakeConnection({ read: answers() });
    const jobs = await escrow(fake.connection);

    await jobs.release({ id: 7n });

    const call = decodeFunctionData({ abi: escrowAbi, data: fake.sent[0]?.data ?? '0x' });

    expect(call.args).toEqual([7n, `0x${'00'.repeat(32)}`, '']);
  });

  it('refuses two spellings of the same commitment', async () => {
    const jobs = await escrow(fakeConnection({ read: answers() }).connection);

    await expect(
      jobs.release({ id: 7n, output: { a: 1 }, outputCommit: `0x${'11'.repeat(32)}` }),
    ).rejects.toThrow(/not both/);
  });

  it('sends the exits with the lock id alone', async () => {
    const fake = fakeConnection({ read: answers() });
    const jobs = await escrow(fake.connection);

    await jobs.timeout(7n);
    await jobs.cancel(7n);
    await jobs.dispute(7n);
    await jobs.finalizeRelease(7n);

    expect(
      fake.sent.map((transaction) => decodeFunctionData({ abi: escrowAbi, data: transaction.data })),
    ).toEqual([
      { functionName: 'timeout', args: [7n] },
      { functionName: 'cancel', args: [7n] },
      { functionName: 'dispute', args: [7n] },
      { functionName: 'finalizeRelease', args: [7n] },
    ]);
  });

  it('says who may make the call it refused', async () => {
    const jobs = await escrow(
      fakeConnection({ read: answers(), simulate: reverting(toFunctionSelector('NotPayee()')) })
        .connection,
    );

    const failure = jobs.release({ id: 7n, output: {} });

    await expect(failure).rejects.toBeInstanceOf(CallRefusedError);
    await expect(failure).rejects.toThrow('Only the provider named on the lock can release it.');
  });

  it('points a payer at the exit that is open', async () => {
    const jobs = await escrow(
      fakeConnection({ read: answers(), simulate: reverting(toFunctionSelector('TooLate()')) })
        .connection,
    );

    await expect(jobs.release({ id: 7n, output: {} })).rejects.toThrow(
      /The deadline has passed. The payer can reclaim the funds with timeout\(\)/,
    );
  });

  it('says when a lock stops taking disputes, held or released', async () => {
    const jobs = await escrow(
      fakeConnection({ read: answers(), simulate: reverting(toFunctionSelector('TooLate()')) }).connection,
    );

    await expect(jobs.dispute(7n)).rejects.toThrow(
      /contested until its deadline, after which the payer reclaims it with timeout\(\); a released one only inside the dispute window \(1h\)/,
    );
  });

  it('quotes the dispute window when a finalize lands too early', async () => {
    const jobs = await escrow(
      fakeConnection({ read: answers(), simulate: reverting(toFunctionSelector('TooEarly()')) })
        .connection,
    );

    await expect(jobs.finalizeRelease(7n)).rejects.toThrow(/dispute window \(1h\)/);
  });
});

describe('arguments this package refuses itself', () => {
  it('names the id on an escrow id no escrow could have issued', async () => {
    const jobs = await escrow(fakeConnection({ read: answers() }).connection);

    await expect(jobs.get(-1n)).rejects.toThrow(InvalidArgumentError);
    await expect(jobs.get(-1n)).rejects.toThrow(/^id must be between 0 and/u);
    await expect(jobs.timeout(-1n)).rejects.toThrow(/^id must be between 0 and/u);
    await expect(jobs.release({ id: -1n })).rejects.toThrow(/^id must be between 0 and/u);
  });

  it('never quotes viem at a caller of this package', async () => {
    const jobs = await escrow(fakeConnection({ read: answers() }).connection);
    const failure = await jobs.dispute(-1n).catch((error: unknown) => error);

    expect((failure as Error).message).not.toMatch(/viem/iu);
  });
});
