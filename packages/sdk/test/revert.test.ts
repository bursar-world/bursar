import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BaseError,
  ContractFunctionRevertedError,
  RawContractError,
  createPublicClient,
  encodeErrorResult,
  encodeFunctionData,
  http,
  toHex,
} from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import {
  RHC_MAINNET,
  escrowAbi,
  mandateAccountAbi,
  micro,
  oracleRegistryAbi,
  viemChain,
} from '@bursar/core';

import { connect } from '../src/connection.js';
import { MandateDeniedError } from '../src/errors.js';
import { mandateAccount } from '../src/mandate.js';
import { decodeRevertData, revertFrom } from '../src/revert.js';
import { WindowKind } from '../src/types.js';
import { ADDRESSES, RHC_DEPLOYMENT, fakeConnection, type ReadCall } from './helpers/fake-connection.js';

/**
 * Revert data as the deployed contracts produce it. Encoding it from the ABIs in `@bursar/core`
 * means a renamed error breaks this suite, never leaves it asserting on a string no contract
 * emits.
 */
const DAILY_CAP = encodeErrorResult({ abi: mandateAccountAbi, errorName: 'DailyCapExceeded' });
const PAYEE_CAP = encodeErrorResult({ abi: escrowAbi, errorName: 'PayeeCapExceeded' });
const TOKEN_FAILED = encodeErrorResult({
  abi: escrowAbi,
  errorName: 'SafeERC20FailedOperation',
  args: ['0x3600000000000000000000000000000000000000'],
});

const ACCOUNT: Address = '0xe8fd2904175811Db41636c6085eBFE6661E196d5';
const AGENT: Address = '0x3164F1EaA42C769e40Aec0a43e8C51ec2c0EBe03';
const PROVIDER: Address = '0x780de139902298C8E6687572fC99B32A33144AA7';
const TEST_KEY: Hex = `0x${'11'.repeat(32)}`;

describe('decodeRevertData', () => {
  it('reads a bare selector, which is what previewSpend returns', () => {
    expect(decodeRevertData(DAILY_CAP)).toEqual({ errorName: 'DailyCapExceeded', args: [] });
  });

  it('reads an error the escrow declared, not only the account', () => {
    expect(decodeRevertData(PAYEE_CAP)?.errorName).toBe('PayeeCapExceeded');
  });

  it('reads the arguments an error carries', () => {
    expect(decodeRevertData(TOKEN_FAILED)).toEqual({
      errorName: 'SafeERC20FailedOperation',
      args: ['0x3600000000000000000000000000000000000000'],
    });
  });

  it('reads an error declared only by a contract the spend never touches', () => {
    const data = encodeErrorResult({
      abi: oracleRegistryAbi,
      errorName: 'SafeCastOverflowedUintDowncast',
      args: [8, 257n],
    });

    expect(decodeRevertData(data)).toEqual({
      errorName: 'SafeCastOverflowedUintDowncast',
      args: [8, 257n],
    });
  });

  it('reads the settlement asset, whose precompile ABI declares no errors at all', () => {
    const data = encodeErrorResult({
      abi: [
        {
          type: 'error',
          name: 'ERC20InsufficientBalance',
          inputs: [
            { name: 'sender', type: 'address' },
            { name: 'balance', type: 'uint256' },
            { name: 'needed', type: 'uint256' },
          ],
        },
      ] as const,
      errorName: 'ERC20InsufficientBalance',
      args: [ACCOUNT, 1_500_000n, 2_000_000n],
    });

    expect(decodeRevertData(data)).toEqual({
      errorName: 'ERC20InsufficientBalance',
      args: [ACCOUNT, 1_500_000n, 2_000_000n],
    });
  });

  it('reads a plain require string', () => {
    const data = encodeErrorResult({
      abi: [
        { type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] },
      ] as const,
      errorName: 'Error',
      args: ['ERC20: transfer amount exceeds balance'],
    });

    expect(decodeRevertData(data)).toEqual({
      errorName: 'Error',
      args: ['ERC20: transfer amount exceeds balance'],
    });
  });

  it('names an error whose arguments a node truncated away', () => {
    expect(decodeRevertData(TOKEN_FAILED.slice(0, 10) as Hex)).toEqual({
      errorName: 'SafeERC20FailedOperation',
      args: [],
    });
  });

  it('reports nothing for data that decodes to nothing', () => {
    expect(decodeRevertData('0x')).toBeUndefined();
    expect(decodeRevertData('0xdeadbeef')).toBeUndefined();
  });
});

