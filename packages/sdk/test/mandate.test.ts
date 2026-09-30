import { describe, expect, it } from 'vitest';
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionZeroDataError,
  RawContractError,
  decodeFunctionData,
  domainSeparator,
  encodeAbiParameters,
  encodeEventTopics,
  toFunctionSelector,
} from 'viem';
import type { Address, Hex, Log } from 'viem';
import { RHC_MAINNET, deployment, mandateAccountAbi, micro } from '@bursar/core';

import {
  AmbiguousSpendError,
  CallRefusedError,
  InvalidArgumentError,
  MandateDeniedError,
  NotAMandateAccountError,
} from '../src/errors.js';
import { mandateDomain } from '../src/authorization.js';
import { canonicalStringify, capabilityId, commitCanonical, toDataUri } from '../src/commit.js';
import { encodeLimits, mandateAccount } from '../src/mandate.js';
import { usdg } from '../src/money.js';
import { WindowKind } from '../src/types.js';
import { ADDRESSES, FAKE_HASH, fakeConnection, type ReadCall } from './helpers/fake-connection.js';

const ACCOUNT: Address = '0x1234567890123456789012345678901234567890';
const PROVIDER: Address = '0x2222222222222222222222222222222222222222';
const PRINCIPAL: Address = '0x3333333333333333333333333333333333333333';
const CAPABILITY = 'gpu.render:1';
// `pay` spends in the service class, so the lock carries the namespaced id.
const CAPABILITY_ID = capabilityId(`service:${CAPABILITY}`);
const CHAIN_NOW = 1_800_000_000n;

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

const DAILY = {
  cap: 50_000_000n,
  spent: 48_800_000n,
  duration: 86_400n,
  start: CHAIN_NOW - 71_280n,
  epoch: 3n,
};

const MONTHLY = {
  cap: 500_000_000n,
  spent: 100_000_000n,
  duration: 2_592_000n,
  start: CHAIN_NOW - 86_400n,
  epoch: 1n,
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
      case 'minLock':
        return 10_000n;
      case 'reputation':
        return ADDRESSES.reputation;
      case 'registry':
        return ADDRESSES.agentRegistry;
      case 'limits':
        return LIMITS;
      case 'remaining':
        return [5_000_000n, 1_200_000n, 400_000_000n];
      case 'window':
        return call.args[0] === WindowKind.Daily ? DAILY : MONTHLY;
      case 'previewSpend':
        return [true, '0x00000000'];
      case 'balanceOf':
        return 10_000_000n;
      case 'principal':
        return PRINCIPAL;
      case 'nonce':
        return 7n;
      default:
        return undefined;
    }
  };
}

function spentLog(escrowId: bigint, emitter: Address = ACCOUNT): Log {
  return {
    address: emitter,
    blockHash: `0x${'cd'.repeat(32)}` as Hex,
    blockNumber: 100n,
    logIndex: 0,
    transactionHash: FAKE_HASH,
    transactionIndex: 0,
    removed: false,
    data: encodeAbiParameters(
      [{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }],
      [2_500_000n, 51_300_000n, 102_500_000n],
    ),
    topics: encodeEventTopics({
      abi: mandateAccountAbi,
      eventName: 'Spent',
      args: { escrowId, merchant: PROVIDER, capabilityId: CAPABILITY_ID },
    }),
  } as unknown as Log;
}

/** The error a call threw, typed as one. `await expect().rejects` cannot read three fields at once. */
async function failureOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }

  throw new Error('the call was expected to fail');
}

/** What viem throws for a read against an address that holds no contract, wrapped as it arrives. */
function zeroData(functionName: string, address: Address): Error {
  return new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName }), {
    abi: mandateAccountAbi,
    contractAddress: address,
    functionName,
    args: [],
    docsPath: '/docs/contract/readContract',
  });
}

function reverting(selector: Hex) {
  return () => {
    throw new BaseError('execution reverted', { cause: new RawContractError({ data: selector }) });
  };
}

async function client(options: Parameters<typeof fakeConnection>[0] = {}) {
  const fake = fakeConnection({ read: answers(), blockTimestamp: CHAIN_NOW, ...options });
  return { ...fake, mandate: await mandateAccount(ACCOUNT, fake.connection) };
}

