import type { Micro } from '@bursar/core';
import { micro } from '@bursar/core';
import { isAddress, isHex } from 'viem';
import type { Address, Hex } from 'viem';

import type { SourceChain } from './chains';

/**
 * Relay's quote, read into the four numbers a treasurer decides on.
 *
 * `POST /quote` answers with the steps to sign, the fees in three currencies and a route tree a
 * screen has no use for. What a reader decides on is what leaves, what arrives, what it costs and
 * how long it takes, and those are the only fields that survive this parse. The steps survive too,
 * because they are what the wallet signs, byte for byte as Relay wrote them.
 */
export type QuoteInput = {
  /** Who deposits. An EVM address on Base or Arc, a base58 address on Solana. */
  readonly user: string;
  /** The mandate account. Relay pays it directly; nothing passes through this console. */
  readonly recipient: Address;
  readonly source: SourceChain;
  /** Atomic units of the source chain's USDC. */
  readonly amount: bigint;
  readonly destination: { readonly chainId: number; readonly currency: Address };
  /** Ask for an address to send to instead of transactions to sign. Relay keys this on Solana. */
  readonly depositAddress?: boolean;
};

/** The request body Relay takes, exactly as it is sent. */
export function quoteBody(input: QuoteInput): Record<string, unknown> {
  return {
    user: input.user,
    recipient: input.recipient,
    originChainId: input.source.chainId,
    destinationChainId: input.destination.chainId,
    originCurrency: input.source.usdc.address,
    destinationCurrency: input.destination.currency,
    amount: input.amount.toString(),
    tradeType: 'EXACT_INPUT',
    ...(input.depositAddress ? { useDepositAddress: true } : {}),
  };
}

export type EvmCall = {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly gas: bigint | undefined;
  readonly maxFeePerGas: bigint | undefined;
  readonly maxPriorityFeePerGas: bigint | undefined;
};

export type QuoteStep = {
  /** Relay's own name for the step: `approve`, `deposit`. */
  readonly id: string;
  readonly description: string;
  readonly calls: readonly EvmCall[];
};

export type FundingQuote = {
  readonly requestId: Hex;
  readonly source: {
    readonly chainId: number;
    readonly symbol: string;
    readonly decimals: number;
    readonly amount: bigint;
  };
  /** USDG, six decimals, so a micro-USD figure. Relay promises at least `minimum`. */
  readonly arrives: { readonly expected: Micro; readonly minimum: Micro };
  /** In USD, six decimals, as Relay prices them at quote time. */
  readonly fees: {
    /** Relay's fee for carrying the transfer, service and destination gas together. */
    readonly relay: Micro;
    /** Gas the depositor pays on the source chain. */
    readonly gas: Micro;
    readonly total: Micro;
  };
  /** Relay's estimate from deposit to arrival. */
  readonly seconds: number;
  /** Transactions to sign on the source chain, in order. Empty on Solana and behind a deposit address. */
  readonly steps: readonly QuoteStep[];
  /** Where to send the funds instead, when one was asked for and Relay gave one. */
  readonly depositAddress: string | undefined;
  /** The step carries Solana instructions, which only a Solana wallet can sign. */
  readonly needsSolanaWallet: boolean;
};

export class RelayQuoteError extends Error {
  readonly code: string | undefined;
  readonly status: number | undefined;

  constructor(message: string, options: { readonly code?: string; readonly status?: number } = {}) {
    super(message);
    this.name = 'RelayQuoteError';
    this.code = options.code;
    this.status = options.status;
  }
}

/**
 * What Relay's refusal means to the person typing the amount.
 *
 * Relay answers a quote it will not give with `{ message, errorCode }`. The codes that come from
 * the amount or the route get a sentence that says what to change; the rest get Relay's own words,
 * which are usually readable.
 */
export function quoteRefusal(body: unknown, status?: number): RelayQuoteError {
  const record = asRecord(body);
  const code = typeof record?.['errorCode'] === 'string' ? record['errorCode'] : undefined;
  const message = typeof record?.['message'] === 'string' ? record['message'] : undefined;

  const line = (() => {
    switch (code) {
      case 'AMOUNT_TOO_LOW':
        return 'Relay will not carry an amount this small. Enter more.';
      case 'AMOUNT_TOO_HIGH':
      case 'INSUFFICIENT_LIQUIDITY':
      case 'SOLVER_CAPACITY_EXCEEDED':
        return 'Relay cannot carry this much right now. Enter less, or try again in a few minutes.';
      case 'NO_QUOTES':
      case 'UNSUPPORTED_ROUTE':
      case 'ROUTE_TEMPORARILY_RESTRICTED':
        return 'Relay is not carrying this route at the moment. Try again later.';
      case 'UNAUTHORIZED':
      case 'UNAUTHORIZED_QUOTE':
        return 'Relay asked this console for an API key it does not have.';
      default:
        return message ?? (status === undefined ? 'Relay did not answer.' : `Relay answered ${status} without a reason.`);
    }
  })();

  return new RelayQuoteError(line, { ...(code === undefined ? {} : { code }), ...(status === undefined ? {} : { status }) });
}