describe('revertFrom, on errors built by hand', () => {
  it('takes the name viem already decoded', () => {
    const error = new ContractFunctionRevertedError({
      abi: mandateAccountAbi,
      data: DAILY_CAP,
      functionName: 'spend',
    });

    expect(revertFrom(error)?.errorName).toBe('DailyCapExceeded');
  });

  it('decodes a selector the call ABI did not cover', () => {
    // A spend is sent against the account, so an escrow selector arrives undecoded.
    const error = new ContractFunctionRevertedError({
      abi: mandateAccountAbi,
      data: PAYEE_CAP,
      functionName: 'spend',
    });

    expect(revertFrom(error)?.errorName).toBe('PayeeCapExceeded');
  });

  it('reaches revert data carried on a raw rpc error', () => {
    const error = new BaseError('reverted', { cause: new RawContractError({ data: DAILY_CAP }) });

    expect(revertFrom(error)?.errorName).toBe('DailyCapExceeded');
  });

  it('reaches revert data an rpc nested one level deeper', () => {
    const error = new BaseError('reverted', {
      cause: new RawContractError({ data: { data: DAILY_CAP } }),
    });

    expect(revertFrom(error)?.errorName).toBe('DailyCapExceeded');
  });

  it('reaches revert data a provider left in the message and nowhere else', () => {
    const error = new BaseError('reverted', {
      details: `execution reverted: ${DAILY_CAP}`,
    });

    expect(revertFrom(error)?.errorName).toBe('DailyCapExceeded');
  });

  it('follows a cycle without hanging', () => {
    const inner: { cause?: unknown; data: Hex } = { data: DAILY_CAP };
    const outer = { cause: inner };
    inner.cause = outer;

    expect(revertFrom(outer)?.errorName).toBe('DailyCapExceeded');
  });

  it('reports nothing for a failure that is not a revert', () => {
    expect(revertFrom(new Error('connect ECONNREFUSED'))).toBeUndefined();
    expect(revertFrom(new BaseError('http request failed'))).toBeUndefined();
    expect(revertFrom(undefined)).toBeUndefined();
    expect(revertFrom(DAILY_CAP)).toBeUndefined();
  });
});

/**
 * The rest of this suite runs against a node rather than against a hand-built error.
 *
 * Every wrapper between the JSON-RPC body and the caller is viem's own: which class it throws
 * differs per action and per viem release, and hand-assembling one proves that this package can
 * read an error it wrote itself. The first live run failed on exactly that gap.
 */
type Reply =
  | { readonly result: unknown }
  | { readonly error: { code: number; message: string; data?: unknown } }
  | { readonly status: number }
  | { readonly drop: true };

const CHAIN = viemChain(RHC_MAINNET);

let server: Server;
let url: string;
let reply: (method: string) => Reply;

/** Enough of a node to get an action as far as the call it fails on. */
const DEFAULTS: Readonly<Record<string, unknown>> = {
  eth_chainId: toHex(RHC_MAINNET.chainId),
  eth_getTransactionCount: '0x0',
  eth_maxPriorityFeePerGas: toHex(1_000_000_000n),
};

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; method: string };
      const answer = reply(body.method);

      if ('drop' in answer) {
        request.socket.destroy();
        return;
      }

      if ('status' in answer) {
        response.writeHead(answer.status, { 'content-type': 'text/plain' });
        response.end('upstream unavailable');
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...answer }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

/** Anything not named falls through to the default table above. */
function answering(method: string, answer: Reply): void {
  reply = (asked) =>
    asked === method ? answer : { result: DEFAULTS[asked] ?? '0x' };
}

function reverting(method: string, data: Hex, code = 3): void {
  answering(method, { error: { code, message: 'execution reverted', data } });
}

function nodeClient(): PublicClient {
  return createPublicClient({ chain: CHAIN, transport: http(url, { retryCount: 0 }) });
}