describe('mandateAccount', () => {
  it('reads the escrow the account is bound to rather than assuming the deployment default', async () => {
    const other: Address = '0x8888888888888888888888888888888888888888';
    const { mandate } = await client({ read: answers({ escrow: other }) });

    expect(mandate.escrow).toBe(other);
  });

  it('fails on an address that does not answer as a mandate account', async () => {
    const fake = fakeConnection({ read: () => undefined });

    await expect(mandateAccount(ACCOUNT, fake.connection)).rejects.toThrow(/Unexpected read: escrow/);
  });

  /**
   * The first mistake a newcomer makes: a wallet address, an address from another chain, a
   * deployment that never landed. All three answer every call with "0x", which viem reports as a
   * decoding failure against the function name it tried.
   */
  it('says no mandate account is deployed at an address holding no contract', async () => {
    const fake = fakeConnection({
      read: (call) => {
        throw zeroData(call.functionName, ACCOUNT);
      },
    });

    const failure = await failureOf(mandateAccount(ACCOUNT, fake.connection));

    expect(failure).toBeInstanceOf(NotAMandateAccountError);
    expect(failure.message).toContain('No mandate account is deployed at');
    expect(failure.message).toContain('nothing at this address behaves like a mandate account');
    expect(failure.message).toContain('createMandate');
    expect(failure.message).not.toMatch(/returned no data|contract function|viem/iu);
  });

  it('names the escrow when the account points at an address that answers as nothing', async () => {
    const fake = fakeConnection({
      read: (call) => {
        if (call.functionName === 'escrow') return ADDRESSES.escrow;
        if (call.functionName === 'settlementAsset') return ADDRESSES.settlementAsset;

        throw zeroData(call.functionName, ADDRESSES.escrow);
      },
    });

    const failure = await failureOf(mandateAccount(ACCOUNT, fake.connection));

    expect(failure).toBeInstanceOf(NotAMandateAccountError);
    expect(failure.message).toContain(`names ${ADDRESSES.escrow} as its escrow`);
    expect(failure.message).not.toMatch(/returned no data|contract function|viem/iu);
  });

  it('lets a node that never answered through as itself', async () => {
    const fake = fakeConnection({
      read: () => {
        throw new Error('socket hang up');
      },
    });

    await expect(mandateAccount(ACCOUNT, fake.connection)).rejects.toThrow('socket hang up');
  });
});

