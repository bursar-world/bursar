import { describe, expect, it } from 'vitest';
import { BaseError, RawContractError, decodeFunctionData, encodeAbiParameters, encodeEventTopics, toFunctionSelector } from 'viem';
import type { Address, Hex, Log } from 'viem';
import { mandateAccountAbi } from '@bursar/core';

import { capabilityId } from '../src/commit.js';
import { InvalidArgumentError, MandateDeniedError, NoSignerError } from '../src/errors.js';
import { jobCommit, jobURI, readJobURI } from '../src/job.js';
import { mandateAccount } from '../src/mandate.js';
import { LockStatus } from '../src/types.js';
import { ADDRESSES, FAKE_HASH, fakeConnection, type ReadCall } from './helpers/fake-connection.js';

const ACCOUNT: Address = '0x1234567890123456789012345678901234567890';
const PROVIDER: Address = '0x2222222222222222222222222222222222222222';
const CAPABILITY = 'research.summarize:1';
// `hire` spends in the hire class, so the lock carries the namespaced id.
const CAPABILITY_ID = capabilityId(`hire:${CAPABILITY}`);
const CHAIN_NOW = 1_800_000_000n;

const SPEC = {
  task: 'Summarize the 10-K risk factors into ten bullets.',
  input: { filing: 'https://sec.example/10-K/2026' },
  acceptance: ['Ten bullets or fewer', 'Each bullet cites a page'],
};

const LIMITS = {
  perCallCap: 5_000_000n,
  dailyCap: 50_000_000n,
  monthlyCap: 500_000_000n,
  dailyWindow: 86_400n,
  monthlyWindow: 2_592_000n,
  approvalThreshold: 25_000_000n,
  validFrom: 0n,
  validUntil: 0n,
};

const WINDOW = { cap: 50_000_000n, spent: 1n, duration: 86_400n, start: CHAIN_NOW, epoch: 1n };

const LOCK = {
  payer: ACCOUNT,
  payee: PROVIDER,
  disputer: '0x0000000000000000000000000000000000000000' as Address,
  capabilityId: CAPABILITY_ID,
  inputCommit: jobCommit(SPEC),
  outputCommit: `0x${'00'.repeat(32)}` as Hex,
  inputURI: jobURI(SPEC),
  outputURI: '',
  amount: 2_500_000n,
  deadline: CHAIN_NOW + 600n,
  releasedAt: 0n,
  bond: 0n,
  disputedAt: 0n,
  status: LockStatus.Locked,
  counted: false,
};

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
      case 'reputation':
        return ADDRESSES.reputation;
      case 'registry':
        return ADDRESSES.agentRegistry;
      case 'limits':
        return LIMITS;
      case 'remaining':
        return [5_000_000n, 40_000_000n, 400_000_000n];
      case 'window':
        return WINDOW;
      case 'previewSpend':
        return [true, '0x00000000'];
      case 'balanceOf':
        return 10_000_000n;
      case 'getLock':
        return LOCK;
      case 'disputeWindow':
        return 3_600n;
      case 'feeBps':
        return 100;
      default:
        return undefined;
    }
  };
}

function spentLog(escrowId: bigint): Log {
  return {
    address: ACCOUNT,
    blockHash: `0x${'cd'.repeat(32)}` as Hex,
    blockNumber: 100n,
    logIndex: 0,
    transactionHash: FAKE_HASH,
    transactionIndex: 0,
    removed: false,
    data: encodeAbiParameters(
      [{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }],
      [2_500_000n, 2_500_000n, 2_500_000n],
    ),
    topics: encodeEventTopics({
      abi: mandateAccountAbi,
      eventName: 'Spent',
      args: { escrowId, merchant: PROVIDER, capabilityId: CAPABILITY_ID },
    }),
  } as unknown as Log;
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
  const fake = fakeConnection({
    read: answers(),
    blockTimestamp: CHAIN_NOW,
    logs: [spentLog(42n)],
    ...options,
  });

  return { ...fake, mandate: await mandateAccount(ACCOUNT, fake.connection) };
}

function hireArgs(overrides: Record<string, unknown> = {}) {
  return {
    provider: PROVIDER,
    capability: CAPABILITY,
    spec: SPEC,
    budget: 2_500_000n as never,
    deliverWithinSeconds: 600,
    ...overrides,
  };
}