/** The spend the live run was refused on, so the calldata in the request body is the real thing. */
const SPEND = encodeFunctionData({
  abi: mandateAccountAbi,
  functionName: 'spend',
  args: [
    {
      merchant: PROVIDER,
      capabilityId: `0x${'11'.repeat(32)}`,
      inputCommit: `0x${'22'.repeat(32)}`,
      inputURI: '',
      amount: 1_500_000n,
      deadline: 1_800_000_340n,
      spendClass: 0,
    },
    [],
  ],
});

async function thrownBy(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  throw new Error('the action was expected to fail and did not');
}

describe('revertFrom, on errors a node produced', () => {
  it('names a refusal raised by publicClient.call, which is what every preflight uses', async () => {
    reverting('eth_call', DAILY_CAP);

    const error = await thrownBy(() =>
      nodeClient().call({ account: AGENT, to: ACCOUNT, data: SPEND }),
    );

    expect(revertFrom(error)).toEqual({ errorName: 'DailyCapExceeded', args: [] });
  });

  it('names a refusal that came back through the failover pool', async () => {
    reverting('eth_call', DAILY_CAP);

    const connection = connect({ deployment: RHC_DEPLOYMENT, rpc: url, account: TEST_KEY });
    const error = await thrownBy(() =>
      connection.publicClient.call({ account: AGENT, to: ACCOUNT, data: SPEND }),
    );

    expect(revertFrom(error)?.errorName).toBe('DailyCapExceeded');
  });

  it('names an escrow error raised inside a call sent to the mandate account', async () => {
    reverting('eth_call', PAYEE_CAP);

    const error = await thrownBy(() =>
      nodeClient().readContract({ address: ACCOUNT, abi: mandateAccountAbi, functionName: 'nonce' }),
    );

    expect(revertFrom(error)?.errorName).toBe('PayeeCapExceeded');
  });

  it('keeps the arguments an error carried', async () => {
    reverting('eth_call', TOKEN_FAILED);

    const error = await thrownBy(() =>
      nodeClient().call({ account: AGENT, to: ACCOUNT, data: SPEND }),
    );

    expect(revertFrom(error)).toEqual({
      errorName: 'SafeERC20FailedOperation',
      args: ['0x3600000000000000000000000000000000000000'],
    });
  });

  it('reads the data out of a node that nests it under an error object', async () => {
    answering('eth_call', {
      error: { code: -32000, message: 'execution reverted', data: { data: DAILY_CAP } },
    });

    const error = await thrownBy(() =>
      nodeClient().call({ account: AGENT, to: ACCOUNT, data: SPEND }),
    );

    expect(revertFrom(error)?.errorName).toBe('DailyCapExceeded');
  });

  it('names a refusal the node raised on the broadcast rather than the simulation', async () => {
    reverting('eth_sendRawTransaction', DAILY_CAP);

    const { walletClient } = connect({ deployment: RHC_DEPLOYMENT, rpc: url, account: TEST_KEY });
    if (!walletClient) throw new Error('connect() was given a key and built no wallet client');

    const error = await thrownBy(() =>
      walletClient.sendTransaction({
        account: walletClient.account,
        chain: CHAIN,
        to: ACCOUNT,
        data: SPEND,
        gas: 500_000n,
        nonce: 0,
        maxFeePerGas: 22_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
    );

    expect(revertFrom(error)?.errorName).toBe('DailyCapExceeded');
  });

  it('reports nothing for a call that ran out of gas', async () => {
    answering('eth_estimateGas', {
      error: { code: -32000, message: 'out of gas: gas required exceeds allowance (30000000)' },
    });

    const error = await thrownBy(() => nodeClient().estimateGas({ to: ACCOUNT, data: SPEND }));

    expect(revertFrom(error)).toBeUndefined();
  });

  it('reports nothing for a revert that carried no data', async () => {
    reverting('eth_call', '0x');

    const error = await thrownBy(() =>
      nodeClient().call({ account: AGENT, to: ACCOUNT, data: SPEND }),
    );

    expect(revertFrom(error)).toBeUndefined();
  });

  it('reports nothing for a selector no deployed contract declares', async () => {
    reverting('eth_call', '0xdeadbeef');

    const error = await thrownBy(() =>
      nodeClient().call({ account: AGENT, to: ACCOUNT, data: SPEND }),
    );

    expect(revertFrom(error)).toBeUndefined();
  });

  it('does not dress an http failure up as a refusal', async () => {
    answering('eth_call', { status: 503 });

    const error = await thrownBy(() =>
      nodeClient().call({ account: AGENT, to: ACCOUNT, data: SPEND }),
    );

    expect(revertFrom(error)).toBeUndefined();
  });

  it('does not read the calldata in a dropped request as revert data', async () => {
    answering('eth_call', { drop: true });

    // The error viem raises quotes the request body, and this body's calldata opens with a real
    // error selector. A dropped socket reported as a spending limit would be the worst answer
    // `revertFrom` can give: it sends a caller looking for a limit that never fired.
    const error = await thrownBy(() =>
      nodeClient().call({ account: AGENT, to: ACCOUNT, data: DAILY_CAP }),
    );

    expect(revertFrom(error)).toBeUndefined();
  });

  it('does not dress a pool with every provider down up as a refusal', async () => {
    answering('eth_call', { drop: true });

    const connection = connect({ deployment: RHC_DEPLOYMENT, rpc: [url, url.replace('127.0.0.1', 'localhost')] });
    const error = await thrownBy(() =>
      connection.publicClient.call({ account: AGENT, to: ACCOUNT, data: DAILY_CAP }),
    );

    expect(revertFrom(error)).toBeUndefined();
  });
});

/**
 * What the caller is left holding. Naming the revert exists to produce the sentence at the end of
 * this path, so the sentence is asserted here and not inferred from the selector.
 */
describe('the message a refused spend produces', () => {
  const CHAIN_NOW = 1_800_000_000n;
  const DAILY = {
    cap: 3_000_000n,
    spent: 2_000_000n,
    duration: 86_400n,
    start: CHAIN_NOW - 72_000n,
    epoch: 3n,
  };
  const MONTHLY = {
    cap: 10_000_000n,
    spent: 2_000_000n,
    duration: 2_592_000n,
    start: CHAIN_NOW - 86_400n,
    epoch: 1n,
  };

  function answers(call: ReadCall): unknown {
    switch (call.functionName) {
      case 'escrow':
        return ADDRESSES.escrow;
      case 'settlementAsset':
        return ADDRESSES.settlementAsset;
      case 'reputation':
        return ADDRESSES.reputation;
      case 'registry':
        return ADDRESSES.agentRegistry;
      case 'minTtl':
        return 300n;
      case 'maxTtl':
        return 86_400n;
      case 'minLock':
        return 10_000n;
      case 'limits':
        return {
          perCallCap: 2_000_000n,
          dailyCap: 3_000_000n,
          monthlyCap: 10_000_000n,
          dailyWindow: 86_400n,
          monthlyWindow: 2_592_000n,
          approvalThreshold: 2_500_000n,
          validFrom: 0n,
          validUntil: 0n,
        };
      case 'remaining':
        return [2_000_000n, 1_000_000n, 8_000_000n];
      case 'window':
        return call.args[0] === WindowKind.Daily ? DAILY : MONTHLY;
      default:
        return undefined;
    }
  }

  it('names the bucket, what is left in it, and when it rolls', async () => {
    reverting('eth_call', DAILY_CAP);
    const fromTheNode = await thrownBy(() =>
      nodeClient().call({ account: AGENT, to: ACCOUNT, data: SPEND }),
    );

    const fake = fakeConnection({
      read: answers,
      blockTimestamp: CHAIN_NOW,
      simulate: () => {
        throw fromTheNode;
      },
    });

    const mandate = await mandateAccount(ACCOUNT, fake.connection);
    const denial = await thrownBy(() =>
      mandate.pay({ to: PROVIDER, amount: micro(1_500_000n), capability: 'doc.summarize:1' }),
    );

    expect(denial).toBeInstanceOf(MandateDeniedError);
    const error = denial as MandateDeniedError;

    expect(error.reason).toBe('daily-cap');
    expect(error.message).toContain('the daily limit has 1.00 USDG left of 3.00 USDG');
    expect(error.message).toContain('this call asks for 1.50 USDG');
    expect(error.message).toContain('The daily window resets at 2027-01-15T12:00:00.000Z');
    expect(error.resetsAt).toEqual(new Date(Number(DAILY.start + DAILY.duration) * 1000));
    expect(error.snapshot?.remaining.daily).toBe(1_000_000n);
  });
});
