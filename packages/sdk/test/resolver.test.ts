import { describe, expect, it } from 'vitest';
import {
  BaseError,
  RawContractError,
  decodeFunctionData,
  encodeAbiParameters,
  erc20Abi,
  encodeErrorResult,
  encodeEventTopics,
  toFunctionSelector,
} from 'viem';
import type { Address, Hex, Log } from 'viem';
import { oracleRegistryAbi } from '@bursar/core';

import { DisputePhase } from '../src/dispute.js';
import { CallRefusedError, InvalidArgumentError, UnconfirmedCommitError } from '../src/errors.js';
import { commitmentFor, resolver } from '../src/resolver.js';
import { LockStatus } from '../src/types.js';
import { ADDRESSES, FAKE_HASH, fakeConnection, type FakeConnection, type ReadCall } from './helpers/fake-connection.js';

const BRSR = '0x00e503925880c4b07E5Fb70232D83aD871F57a7d';
const PAYER: Address = '0x1111111111111111111111111111111111111111';
const PROVIDER: Address = '0x2222222222222222222222222222222222222222';
const SALT: Hex = `0x${'11'.repeat(32)}`;
const OPENED_AT = 1_800_000_000n;
const ZERO32: Hex = `0x${'00'.repeat(32)}`;

const CONFIG = {
  commitWindow: 21_600n,
  revealWindow: 21_600n,
  unbondingPeriod: 604_800n,
  quorum: 2,
  maxVoters: 5,
  maxDeviation: 20,
  slashBps: 1_000,
};

const RECORD = { bond: 25_000n * 10n ** 18n, unbondingAt: 0n, finalized: 4, slashes: 0, status: 1 };

const VOTE = {
  escrowId: 7n,
  openedAt: OPENED_AT,
  commitEndsAt: OPENED_AT + 21_600n,
  revealEndsAt: OPENED_AT + 43_200n,
  commitCount: 1,
  revealCount: 0,
  medianScore: 0,
  refundBps: 0,
  rewardShares: 0,
  status: DisputePhase.Committing,
};

const LOCK = {
  payer: PAYER,
  payee: PROVIDER,
  disputer: PAYER,
  capabilityId: `0x${'11'.repeat(32)}` as Hex,
  inputCommit: `0x${'22'.repeat(32)}` as Hex,
  outputCommit: ZERO32,
  inputURI: 'data:application/json;base64,e30=',
  outputURI: '',
  amount: 2_500_000n,
  deadline: OPENED_AT + 600n,
  releasedAt: 0n,
  bond: 125_000n,
  disputedAt: OPENED_AT,
  status: LockStatus.Disputed,
  counted: false,
};

function answers(overrides: Record<string, unknown> = {}, voter?: Address) {
  return (call: ReadCall): unknown => {
    if (call.functionName in overrides) return overrides[call.functionName];

    switch (call.functionName) {
      case 'resolver':
        return ADDRESSES.oracleRegistry;
      case 'config':
        return CONFIG;
      case 'bondAsset':
        return BRSR;
      case 'settlementAsset':
        return ADDRESSES.settlementAsset;
      case 'staking':
        return '0x3f2a0E7822B30aD928488F053348b137866Cf962';
      case 'getResolver':
        return RECORD;
      case 'openVotes':
        return 1;
      case 'rewardsOf':
        return 1_250_000n;
      case 'minBondOf':
        return 25_000n * 10n ** 18n;
      case 'isBondable':
        return true;
      case 'allowance':
        return 2n ** 255n;
      case 'nextDisputeId':
        return 5n;
      case 'getDispute':
        return call.args[0] === 4n ? VOTE : { ...VOTE, status: DisputePhase.Finalized };
      case 'getLock':
        return LOCK;
      case 'committedBy':
        return voter === undefined
          ? ZERO32
          : commitmentFor({ disputeId: call.args[0] as bigint, resolver: voter, score: 70, salt: SALT });
      case 'revealedBy':
        return [false, 0];
      case 'commitmentHash':
        return commitmentFor({
          disputeId: call.args[0] as bigint,
          resolver: call.args[1] as Address,
          score: call.args[2] as number,
          salt: call.args[3] as Hex,
        });
      default:
        return undefined;
    }
  };
}

/**
 * A registry that answers `committedBy` with whatever this process last sealed, which is what the
 * chain does. Before anything is sent it answers the commitment for the fixed salt, so a listing
 * reads as a resolver that has already committed.
 */