/** Reads a quote body. Throws `RelayQuoteError` on anything that is not one. */
export function parseQuote(body: unknown): FundingQuote {
  const record = asRecord(body);
  if (record === undefined) throw new RelayQuoteError('Relay answered with something that is not a quote.');
  if ('errorCode' in record || !('steps' in record)) throw quoteRefusal(record);

  const requestId = record['requestId'];
  if (typeof requestId !== 'string' || !isHex(requestId)) throw new RelayQuoteError('Relay gave this quote no request id.');

  const details = asRecord(record['details']);
  const currencyIn = asRecord(details?.['currencyIn']);
  const currencyOut = asRecord(details?.['currencyOut']);
  const inCurrency = asRecord(currencyIn?.['currency']);
  if (currencyIn === undefined || currencyOut === undefined || inCurrency === undefined) {
    throw new RelayQuoteError('Relay gave this quote no amounts.');
  }

  const fees = asRecord(record['fees']);
  const relay = usdOf(asRecord(fees?.['relayer']));
  const gas = usdOf(asRecord(fees?.['gas']));
  const app = usdOf(asRecord(fees?.['app']));

  const rawSteps = Array.isArray(record['steps']) ? record['steps'] : [];
  const steps = rawSteps.map(parseStep);
  const depositAddress = rawSteps
    .map((step) => asRecord(step)?.['depositAddress'])
    .find((address): address is string => typeof address === 'string' && address !== '');

  return {
    requestId,
    source: {
      chainId: numberOf(inCurrency['chainId']),
      symbol: typeof inCurrency['symbol'] === 'string' ? inCurrency['symbol'] : 'USDC',
      decimals: numberOf(inCurrency['decimals']),
      amount: bigintOf(currencyIn['amount']),
    },
    arrives: {
      expected: micro(bigintOf(currencyOut['amount'])),
      minimum: micro(bigintOf(currencyOut['minimumAmount'] ?? currencyOut['amount'])),
    },
    fees: { relay: micro(relay + app), gas: micro(gas), total: micro(relay + app + gas) },
    seconds: Math.max(0, numberOf(details?.['timeEstimate'])),
    steps: steps.filter((step) => step.calls.length > 0),
    depositAddress,
    needsSolanaWallet: rawSteps.some((step) =>
      (asArray(asRecord(step)?.['items']) ?? []).some((item) => asRecord(asRecord(item)?.['data'])?.['instructions'] !== undefined),
    ),
  };
}

function parseStep(raw: unknown): QuoteStep {
  const step = asRecord(raw) ?? {};
  const items = asArray(step['items']) ?? [];
  const calls = items.flatMap((item): EvmCall[] => {
    const data = asRecord(asRecord(item)?.['data']);
    const to = data?.['to'];
    const calldata = data?.['data'];
    if (data === undefined || typeof to !== 'string' || !isAddress(to) || typeof calldata !== 'string' || !isHex(calldata)) return [];
    return [
      {
        chainId: numberOf(data['chainId']),
        to,
        data: calldata,
        value: bigintOf(data['value'] ?? '0'),
        gas: optionalBigint(data['gas']),
        maxFeePerGas: optionalBigint(data['maxFeePerGas']),
        maxPriorityFeePerGas: optionalBigint(data['maxPriorityFeePerGas']),
      },
    ];
  });

  return {
    id: typeof step['id'] === 'string' ? step['id'] : 'step',
    description: typeof step['description'] === 'string' ? step['description'] : '',
    calls,
  };
}

/** A fee's `amountUsd`, a decimal string, as micro-USD. Absent is zero. */
function usdOf(fee: Record<string, unknown> | undefined): bigint {
  const raw = fee?.['amountUsd'];
  if (typeof raw !== 'string' || raw === '') return 0n;
  return decimalToMicro(raw);
}

/** "0.024867" → 24867n. Six places; anything finer is dropped, a sign is kept. */
export function decimalToMicro(decimal: string): bigint {
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(decimal.trim());
  if (match === null) return 0n;
  const [, sign, whole = '', fraction = ''] = match;
  const value = BigInt(whole === '' ? '0' : whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6) || '0');
  return sign === '-' ? -value : value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function numberOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

function bigintOf(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function optionalBigint(value: unknown): bigint | undefined {
  return value === undefined || value === null || value === '' ? undefined : bigintOf(value);
}