describe('hiring an agent', () => {
  it('refuses a service label, so a hire can never ride a service allowance', async () => {
    const { mandate, sent } = await client();

    await expect(mandate.hire(hireArgs({ capability: 'service:gpu.render:1' }))).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    expect(sent).toHaveLength(0);
  });

  it('locks the budget through the mandate, against the brief', async () => {
    const { mandate, sent } = await client();
    const receipt = await mandate.hire(hireArgs());

    expect(receipt.jobId).toBe(42n);
    expect(receipt.escrowId).toBe(42n);
    expect(receipt.task).toBe(SPEC.task);
    expect(receipt.specCommit).toBe(jobCommit(SPEC));
    expect(receipt.capability).toBe(`hire:${CAPABILITY}`);

    const call = decodeFunctionData({ abi: mandateAccountAbi, data: sent[0]?.data ?? '0x' });

    expect(call.functionName).toBe('spend');
    const [request] = call.args as unknown as [
      { merchant: Address; capabilityId: Hex; inputCommit: Hex; inputURI: string; amount: bigint; deadline: bigint },
    ];

    expect(request.merchant).toBe(PROVIDER);
    expect(request.capabilityId).toBe(CAPABILITY_ID);
    expect(request.inputCommit).toBe(jobCommit(SPEC));
    expect(request.amount).toBe(2_500_000n);
    expect(request.deadline).toBe(CHAIN_NOW + 600n);
  });

  /**
   * The provider's worker fetches the lock's input URI, hashes what it read and refuses the job
   * unless the hash matches. Publishing the brief inline is what lets it do that with nothing but
   * a node.
   */
  it('publishes the brief inline, so the provider can prove what it was asked for', async () => {
    const { mandate, sent } = await client();
    const receipt = await mandate.hire(hireArgs());

    const call = decodeFunctionData({ abi: mandateAccountAbi, data: sent[0]?.data ?? '0x' });
    const [request] = call.args as unknown as [{ inputURI: string }];

    expect(readJobURI(request.inputURI)).toEqual({
      task: SPEC.task,
      input: SPEC.input,
      acceptance: SPEC.acceptance,
    });
    expect(receipt.specURI).toBe(request.inputURI);
  });

  it('is refused by the same limits and in the same words as a payment', async () => {
    const selector = toFunctionSelector('DailyCapExceeded()');
    const { mandate } = await client({
      read: answers({ remaining: [5_000_000n, 100n, 400_000_000n] }),
      simulate: () => {
        throw new BaseError('execution reverted', { cause: new RawContractError({ data: selector }) });
      },
    });

    const failure = await failureOf(mandate.hire(hireArgs()));

    expect(failure).toBeInstanceOf(MandateDeniedError);
    expect((failure as MandateDeniedError).reason).toBe('daily-cap');
    expect(failure.message).toContain('the daily limit has');
  });

  it('refuses a hire with no task before it costs a transaction', async () => {
    const { mandate, sent } = await client();

    await expect(mandate.hire(hireArgs({ spec: { task: '' } }))).rejects.toThrow(InvalidArgumentError);
    expect(sent).toHaveLength(0);
  });
});

describe('following a job this mandate paid for', () => {
  it('reads the brief back off the lock and says what the provider nets', async () => {
    const { mandate } = await client();
    const job = await mandate.job(42n);

    expect(job.provider).toBe(PROVIDER);
    expect(job.budget).toBe(2_500_000n);
    expect(job.payout).toBe(2_475_000n);
    expect(job.spec?.task).toBe(SPEC.task);
    expect(job.status).toBe(LockStatus.Locked);
    expect(job.next).toContain('has until');
  });

  it('names the window to contest a delivery, and what to check first', async () => {
    const released = { ...LOCK, status: LockStatus.Released, releasedAt: CHAIN_NOW, outputCommit: `0x${'ab'.repeat(32)}`, outputURI: 'https://p/1.json' };
    const { mandate } = await client({ read: answers({ getLock: released }) });
    const job = await mandate.job(42n);

    expect(job.deliveryCommit).toBe(`0x${'ab'.repeat(32)}`);
    expect(job.disputableUntil?.toISOString()).toBe(new Date(Number(CHAIN_NOW + 3_600n) * 1000).toISOString());
    expect(job.next).toContain('verifyDelivery');
  });

  /** A lock this mandate did not open is somebody else's exposure, and is not reported as its own. */
  it('refuses a job another payer opened', async () => {
    const other = { ...LOCK, payer: '0x9999999999999999999999999999999999999999' as Address };
    const { mandate } = await client({ read: answers({ getLock: other }) });

    await expect(mandate.job(42n)).rejects.toThrow(/was paid for by 0x9999/u);
  });

  it('refuses an id the escrow never issued', async () => {
    const { mandate } = await client({ read: answers({ getLock: { ...LOCK, status: LockStatus.None } }) });

    await expect(mandate.job(42n)).rejects.toThrow(/No job carries id 42/u);
  });
});

describe('pay and hire on a read-only client', () => {
  it('refuse under the name of the call made, before anything is sent', async () => {
    const fake = fakeConnection({ read: answers(), blockTimestamp: CHAIN_NOW });
    const readOnly = { ...fake.connection, walletClient: undefined, account: undefined };
    const mandate = await mandateAccount(ACCOUNT, readOnly);

    const hired = await failureOf(mandate.hire(hireArgs()));
    expect(hired).toBeInstanceOf(NoSignerError);
    expect(hired.message).toMatch(/^hire sends a transaction/);

    const paid = await failureOf(mandate.pay({ to: PROVIDER, amount: 1_000_000n as never, capability: CAPABILITY }));
    expect(paid.message).toMatch(/^pay sends a transaction/);
    expect(fake.sent).toHaveLength(0);
  });
});