describe('pay', () => {
  it('opens an escrowed payment and reports the id it got back', async () => {
    const { mandate, sent, simulated } = await client({ logs: [spentLog(42n)] });

    const receipt = await mandate.pay({ to: PROVIDER, amount: usdg('2.50'), capability: CAPABILITY });

    expect(receipt.escrowId).toBe(42n);
    expect(receipt.hash).toBe(FAKE_HASH);
    expect(receipt.amount).toBe(2_500_000n);
    expect(receipt.merchant).toBe(PROVIDER);
    expect(receipt.capabilityId).toBe(CAPABILITY_ID);
    expect(receipt.explorer).toBe(`${RHC_MAINNET.explorer}/tx/${FAKE_HASH}`);
    expect(receipt.spent).toEqual({ daily: 51_300_000n, monthly: 102_500_000n });
    expect(receipt.remaining.daily).toBe(1_200_000n);

    // Simulated before it was sent, so a refusal never costs gas.
    expect(simulated).toHaveLength(1);
    expect(simulated[0]?.data).toBe(sent[0]?.data);
  });

  it('encodes the spend the account expects', async () => {
    const { mandate, sent } = await client({ logs: [spentLog(42n)] });

    await mandate.pay({
      to: PROVIDER,
      amount: usdg('2.50'),
      capability: CAPABILITY,
      input: { prompt: 'a koi' },
      inputURI: 'ipfs://input',
      ttlSeconds: 600,
    });

    const call = decodeFunctionData({ abi: mandateAccountAbi, data: sent[0]?.data ?? '0x' });

    expect(call.functionName).toBe('spend');
    expect(call.args?.[0]).toMatchObject({
      merchant: PROVIDER,
      capabilityId: CAPABILITY_ID,
      inputURI: 'ipfs://input',
      amount: 2_500_000n,
      deadline: CHAIN_NOW + 600n,
    });
    expect(call.args?.[1]).toEqual([]);
  });

  /**
   * The provider's worker fetches the lock's input URI, hashes what it read and refuses the job
   * unless the hash matches. A commitment with no URI beside it is a lock it cannot answer, and
   * the money sits in the escrow until the deadline returns it.
   */
  it('publishes the input it committed to, so the provider can fetch what it was paid for', async () => {
    const { mandate, sent } = await client({ logs: [spentLog(42n)] });
    const input = { prompt: 'a koi', seed: 7 };

    const receipt = await mandate.pay({
      to: PROVIDER,
      amount: usdg('2.50'),
      capability: CAPABILITY,
      input,
      ttlSeconds: 600,
    });

    const call = decodeFunctionData({ abi: mandateAccountAbi, data: sent[0]?.data ?? '0x' });
    const [request] = call.args as unknown as [{ inputCommit: Hex; inputURI: string }];

    expect(request.inputCommit).toBe(commitCanonical(input));
    expect(request.inputURI).toBe(toDataUri(canonicalStringify(input)));
    expect(JSON.parse(Buffer.from(request.inputURI.split(',')[1] ?? '', 'base64').toString())).toEqual(input);
    expect(receipt.inputURI).toBe(request.inputURI);
  });

  it('leaves the uri alone when the caller hosts the input itself', async () => {
    const { mandate, sent } = await client({ logs: [spentLog(42n)] });

    await mandate.pay({
      to: PROVIDER,
      amount: usdg('2.50'),
      capability: CAPABILITY,
      input: { prompt: 'a koi' },
      inputURI: 'ipfs://input',
    });

    const call = decodeFunctionData({ abi: mandateAccountAbi, data: sent[0]?.data ?? '0x' });

    expect((call.args?.[0] as { inputURI: string }).inputURI).toBe('ipfs://input');
  });

  it('writes no uri when there is nothing committed to publish', async () => {
    const { mandate, sent } = await client({ logs: [spentLog(42n)] });

    await mandate.pay({ to: PROVIDER, amount: usdg('1.00'), capability: CAPABILITY });

    const call = decodeFunctionData({ abi: mandateAccountAbi, data: sent[0]?.data ?? '0x' });

    expect((call.args?.[0] as { inputURI: string }).inputURI).toBe('');
  });

  it('takes the deadline from the chain clock, not from this machine', async () => {
    const { mandate, sent } = await client({ logs: [spentLog(42n)], blockTimestamp: 1_234n });

    await mandate.pay({ to: PROVIDER, amount: usdg('1.00'), capability: CAPABILITY, ttlSeconds: 300 });

    const call = decodeFunctionData({ abi: mandateAccountAbi, data: sent[0]?.data ?? '0x' });

    expect((call.args?.[0] as { deadline: bigint }).deadline).toBe(1_534n);
  });

  it('clamps its own default a margin above the escrow floor rather than reverting on it', async () => {
    const { mandate, sent } = await client({
      logs: [spentLog(42n)],
      read: answers({ minTtl: 600n, maxTtl: 1_200n }),
    });

    await mandate.pay({ to: PROVIDER, amount: usdg('1.00'), capability: CAPABILITY });

    const call = decodeFunctionData({ abi: mandateAccountAbi, data: sent[0]?.data ?? '0x' });

    // One second over the floor reverts BadTtl as soon as the spend waits a block to land.
    expect((call.args?.[0] as { deadline: bigint }).deadline).toBe(CHAIN_NOW + 660n);
  });

  it('refuses a payment under the escrow floor before the transaction is paid for', async () => {
    const { mandate, sent } = await client();

    const failure = await failureOf(mandate.pay({ to: PROVIDER, amount: usdg('0.005'), capability: CAPABILITY }));

    expect(failure).toBeInstanceOf(CallRefusedError);
    expect((failure as CallRefusedError).errorName).toBe('BelowMinLock');
    expect(failure.message).toContain('opens no lock under 0.01 USDG, and this payment is 0.005 USDG');
    expect(sent).toHaveLength(0);
  });

  it('refuses a ttl the escrow would reject, before the transaction is paid for', async () => {
    const { mandate, sent } = await client();

    await expect(
      mandate.pay({ to: PROVIDER, amount: usdg('1.00'), capability: CAPABILITY, ttlSeconds: 30 }),
    ).rejects.toThrow(/ttlSeconds has to be at least 120 and less than 86400/);
    expect(sent).toHaveLength(0);
  });

  /** Valid against the block it was read from, and a revert against the block it would land in. */
  it('refuses a ttl or a deadline that sits just over the escrow floor', async () => {
    const { mandate, sent } = await client({ blockTimestamp: CHAIN_NOW });

    await expect(
      mandate.pay({ to: PROVIDER, amount: usdg('1.00'), capability: CAPABILITY, ttlSeconds: 61 }),
    ).rejects.toThrow(/at least 120/);
    await expect(
      mandate.pay({ to: PROVIDER, amount: usdg('1.00'), capability: CAPABILITY, deadline: CHAIN_NOW + 61n }),
    ).rejects.toThrow(/at least 2m and less than/);
    expect(sent).toHaveLength(0);
  });

  it('refuses a zero payment before it reaches the account', async () => {
    const { mandate, sent } = await client();

    await expect(
      mandate.pay({ to: PROVIDER, amount: micro(0n), capability: CAPABILITY }),
    ).rejects.toThrow(InvalidArgumentError);
    expect(sent).toHaveLength(0);
  });

  it('refuses two spellings of the same commitment', async () => {
    const { mandate } = await client();

    await expect(
      mandate.pay({
        to: PROVIDER,
        amount: usdg('1.00'),
        capability: CAPABILITY,
        input: { a: 1 },
        inputCommit: `0x${'11'.repeat(32)}`,
      }),
    ).rejects.toThrow(/not both/);
  });

  it('names the limit that stopped it, and when that limit resets', async () => {
    const { mandate } = await client({
      simulate: reverting(toFunctionSelector('DailyCapExceeded()')),
    });

    const failure = mandate.pay({ to: PROVIDER, amount: usdg('2.50'), capability: CAPABILITY });

    await expect(failure).rejects.toBeInstanceOf(MandateDeniedError);
    await expect(failure).rejects.toMatchObject({ reason: 'daily-cap' });
    await expect(failure).rejects.toThrow(/the daily limit has 1.20 USDG left of 50.00 USDG/);
    await expect(failure).rejects.toThrow(/The daily window resets at/);
  });

  it('explains an escrow refusal in terms of the provider, not the selector', async () => {
    const { mandate } = await client({
      simulate: reverting(toFunctionSelector('PayeeCapExceeded()')),
      read: answers({ capOf: 500_000n }),
    });

    const failure = mandate.pay({ to: PROVIDER, amount: usdg('2.50'), capability: CAPABILITY });

    await expect(failure).rejects.toBeInstanceOf(CallRefusedError);
    await expect(failure).rejects.toThrow(/can hold at most 0.50 USDG in one job/);
  });

  it('reports a funding shortfall as a funding shortfall', async () => {
    const { mandate } = await client({
      simulate: reverting(toFunctionSelector('ERC20InsufficientBalance(address,uint256,uint256)')),
      read: answers({ balanceOf: 1_000_000n }),
    });

    await expect(
      mandate.pay({ to: PROVIDER, amount: usdg('2.50'), capability: CAPABILITY }),
    ).rejects.toThrow(/It holds 1.00 USDG and this spend needs 2.50 USDG/);
  });

  it('refuses to report an id from a transaction that reverted', async () => {
    const { mandate } = await client({ receiptStatus: 'reverted', logs: [spentLog(42n)] });

    await expect(
      mandate.pay({ to: PROVIDER, amount: usdg('2.50'), capability: CAPABILITY }),
    ).rejects.toThrow(`spend reverted on chain in transaction ${FAKE_HASH}`);
  });

  it('says the money moved when a receipt carries more than one spend', async () => {
    const { mandate } = await client({ logs: [spentLog(42n), spentLog(43n)] });

    const failure = mandate.pay({ to: PROVIDER, amount: usdg('2.50'), capability: CAPABILITY });

    // The transaction has mined. A caller branching on `argument_invalid` reads that as nothing
    // having happened yet and sends the same payment again.
    await expect(failure).rejects.toBeInstanceOf(AmbiguousSpendError);
    await expect(failure).rejects.toMatchObject({ code: 'spend_ambiguous', hash: FAKE_HASH, spends: 2 });
    await expect(failure).rejects.toThrow(/rather than sending it again/);
  });

  it('ignores a Spent event another account emitted in the same transaction', async () => {
    const { mandate } = await client({
      logs: [spentLog(9n, '0x9999999999999999999999999999999999999999')],
    });

    await expect(
      mandate.pay({ to: PROVIDER, amount: usdg('2.50'), capability: CAPABILITY }),
    ).rejects.toThrow(/carried no Spent event/);
  });

  it('routes an approved spend through spendApproved', async () => {
    const { mandate, sent } = await client({ logs: [spentLog(42n)] });
    const approval = {
      approvalId: `0x${'aa'.repeat(32)}` as Hex,
      merchant: PROVIDER,
      capabilityId: CAPABILITY_ID,
      amount: usdg('30.00'),
      expiry: CHAIN_NOW + 3_600n,
    };

    await mandate.pay({
      to: PROVIDER,
      amount: usdg('28.00'),
      capability: CAPABILITY,
      approval: { approval },
    });

    const call = decodeFunctionData({ abi: mandateAccountAbi, data: sent[0]?.data ?? '0x' });

    expect(call.functionName).toBe('spendApproved');
    expect(call.args?.[2]).toMatchObject({ approvalId: approval.approvalId, amount: 30_000_000n });
    // An empty signature means the principal registered the approval on chain already.
    expect(call.args?.[3]).toBe('0x');
  });
});