async function client(build: (account: Address) => Parameters<typeof fakeConnection>[0] = () => ({})) {
  const probe = fakeConnection();
  const account = probe.account.address;
  const base = answers({}, account);
  const box: { sent: readonly { data: Hex }[] } = { sent: [] };

  const fake: FakeConnection = fakeConnection({
    read: (call) => {
      const last = box.sent[box.sent.length - 1];

      if (call.functionName === 'committedBy' && last !== undefined) {
        return decodeFunctionData({ abi: oracleRegistryAbi, data: last.data }).args?.[1];
      }

      return base(call);
    },
    ...build(account),
  });

  box.sent = fake.sent;

  return { ...fake, resolver: await resolver(fake.connection) };
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

function claimedLog(resolver: Address, amount: bigint): Log {
  return {
    address: ADDRESSES.oracleRegistry,
    blockHash: `0x${'cd'.repeat(32)}` as Hex,
    blockNumber: 100n,
    logIndex: 0,
    transactionHash: FAKE_HASH,
    transactionIndex: 0,
    removed: false,
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
    topics: encodeEventTopics({ abi: oracleRegistryAbi, eventName: 'RewardsClaimed', args: { resolver } }),
  } as unknown as Log;
}

describe('the commitment a resolver seals a score with', () => {
  /**
   * Read off chain 4663 on 2026-09-22 from `OracleRegistry.commitmentHash`. A commitment this
   * package computes differently is one the registry can never open, and the bond is slashed for
   * the silence, so the encoding is pinned to a value the live contract produced.
   */
  it('matches the value the deployed registry returns', () => {
    expect(
      commitmentFor({
        disputeId: 1n,
        resolver: '0x0000000000000000000000000000000000000001',
        score: 70,
        salt: SALT,
      }),
    ).toBe('0x6595c7d677574980b244819d655693869929c6d8b41f095b55abb07ee28e67db');
  });

  it('binds the voter, so a commitment lifted from the mempool is useless to anyone else', () => {
    const mine = commitmentFor({ disputeId: 1n, resolver: PAYER, score: 70, salt: SALT });
    const theirs = commitmentFor({ disputeId: 1n, resolver: PROVIDER, score: 70, salt: SALT });

    expect(mine).not.toBe(theirs);
  });

  it('binds the dispute, the score and the salt', () => {
    const base = { disputeId: 1n, resolver: PAYER, score: 70, salt: SALT };

    expect(commitmentFor({ ...base, disputeId: 2n })).not.toBe(commitmentFor(base));
    expect(commitmentFor({ ...base, score: 71 })).not.toBe(commitmentFor(base));
    expect(commitmentFor({ ...base, salt: `0x${'22'.repeat(32)}` })).not.toBe(commitmentFor(base));
  });

  it('refuses a score outside the scale the registry accepts', () => {
    expect(() => commitmentFor({ disputeId: 1n, resolver: PAYER, score: 101, salt: SALT })).toThrow(
      InvalidArgumentError,
    );
    expect(() => commitmentFor({ disputeId: 1n, resolver: PAYER, score: 1.5, salt: SALT })).toThrow(
      /0 is nothing delivered/u,
    );
  });
});

describe('sealing a score', () => {
  it('hands the salt back and says it is the only way to reveal', async () => {
    const { resolver: bonded, sent } = await client();
    const receipt = await bonded.commit({ disputeId: 4n, score: 70, salt: SALT });

    expect(receipt.salt).toBe(SALT);
    expect(receipt.score).toBe(70);
    expect(receipt.warning).toContain(SALT);
    expect(receipt.warning).toContain('the only way to reveal this score');
    expect(receipt.warning).toContain('counts as silence');
    expect(receipt.warning).toContain('part of the bond is taken');

    const call = decodeFunctionData({ abi: oracleRegistryAbi, data: sent[0]?.data ?? '0x' });

    expect(call.functionName).toBe('commitVote');
    expect(call.args?.[1]).toBe(receipt.commitment);
  });

  it('names the six-hour reveal window and both ends of it', async () => {
    const { resolver: bonded } = await client();
    const receipt = await bonded.commit({ disputeId: 4n, score: 70, salt: SALT });

    expect(receipt.warning).toContain('The reveal window is 6h long');
    expect(receipt.warning).toContain('does not reopen');
    expect(receipt.revealFrom.toISOString()).toBe(new Date(Number(OPENED_AT + 21_600n) * 1000).toISOString());
    expect(receipt.revealUntil.toISOString()).toBe(new Date(Number(OPENED_AT + 43_200n) * 1000).toISOString());
    expect(receipt.warning).toContain(receipt.revealUntil.toISOString());
  });

  it('generates a salt when the caller brings none, and never the same one twice', async () => {
    const { resolver: bonded } = await client();
    const first = await bonded.commit({ disputeId: 4n, score: 70 });
    const second = await bonded.commit({ disputeId: 4n, score: 70 });

    expect(first.salt).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(second.salt).not.toBe(first.salt);
  });

  /**
   * A commitment this package computes differently from the registry can never be opened, and the
   * silence costs a bond. Checking it against the registry's own pure function before sending is
   * cheaper than any of the ways of finding out afterwards.
   */
  it('sends nothing when the registry computes the commitment differently', async () => {
    const { resolver: bonded, sent } = await client((account) => ({
      read: answers({ commitmentHash: `0x${'de'.repeat(32)}` }, account),
    }));

    const failure = await failureOf(bonded.commit({ disputeId: 4n, score: 70, salt: SALT }));

    expect(failure).toBeInstanceOf(CallRefusedError);
    expect(failure.message).toContain('could never be revealed');
    expect(sent).toHaveLength(0);
  });

  /** If the chain ends up holding a different commitment, the salt is the only thing worth keeping. */
  it('carries the salt in the refusal when the chain holds another commitment', async () => {
    const { resolver: bonded } = await client((account) => ({
      read: answers({ committedBy: `0x${'ee'.repeat(32)}` }, account),
    }));

    const failure = await failureOf(bonded.commit({ disputeId: 4n, score: 70, salt: SALT }));

    expect(failure.message).toContain(SALT);
    expect(failure.message).toContain('score 70');
    expect((failure as CallRefusedError).details).toMatchObject({ salt: SALT, score: 70, disputeId: '4' });
  });

  /**
   * The transaction was handed to the node and no receipt came back. It may still land, and if it
   * does the salt generated for it is the only thing that opens it.
   */
  it('hands the salt back when the send fails after the commitment left', async () => {
    const { resolver: bonded, sent } = await client(() => ({ receiptError: new Error('socket closed') }));

    const failure = await failureOf(bonded.commit({ disputeId: 4n, score: 70 }));

    expect(sent).toHaveLength(1);
    expect(failure).toBeInstanceOf(UnconfirmedCommitError);

    const salt = (failure as UnconfirmedCommitError).details['salt'];

    expect(salt).toMatch(/^0x[0-9a-f]{64}$/u);
    expect((failure as UnconfirmedCommitError).details).toMatchObject({ score: 70, disputeId: '4' });
    expect(failure.message).toContain(String(salt));
    expect(failure.message).toContain('may be on chain');
    expect(failure.cause).toBeInstanceOf(Error);
  });

  it('hands the salt back when the read after the send fails', async () => {
    const { resolver: bonded } = await client((account) => {
      const base = answers({}, account);

      return { read: (call: ReadCall) => (call.functionName === 'committedBy' ? undefined : base(call)) };
    });

    const failure = await failureOf(bonded.commit({ disputeId: 4n, score: 70, salt: SALT }));

    expect(failure).toBeInstanceOf(UnconfirmedCommitError);
    expect((failure as UnconfirmedCommitError).details).toMatchObject({ salt: SALT, score: 70, disputeId: '4' });
  });
});

describe('what a resolver sees and does', () => {
  it('lists the disputes still open to a vote, with the job the score is about', async () => {
    const { resolver: bonded } = await client();
    const open = await bonded.openDisputes();

    expect(open).toHaveLength(1);
    expect(open[0]?.disputeId).toBe(4n);
    expect(open[0]?.settlementId).toBe(7n);
    expect(open[0]?.quorum).toBe(2);
    expect(open[0]?.job.provider).toBe(PROVIDER);
    expect(open[0]?.job.amount).toBe(2_500_000n);
    expect(open[0]?.committed).toBe(true);
    expect(open[0]?.next).toContain('Reveal the same score and salt');
  });

  it('reports the bond, the floor it has to clear, and the rewards waiting', async () => {
    const { resolver: bonded } = await client();
    const status = await bonded.status();

    expect(status.standing).toBe('active');
    expect(status.bond).toBe(25_000n * 10n ** 18n);
    expect(status.bondFloor).toBe(25_000n * 10n ** 18n);
    expect(status.ruled).toBe(4);
    expect(status.rewards).toBe(1_250_000n);
    expect(status.next).toContain('25000 BRSR at risk');
    expect(status.next).toContain('claimRewards takes them in USDG');
  });

  it('says a bond under the floor is benched rather than gone', async () => {
    const { resolver: bonded } = await client((account) => ({
      read: answers({ getResolver: { ...RECORD, bond: 10_000n * 10n ** 18n }, isBondable: false }, account),
    }));

    expect((await bonded.status()).next).toContain('increaseBond');
  });

  it('names the maturity and the votes still holding a bond that is unbonding', async () => {
    const { resolver: bonded } = await client((account) => ({
      read: answers({ getResolver: { ...RECORD, status: 2, unbondingAt: OPENED_AT }, openVotes: 2 }, account),
    }));

    const status = await bonded.status();

    expect(status.standing).toBe('unbonding');
    expect(status.unbondsAt?.toISOString()).toBe(new Date(Number(OPENED_AT + 604_800n) * 1000).toISOString());
    expect(status.next).toContain('2 votes still hold this bond');
    expect(status.next).toContain('completeUnbond');
  });

  it('encodes each step of the lifecycle against the registry', async () => {
    const { resolver: bonded, sent } = await client();

    await bonded.bond(25_000n * 10n ** 18n as never);
    await bonded.increaseBond(1n * 10n ** 18n as never);
    await bonded.reveal({ disputeId: 4n, score: 70, salt: SALT });
    await bonded.finalize(4n);
    await bonded.failDispute(4n);
    await bonded.requestUnbond();
    await bonded.cancelUnbond();
    await bonded.completeUnbond();

    expect(
      sent.map((transaction) => decodeFunctionData({ abi: oracleRegistryAbi, data: transaction.data }).functionName),
    ).toEqual([
      'register',
      'increaseBond',
      'revealVote',
      'finalize',
      'failDispute',
      'requestUnbond',
      'cancelUnbond',
      'completeUnbond',
    ]);
    expect(sent.every((transaction) => transaction.to === ADDRESSES.oracleRegistry)).toBe(true);
  });

  /**
   * The transaction is what says how much moved. `rewardsOf` read beforehand is a second answer to
   * the same question, and a claim that raced another would report the wrong one.
   */
  it('reports what the claim paid out, off the event rather than the read before it', async () => {
    const { account, resolver: bonded } = await client((who) => ({
      logs: [claimedLog(who, 900_000n)],
    }));

    expect(account.address).toBeDefined();
    expect((await bonded.claimRewards()).amount).toBe(900_000n);
  });

  it('falls back to what was owed when the node prunes the event off the receipt', async () => {
    const { resolver: bonded } = await client(() => ({ logs: [] }));

    expect((await bonded.claimRewards()).amount).toBe(1_250_000n);
  });

  it('approves the registry for exactly the bond in BRSR when the signer has not, then bonds', async () => {
    const { resolver: bonded, sent } = await client((account) => ({ read: answers({ allowance: 0n }, account) }));

    await bonded.bond(25_000n * 10n ** 18n as never);

    expect(sent.map((transaction) => transaction.to)).toEqual([BRSR, ADDRESSES.oracleRegistry]);
    const approval = decodeFunctionData({ abi: erc20Abi, data: sent[0]?.data ?? '0x' });
    expect(approval.functionName).toBe('approve');
    expect(approval.args).toEqual([ADDRESSES.oracleRegistry, 25_000n * 10n ** 18n]);
    expect(decodeFunctionData({ abi: oracleRegistryAbi, data: sent[1]?.data ?? '0x' }).functionName).toBe('register');
  });

  it('refuses a bond of nothing before it costs a transaction', async () => {
    const { resolver: bonded, sent } = await client();

    await expect(bonded.bond(0n as never)).rejects.toThrow(/greater than zero/u);
    expect(sent).toHaveLength(0);
  });
});

describe('what a resolver is told when the registry says no', () => {
  async function refusalFor(data: Hex): Promise<Error> {
    const { resolver: bonded } = await client(() => ({
      simulate: () => {
        throw new BaseError('execution reverted', { cause: new RawContractError({ data }) });
      },
    }));

    return failureOf(bonded.finalize(4n));
  }

  it('tells a resolver that missed the reveal window that nothing recovers it', async () => {
    const failure = await refusalFor(toFunctionSelector('RevealWindowClosed()'));

    expect(failure).toBeInstanceOf(CallRefusedError);
    expect(failure.message).toContain('counts as silence');
    expect(failure.message).toContain('Nothing recovers it');
  });

  it('separates a bond that is short from an address governance has barred', async () => {
    const short = await refusalFor(
      encodeErrorResult({
        abi: oracleRegistryAbi,
        errorName: 'BondNotAccepted',
        args: [10_000n * 10n ** 18n, 25_000n * 10n ** 18n],
      }),
    );

    expect(short.message).toContain('has to post at least 25000 BRSR');
    expect(short.message).not.toMatch(/barred/u);

    const barred = await refusalFor(
      encodeErrorResult({
        abi: oracleRegistryAbi,
        errorName: 'BondNotAccepted',
        args: [30_000n * 10n ** 18n, 25_000n * 10n ** 18n],
      }),
    );

    expect(barred.message).toContain('refuses a bond from this address at any size');
    expect(barred.message).toContain('not a shortfall');
  });

  it('says a bond backing a live vote cannot leave, and what frees it', async () => {
    const failure = await refusalFor(toFunctionSelector('BondLocked()'));

    expect(failure.message).toContain('backing a vote that has not settled');
    expect(failure.message).toContain('Finalise the disputes');
  });
});
