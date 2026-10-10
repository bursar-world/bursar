import { describe, expect, it } from 'vitest';

import { RelayQuoteError, decimalToMicro, parseQuote, quoteBody, quoteRefusal, sourceChain } from '@/relay';
import type { SourceChain } from '@/relay';
import base from './fixtures/relay/quote-base.json';
import arc from './fixtures/relay/quote-arc.json';
import solana from './fixtures/relay/quote-solana.json';
import depositAddress from './fixtures/relay/quote-base-deposit-address.json';

/**
 * Relay's quote, as it answered on 2026-10-10 for 0.50 USDC into the example mandate, read into
 * the four numbers the panel shows and the calls the wallet signs.
 */
const MANDATE = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

const chain = (key: string): SourceChain => sourceChain(key) as SourceChain;

describe('a quote from Base', () => {
  const quote = parseQuote(base);

  it('reads what leaves and what arrives in atomic units', () => {
    expect(quote.requestId).toBe('0x1791646936f1d16d8382506cfcd732c9ee7f8ac82ab543b57059161201327d46');
    expect(quote.source).toEqual({ chainId: 8453, symbol: 'USDC', decimals: 6, amount: 500_000n });
    expect(quote.arrives.expected).toBe(475_119n);
    expect(quote.arrives.minimum).toBe(453_643n);
  });

  it('prices the fees in micro-USD, Relay and gas apart', () => {
    expect(quote.fees.relay).toBe(24_813n);
    expect(quote.fees.gas).toBe(1_264n);
    expect(quote.fees.total).toBe(26_077n);
    expect(quote.seconds).toBe(1);
  });

  it('keeps the two calls to sign, byte for byte, on the source chain', () => {
    expect(quote.steps.map((step) => step.id)).toEqual(['approve', 'deposit']);
    const [approve, deposit] = quote.steps;
    expect(approve?.calls[0]).toMatchObject({ chainId: 8453, to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', value: 0n, gas: 73_112n });
    expect(approve?.calls[0]?.data.startsWith('0x095ea7b3')).toBe(true);
    expect(deposit?.calls[0]).toMatchObject({ chainId: 8453, to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', value: 0n, gas: 76_194n });
    expect(quote.depositAddress).toBeUndefined();
    expect(quote.needsSolanaWallet).toBe(false);
  });
});

describe('a quote from Arc', () => {
  it('signs on chain 5042 against the six-decimal USDC', () => {
    const quote = parseQuote(arc);
    expect(quote.source.chainId).toBe(5042);
    expect(quote.steps.every((step) => step.calls.every((call) => call.chainId === 5042))).toBe(true);
    expect(quote.steps[0]?.calls[0]?.to).toBe('0x3600000000000000000000000000000000000000');
    expect(quote.arrives.expected).toBe(474_845n);
  });
});

describe('a quote from Solana', () => {
  it('carries no EVM call and says a Solana wallet has to sign', () => {
    const quote = parseQuote(solana);
    expect(quote.steps).toEqual([]);
    expect(quote.needsSolanaWallet).toBe(true);
    expect(quote.arrives.expected).toBe(475_009n);
    expect(quote.fees.gas).toBe(22_054n);
  });
});

describe('a quote with a deposit address', () => {
  it('names the address and a plain transfer to it', () => {
    const quote = parseQuote(depositAddress);
    expect(quote.depositAddress).toBe('0x55747ed92b3ab2f5e8c84174c97edd96cd74c30b');
    expect(quote.steps).toHaveLength(1);
    expect(quote.steps[0]?.calls[0]?.to).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(quote.steps[0]?.calls[0]?.gas).toBeUndefined();
  });
});

describe('the request Relay is sent', () => {
  it('is the documented body, EXACT_INPUT, into USDG on 4663', () => {
    expect(
      quoteBody({ user: '0x877c349EFb5926082C413833E8055F0991185c61', recipient: MANDATE, source: chain('base'), amount: 500_000n, destination: { chainId: 4663, currency: USDG } }),
    ).toEqual({
      user: '0x877c349EFb5926082C413833E8055F0991185c61',
      recipient: MANDATE,
      originChainId: 8453,
      destinationChainId: 4663,
      originCurrency: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      destinationCurrency: USDG,
      amount: '500000',
      tradeType: 'EXACT_INPUT',
    });
  });

  it('asks for a deposit address only when told to, with Relay number for Solana', () => {
    const body = quoteBody({ user: MANDATE, recipient: MANDATE, source: chain('solana'), amount: 1n, destination: { chainId: 4663, currency: USDG }, depositAddress: true });
    expect(body['originChainId']).toBe(792703809);
    expect(body['useDepositAddress']).toBe(true);
  });
});

describe('what Relay refuses', () => {
  it('turns the amount codes into what to change', () => {
    expect(quoteRefusal({ message: 'x', errorCode: 'AMOUNT_TOO_LOW' }).message).toBe('Relay will not carry an amount this small. Enter more.');
    expect(quoteRefusal({ message: 'x', errorCode: 'INSUFFICIENT_LIQUIDITY' }).message).toContain('Enter less');
  });

  it('names the key when Relay asks for one', () => {
    const refusal = quoteRefusal({ message: 'This request is missing an api key and cannot use a deposit address', errorCode: 'UNAUTHORIZED' }, 401);
    expect(refusal.code).toBe('UNAUTHORIZED');
    expect(refusal.status).toBe(401);
    expect(refusal.message).toContain('API key');
  });

  it("keeps Relay's own words for a code it does not know", () => {
    expect(quoteRefusal({ message: 'Route is paused', errorCode: 'SOMETHING_NEW' }).message).toBe('Route is paused');
    expect(quoteRefusal('not json', 500).message).toBe('Relay answered 500 without a reason.');
  });

  it('is what an error body parses to', () => {
    expect(() => parseQuote({ message: 'nope', errorCode: 'NO_QUOTES' })).toThrow(RelayQuoteError);
    expect(() => parseQuote({ steps: [] })).toThrow('request id');
  });
});

describe('decimal strings', () => {
  it('read to six places, keep the sign, drop the rest', () => {
    expect(decimalToMicro('0.024867')).toBe(24_867n);
    expect(decimalToMicro('-0.024932')).toBe(-24_932n);
    expect(decimalToMicro('50')).toBe(50_000_000n);
    expect(decimalToMicro('0.0000004967')).toBe(0n);
    expect(decimalToMicro('')).toBe(0n);
  });
});