describe('preview', () => {
  it('reports an allowed spend with the headroom behind it', async () => {
    const { mandate } = await client();

    const decision = await mandate.preview({
      to: PROVIDER,
      amount: usdg('1.00'),
      capability: CAPABILITY,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.denial).toBeUndefined();
    expect(decision.remaining.daily).toBe(1_200_000n);
    expect(decision.daily.resetsAt).toEqual(new Date(Number(DAILY.start + DAILY.duration) * 1000));
  });

  it('answers a refusal without reverting and without spending gas', async () => {
    const { mandate, sent } = await client({
      read: answers({
        previewSpend: [false, toFunctionSelector('MonthlyCapExceeded()')],
      }),
    });

    const decision = await mandate.preview({
      to: PROVIDER,
      amount: usdg('2.50'),
      capability: CAPABILITY,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('monthly-cap');
    expect(decision.errorName).toBe('MonthlyCapExceeded');
    expect(decision.message).toContain('the monthly limit has 400.00 USDG left');
    expect(sent).toHaveLength(0);
  });

  it('treats a threshold refusal as cleared when the spend will carry consent', async () => {
    const { mandate } = await client({
      read: answers({ previewSpend: [false, toFunctionSelector('ApprovalRequired()')] }),
    });

    expect(
      (await mandate.preview({ to: PROVIDER, amount: usdg('30.00'), capability: CAPABILITY }))
        .allowed,
    ).toBe(false);

    expect(
      (
        await mandate.preview({
          to: PROVIDER,
          amount: usdg('30.00'),
          capability: CAPABILITY,
          approved: true,
        })
      ).allowed,
    ).toBe(true);
  });

  it('says so plainly when the deployment refuses with something it does not know', async () => {
    const { mandate } = await client({
      read: answers({ previewSpend: [false, '0xdeadbeef'] }),
    });

    const decision = await mandate.preview({
      to: PROVIDER,
      amount: usdg('1.00'),
      capability: CAPABILITY,
    });

    expect(decision.reason).toBeUndefined();
    expect(decision.message).toContain('deployment is ahead of @bursar/sdk');
  });
});

describe('assertCanPay', () => {
  it('throws the same error pay would have thrown', async () => {
    const { mandate } = await client({
      read: answers({ previewSpend: [false, toFunctionSelector('DailyCapExceeded()')] }),
    });

    await expect(
      mandate.assertCanPay({ to: PROVIDER, amount: usdg('2.50'), capability: CAPABILITY }),
    ).rejects.toBeInstanceOf(MandateDeniedError);
  });

  it('returns quietly when the mandate allows the spend', async () => {
    const { mandate } = await client();

    await expect(
      mandate.assertCanPay({ to: PROVIDER, amount: usdg('1.00'), capability: CAPABILITY }),
    ).resolves.toBeUndefined();
  });
});

describe('reads', () => {
  it('reports headroom with the clock attached to each bucket', async () => {
    const { mandate } = await client();
    const remaining = await mandate.remaining();

    expect(remaining).toEqual({
      perCall: 5_000_000n,
      daily: 1_200_000n,
      monthly: 400_000_000n,
      dailyResetsAt: new Date(Number(DAILY.start + DAILY.duration) * 1000),
      monthlyResetsAt: new Date(Number(MONTHLY.start + MONTHLY.duration) * 1000),
    });
  });

  it('reports a window after the rollover a spend in this block would apply', async () => {
    const { mandate } = await client();
    const window = await mandate.window(WindowKind.Daily);

    expect(window.remaining).toBe(1_200_000n);
    expect(window.epoch).toBe(3n);
  });
});

describe('principal calls', () => {
  it('encodes a limit change and simulates it before sending', async () => {
    const { mandate, sent, simulated } = await client();

    await mandate.setLimits({
      perCallCap: usdg('5'),
      dailyCap: usdg('50'),
      monthlyCap: usdg('500'),
      dailyWindow: 86_400,
      monthlyWindow: 2_592_000,
      approvalThreshold: usdg('25'),
    });

    expect(simulated).toHaveLength(1);
    const call = decodeFunctionData({ abi: mandateAccountAbi, data: sent[0]?.data ?? '0x' });

    expect(call.functionName).toBe('setLimits');
    expect(call.args?.[0]).toMatchObject({ perCallCap: 5_000_000n, dailyWindow: 86_400n });
  });

  it('refuses an approval threshold of zero, which the account reads as consent for everything', async () => {
    const { mandate } = await client();

    await expect(
      mandate.setLimits({
        perCallCap: usdg('5'),
        dailyCap: usdg('50'),
        monthlyCap: usdg('500'),
        dailyWindow: 86_400,
        monthlyWindow: 2_592_000,
        approvalThreshold: micro(0n),
      }),
    ).rejects.toThrow(/approvalThreshold must be greater than zero/);
  });

  it('names the principal when the signer is not it', async () => {
    const { mandate } = await client({ simulate: reverting(toFunctionSelector('NotPrincipal()')) });

    await expect(mandate.setPaused(true)).rejects.toThrow(
      `Only the principal can change this mandate, and that is ${PRINCIPAL}`,
    );
  });

  it('says which limit the account refused, and that the ones in force did not change', async () => {
    const cases: [string, string][] = [
      ['BadWindow()', 'A spending window has to be longer than zero seconds'],
      ['BadValidity()', 'validUntil has to fall after validFrom'],
      ['BadApprovalThreshold()', 'approvalThreshold of zero would put every spend behind the principal'],
    ];

    for (const [error, sentence] of cases) {
      const { mandate } = await client({ simulate: reverting(toFunctionSelector(error)) });
      const failure = await failureOf(
        mandate.setLimits({
          perCallCap: usdg('5'),
          dailyCap: usdg('50'),
          monthlyCap: usdg('500'),
          dailyWindow: 86_400,
          monthlyWindow: 2_592_000,
          approvalThreshold: usdg('25'),
        }),
      );

      expect(failure.message).toContain(sentence);
      expect(failure.message).toContain('The limits in force are unchanged');
      expect(failure.message).not.toMatch(/look that name up/iu);
    }
  });

  const signedLimits = encodeLimits({
    perCallCap: usdg('5'),
    dailyCap: usdg('50'),
    monthlyCap: usdg('500'),
    dailyWindow: 86_400,
    monthlyWindow: 2_592_000,
    approvalThreshold: usdg('25'),
  });

  it('reads back the nonce a stranded authorization was signed against', async () => {
    const { mandate } = await client({ simulate: reverting(toFunctionSelector('BadNonce()')) });

    await expect(
      mandate.relayLimits({ limits: signedLimits, nonce: 3n, deadline: 1_900_000_000n, signature: '0xabcd' }),
    ).rejects.toThrow('this mandate is at 7');
  });

  it('names the principal an authorization signature failed to recover to', async () => {
    const { mandate } = await client({ simulate: reverting(toFunctionSelector('BadSignature()')) });

    await expect(
      mandate.relayLimits({ limits: signedLimits, nonce: 7n, deadline: 1_900_000_000n, signature: '0xabcd' }),
    ).rejects.toThrow(`does not recover to ${PRINCIPAL}`);
  });

  it('says a signed limit change missed its deadline', async () => {
    const { mandate } = await client({ simulate: reverting(toFunctionSelector('AuthorizationExpired()')) });

    await expect(
      mandate.relayLimits({ limits: signedLimits, nonce: 7n, deadline: 1n, signature: '0xabcd' }),
    ).rejects.toThrow('passed its deadline before it reached the chain');
  });

  it('says a payment past its deadline is refunded, not contested', async () => {
    const { mandate } = await client({ simulate: reverting(toFunctionSelector('TooLate()')) });

    await expect(mandate.disputeSpend(42n)).rejects.toThrow(/the escrow refunds the mandate through timeout/);
  });

  it('refuses to hand the mandate to the principal it already has', async () => {
    const { mandate } = await client({ simulate: reverting(toFunctionSelector('AlreadyPrincipal()')) });

    await expect(mandate.transferPrincipal(PRINCIPAL)).rejects.toThrow('That address is already the principal.');
  });

  it('names the call that was handed a zero address', async () => {
    const { mandate } = await client({ simulate: reverting(toFunctionSelector('ZeroAddress()')) });

    await expect(mandate.transferPrincipal(PROVIDER)).rejects.toThrow(
      'transferPrincipal was given the zero address',
    );
  });

  it('approves the settlement asset before a deposit that needs an allowance', async () => {
    const { mandate, sent } = await client({ read: answers({ allowance: 0n }) });

    await mandate.deposit(usdg('10'));

    expect(sent).toHaveLength(2);
    expect(sent[0]?.to).toBe(ADDRESSES.settlementAsset);
    expect(decodeFunctionData({ abi: mandateAccountAbi, data: sent[1]?.data ?? '0x' })).toMatchObject({
      functionName: 'deposit',
      args: [10_000_000n],
    });
  });

  it('skips the approval when the allowance already covers the deposit', async () => {
    const { mandate, sent } = await client({ read: answers({ allowance: 20_000_000n }) });

    await mandate.deposit(usdg('10'));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(ACCOUNT);
  });
});

describe('arguments this package refuses itself', () => {
  /**
   * A caller of @bursar/sdk has no reason to know viem is under it, and an `InvalidAddressError`
   * quoting a library version tells them nothing about which field they got wrong.
   */
  it('names the field on a preview with an address that is not one, and does not quote viem', async () => {
    const { mandate } = await client();

    const failure = await mandate
      .preview({ to: 'nope' as Address, amount: usdg('1.00'), capability: CAPABILITY })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InvalidArgumentError);
    expect((failure as InvalidArgumentError).field).toBe('to');
    expect((failure as Error).message).toMatch(/^to is not a 0x address: nope$/u);
    expect((failure as Error).message).not.toMatch(/viem/iu);
    expect((failure as Error).name).not.toMatch(/InvalidAddress/u);
  });

  it('refuses before it reads the chain, so a bad address costs no round trip', async () => {
    const { mandate, reads } = await client();
    const before = reads.length;

    await mandate.preview({ to: 'nope' as Address, amount: usdg('1.00'), capability: CAPABILITY }).catch(() => undefined);

    expect(reads.length).toBe(before);
  });

  it('names the field on every payment argument a caller can get wrong', async () => {
    const { mandate } = await client();
    const good = { to: PROVIDER, amount: usdg('2.50'), capability: CAPABILITY };

    await expect(mandate.pay({ ...good, to: 'nope' as Address })).rejects.toThrow(/^to is not a 0x address/u);
    await expect(mandate.pay({ ...good, capability: 7 as unknown as string })).rejects.toThrow(
      /^capability must be a capability label/u,
    );
    await expect(mandate.pay({ ...good, merchantProof: ['0xdead' as Hex] })).rejects.toThrow(
      /^merchantProof\[0\] must be 32 bytes/u,
    );
  });

  it('names the field on an admin call rather than letting the encoder do it', async () => {
    const { mandate } = await client();

    await expect(mandate.setAgent('nope' as Address)).rejects.toThrow(/^agent is not a 0x address/u);
    await expect(mandate.setMerchant('nope' as Address, true)).rejects.toThrow(/^merchant is not a 0x address/u);
    await expect(mandate.transferPrincipal('nope' as Address)).rejects.toThrow(/^to is not a 0x address/u);
    await expect(mandate.withdraw({ to: 'nope' as Address, amount: usdg('1.00') })).rejects.toThrow(
      /^to is not a 0x address/u,
    );
  });

  it('refuses an escrow id no escrow could have issued', async () => {
    const { mandate } = await client();

    await expect(mandate.creditable(-1n)).rejects.toThrow(/^escrowId must be between 0 and/u);
    await expect(mandate.disputeSpend(-1n)).rejects.toThrow(InvalidArgumentError);
  });

  it('checks a registered approval as closely as a signed one', async () => {
    const { mandate } = await client();

    await expect(
      mandate.approveSpend({
        approvalId: `0x${'11'.repeat(32)}`,
        merchant: 'nope' as Address,
        capabilityId: CAPABILITY_ID,
        amount: usdg('30.00'),
        expiry: 1_900_000_000n,
      }),
    ).rejects.toThrow(/^approval.merchant is not a 0x address/u);
  });
});

describe('spend classes', () => {
  it('pays under the service namespace and reports the namespaced label', async () => {
    const { mandate, sent } = await client({ logs: [spentLog(7n)] });

    const receipt = await mandate.pay({ to: PROVIDER, amount: usdg('1.00'), capability: CAPABILITY });
    const call = decodeFunctionData({ abi: mandateAccountAbi, data: sent[0]?.data ?? '0x' });

    expect(receipt.capability).toBe('service:gpu.render:1');
    expect(receipt.capabilityId).toBe(capabilityId('service:gpu.render:1'));
    expect(call.args?.[0]).toMatchObject({ capabilityId: capabilityId('service:gpu.render:1') });
  });

  it('takes a label already in the service class as written', async () => {
    const { mandate } = await client({ logs: [spentLog(7n)] });

    const receipt = await mandate.pay({ to: PROVIDER, amount: usdg('1.00'), capability: 'service:gpu.render:1' });

    expect(receipt.capabilityId).toBe(capabilityId('service:gpu.render:1'));
  });

  it('refuses to pay under another class, and sends nothing', async () => {
    const { mandate, sent } = await client({ logs: [spentLog(7n)] });

    const failure = await failureOf(
      mandate.pay({ to: PROVIDER, amount: usdg('1.00'), capability: 'hire:research.summarize:1' }),
    );

    expect(failure).toBeInstanceOf(InvalidArgumentError);
    expect((failure as InvalidArgumentError).field).toBe('capability');
    expect(failure.message).toContain('hire class');
    expect(sent).toHaveLength(0);
  });

  it('refuses a raw 32-byte id, whose class cannot be read back', async () => {
    const { mandate, sent } = await client({ logs: [spentLog(7n)] });

    await expect(
      mandate.pay({ to: PROVIDER, amount: usdg('1.00'), capability: capabilityId('service:gpu.render:1') }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(sent).toHaveLength(0);
  });

  it('previews under the service class by default, a hire when asked, and a namespaced label as written', async () => {
    const asked: Hex[] = [];
    const read = answers();
    const { mandate } = await client({
      read: (call) => {
        if (call.functionName === 'previewSpend') asked.push(call.args[1] as Hex);
        return read(call);
      },
    });

    await mandate.preview({ to: PROVIDER, amount: usdg('1.00'), capability: CAPABILITY });
    await mandate.preview({ to: PROVIDER, amount: usdg('1.00'), capability: CAPABILITY, spendClass: 'hire' });
    await mandate.preview({ to: PROVIDER, amount: usdg('1.00'), capability: 'rwa:aapl:1' });

    expect(asked).toEqual([
      capabilityId('service:gpu.render:1'),
      capabilityId('hire:gpu.render:1'),
      capabilityId('rwa:aapl:1'),
    ]);
  });

  /**
   * The README allows `gpu.render:1` and then pays under it. `pay` spends under `service:`, so an
   * allowlist keyed any other way reads as allowed and refuses the payment.
   */
  it('allows a bare label under the service class, the id pay then spends under', async () => {
    const { mandate, sent } = await client({ logs: [spentLog(7n)] });

    await mandate.setCapability(CAPABILITY, true);
    const receipt = await mandate.pay({ to: PROVIDER, amount: usdg('1.00'), capability: CAPABILITY });

    const allowed = decodeFunctionData({ abi: mandateAccountAbi, data: sent[0]?.data ?? '0x' });
    expect(allowed.functionName).toBe('setCapability');
    expect(allowed.args).toEqual([capabilityId('service:gpu.render:1'), true]);
    expect(receipt.capabilityId).toBe(allowed.args?.[0]);
  });

  it('keeps an explicit hire or rwa label in its class, and a 32-byte id as given', async () => {
    const { mandate, sent } = await client();
    const id = capabilityId('some.label:1');

    await mandate.setCapability('hire:research.summarize:1', true);
    await mandate.setCapability('rwa:SPY', false);
    await mandate.setCapability(id, true);
    await mandate.setCapability('  service:gpu.render:1 ', true);

    const stored = sent.map((transaction) => decodeFunctionData({ abi: mandateAccountAbi, data: transaction.data }).args);

    expect(stored).toEqual([
      [capabilityId('hire:research.summarize:1'), true],
      [capabilityId('rwa:SPY'), false],
      [id, true],
      [capabilityId('service:gpu.render:1'), true],
    ]);
  });

  it('reads the allowlist the way pay and hire spend', async () => {
    const asked: Hex[] = [];
    const read = answers();
    const { mandate } = await client({
      read: (call) => {
        if (call.functionName === 'capabilities') {
          asked.push(call.args[0] as Hex);
          return call.args[0] === capabilityId('service:gpu.render:1');
        }
        return read(call);
      },
    });

    expect(await mandate.allowsCapability(CAPABILITY)).toBe(true);
    expect(await mandate.allowsCapability('service:gpu.render:1')).toBe(true);
    expect(await mandate.allowsCapability('hire:gpu.render:1')).toBe(false);
    expect(asked).toEqual([
      capabilityId('service:gpu.render:1'),
      capabilityId('service:gpu.render:1'),
      capabilityId('hire:gpu.render:1'),
    ]);
  });

  it('signs an approval for the capability id pay will carry', async () => {
    const separator = domainSeparator({ domain: mandateDomain(ACCOUNT, RHC_MAINNET.chainId) });
    const { mandate } = await client({ read: answers({ DOMAIN_SEPARATOR: separator }) });

    const consent = await mandate.signApproval({
      merchant: PROVIDER,
      capability: CAPABILITY,
      amount: usdg('30'),
      expiry: CHAIN_NOW + 3_600n,
    });

    expect(consent.approval.capabilityId).toBe(capabilityId('service:gpu.render:1'));
  });
});

describe('total budget', () => {
  const TOTAL = { ...MONTHLY, duration: 3_153_600_000n };

  it('names a MonthlyCapExceeded from a lifetime second window as the total budget', async () => {
    const { mandate } = await client({
      read: answers({
        previewSpend: [false, toFunctionSelector('MonthlyCapExceeded()')],
        limits: { ...LIMITS, monthlyWindow: 3_153_600_000n },
        window: TOTAL,
      }),
    });

    const decision = await mandate.preview({ to: PROVIDER, amount: usdg('450.00'), capability: CAPABILITY });

    expect(decision.reason).toBe('total-budget');
    expect(decision.denial?.reason).toBe('total-budget');
    expect(decision.errorName).toBe('MonthlyCapExceeded');
    expect(decision.message).toContain('the total budget has 400.00 USDG left of 500.00 USDG');
    expect(decision.message).toContain('does not refill');
    expect(decision.message).not.toMatch(/monthly/iu);
    expect(decision.denial?.resetsAt).toBeUndefined();
  });

  it('keeps the monthly cap for a second window that rolls', async () => {
    const { mandate } = await client({
      read: answers({ previewSpend: [false, toFunctionSelector('MonthlyCapExceeded()')] }),
    });

    const decision = await mandate.preview({ to: PROVIDER, amount: usdg('450.00'), capability: CAPABILITY });

    expect(decision.reason).toBe('monthly-cap');
    expect(decision.denial?.resetsAt).toEqual(new Date(Number(MONTHLY.start + MONTHLY.duration) * 1000));
  });
});

/**
 * The v1 set on 4663 keeps serving its mandates. Its account holds eight limit fields and takes no
 * class in a spend, so a v1 mandate is read and written through the frozen v1 ABI, picked by the
 * escrow the account names.
 */
describe('contract sets', () => {
  const V1_ESCROW = deployment('rhc-mainnet').contracts.Escrow;
  const V2_ESCROW = deployment('rhc-mainnet-v2').contracts.Escrow;

  it('reads a mandate on the v1 escrow as v1, with no native class or total', async () => {
    const { mandate, reads } = await client({ read: answers({ escrow: V1_ESCROW }) });

    expect(mandate.contractSet).toBe('v1');
    expect(await mandate.limits()).toMatchObject({ classMask: 0, totalCap: 0n, lane: 0 });
    expect(await mandate.total()).toBeNull();

    await mandate.preview({ to: PROVIDER, amount: usdg('1.00'), capability: CAPABILITY });
    expect(reads.find((call) => call.functionName === 'previewSpend')?.args).toHaveLength(3);
  });

  it('previews a v2 spend with its class, and reads the native total', async () => {
    const { mandate, reads } = await client({
      read: answers({
        escrow: V2_ESCROW,
        limits: { ...LIMITS, classMask: 3, totalCap: 1_000_000n, lane: 0 },
        totalSpent: 250_000n,
      }),
    });

    expect(mandate.contractSet).toBe('v2');
    expect(await mandate.total()).toEqual({ cap: 1_000_000n, spent: 250_000n, remaining: 750_000n });
    // A v2 escrow has no floor to read; asking it for one would revert.
    expect(reads.map((call) => call.functionName)).not.toContain('minLock');

    await mandate.preview({ to: PROVIDER, amount: usdg('0.10'), capability: CAPABILITY, spendClass: 'hire' });
    expect(reads.find((call) => call.functionName === 'previewSpend')?.args[3]).toBe(1);
  });

  it('refuses a lifetime total on a v1 mandate rather than dropping it', async () => {
    const { mandate } = await client({ read: answers({ escrow: V1_ESCROW }) });
    const limits = {
      perCallCap: usdg('5'),
      dailyCap: usdg('50'),
      monthlyCap: usdg('500'),
      dailyWindow: 86_400,
      monthlyWindow: 2_592_000,
      approvalThreshold: usdg('25'),
      totalCap: usdg('5'),
    };

    await expect(mandate.setLimits(limits)).rejects.toThrow(/v1 mandate, which holds no lifetime total/);
  });

  it('names a native total refusal as the total budget', async () => {
    const { mandate } = await client({
      read: answers({
        escrow: V2_ESCROW,
        limits: { ...LIMITS, classMask: 3, totalCap: 1_000_000n, lane: 0 },
        totalSpent: 950_000n,
        previewSpend: [false, toFunctionSelector('TotalCapExceeded()')],
      }),
    });

    const decision = await mandate.preview({ to: PROVIDER, amount: usdg('0.10'), capability: CAPABILITY });
    expect(decision.reason).toBe('total-budget');
    expect(decision.message).toContain('0.05 USDG left of 1.00 USDG');
  });
});
