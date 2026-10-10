import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { micro } from '@bursar/core';

import { FundFromChainView, formatSource } from '@/app/(app)/console/[mandate]/fund-from-chain-view';
import type { Carried, FundFromChainViewProps, FundingPhase } from '@/app/(app)/console/[mandate]/fund-from-chain-view';
import { SOURCE_CHAINS, parseQuote, parseStatus, relayBridgeLink, sourceChain } from '@/relay';
import type { SourceChain } from '@/relay';
import base from './fixtures/relay/quote-base.json';
import solana from './fixtures/relay/quote-solana.json';

/**
 * Each face of the panel, rendered from its phase alone: what the reader sees while Relay is
 * asked, once it has answered, while the deposit is on its way, when the USDG lands and when it
 * does not.
 */
const MANDATE = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c' as Address;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;
const DEPOSIT = '0x1111111111111111111111111111111111111111111111111111111111111111';
const FILL = '0x2222222222222222222222222222222222222222222222222222222222222222' as Hex;

const chain = (key: string): SourceChain => sourceChain(key) as SourceChain;
const quote = parseQuote(base);

const carried: Carried = { requestId: quote.requestId, sourceKey: 'base', sends: 500_000n, expected: quote.arrives.expected, depositHash: DEPOSIT };

function face(phase: FundingPhase, over: Partial<FundFromChainViewProps> = {}): string {
  const source = over.source ?? chain('base');
  return renderToStaticMarkup(
    <FundFromChainView
      sources={SOURCE_CHAINS}
      source={source}
      recipient={MANDATE}
      amountText="0.50"
      amountProblem={undefined}
      phase={phase}
      connected
      sourceBalance={1_000_000n}
      noGas={false}
      relayLink={relayBridgeLink({ source, recipient: MANDATE, destinationCurrency: USDG, amount: '0.50' })}
      onSource={() => undefined}
      onAmount={() => undefined}
      onFund={() => undefined}
      onReset={() => undefined}
      {...over}
    />,
  );
}

describe('every face', () => {
  const phases: readonly FundingPhase[] = [
    { kind: 'idle' },
    { kind: 'quoting' },
    { kind: 'quoted', quote },
    { kind: 'refused', reason: 'Relay will not carry an amount this small. Enter more.' },
    { kind: 'signing', quote, step: 'approve' },
    { kind: 'awaiting', carried, status: undefined },
    { kind: 'arrived', carried, fillHash: FILL, landed: micro(475_067n) },
    { kind: 'failed', carried, reason: 'Relay could not complete the transfer.', refundHash: undefined },
  ];

  it('names Relay as the carrier and uses no machine tells', () => {
    for (const phase of phases) {
      const markup = face(phase);
      expect(markup).toContain('Relay');
      expect(markup).not.toContain('—');
      expect(markup).not.toMatch(/not [a-z ]+, but/i);
    }
  });
});

describe('while Relay is asked', () => {
  it('says so and keeps the form open', () => {
    const markup = face({ kind: 'quoting' });
    expect(markup).toContain('Asking Relay for a quote.');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('USDC on Base');
  });
});

describe('a quote from Base', () => {
  const markup = face({ kind: 'quoted', quote });

  it('says what leaves, what arrives, what it costs and how long', () => {
    expect(markup).toContain('You send');
    expect(markup).toContain('0.50 USDC');
    expect(markup).toContain('The mandate receives');
    expect(markup).toContain('$0.48');
    expect(markup).toContain('At least $0.45 if the price moves.');
    expect(markup).toContain('It costs');
    expect(markup).toContain('$0.03');
    expect(markup).toContain('Relay&#x27;s fee of $0.02 plus about $0.00 in network fees on Base.');
    expect(markup).toContain('Seconds');
  });

  it('offers the deposit in the connected wallet', () => {
    expect(markup).toContain('Fund from Base');
    expect(markup).toContain('Your wallet holds 1.00 USDC on Base.');
  });

  it('asks for a wallet when none is connected', () => {
    const alone = face({ kind: 'quoted', quote }, { connected: false, sourceBalance: undefined });
    expect(alone).toContain('Connect a wallet that holds USDC on Base to sign the deposit.');
    expect(alone).toContain('disabled=""');
  });

  it('says when the wallet cannot pay the network fee', () => {
    const dry = face({ kind: 'quoted', quote }, { noGas: true });
    expect(dry).toContain('Your wallet holds no ETH on Base for the network fee');
  });

  it('keeps the wallet note when a signature was declined', () => {
    expect(face({ kind: 'quoted', quote, note: 'Your wallet did not sign, so nothing was sent.' })).toContain('Your wallet did not sign, so nothing was sent.');
  });
});

describe('a quote from Solana', () => {
  const priced = parseQuote(solana);

  it('sends the reader to Relay with the mandate as the recipient when there is no deposit address', () => {
    const markup = face({ kind: 'quoted', quote: priced }, { source: chain('solana') });
    expect(markup).toContain('This console has no Solana wallet.');
    expect(markup).toContain('Open the route on Relay');
    expect(markup).toContain(`toAddress=${MANDATE}`);
    expect(markup).toContain('fromChainId=792703809');
    expect(markup).toContain('Watch for it here');
    expect(markup).not.toContain('Fund from Solana');
  });

  it('shows the deposit address when Relay gave one', () => {
    const markup = face({ kind: 'quoted', quote: { ...priced, depositAddress: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' } }, { source: chain('solana') });
    expect(markup).toContain('Send the USDC to this Solana address');
    expect(markup).toContain('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
    expect(markup).toContain('I have sent it');
  });
});

describe('while the deposit is on its way', () => {
  it('waits for the deposit, with the deposit linked on Base', () => {
    const markup = face({ kind: 'awaiting', carried, status: undefined });
    expect(markup).toContain('Waiting for the deposit');
    expect(markup).toContain(`https://basescan.org/tx/${DEPOSIT}`);
    expect(markup).toContain('Your deposit on Base');
    expect(markup).toContain(`https://relay.link/transaction/${quote.requestId}`);
    expect(markup).toContain('$0.48');
    expect(markup).toContain('aria-live="polite"');
  });

  it('says Relay is paying once the deposit is seen', () => {
    const markup = face({ kind: 'awaiting', carried, status: parseStatus({ status: 'pending' }) });
    expect(markup).toContain('Relay is paying the mandate');
  });

  it('names a delay on Relay as a delay', () => {
    expect(face({ kind: 'awaiting', carried, status: parseStatus({ status: 'delayed' }) })).toContain('Relay reports a delay on its side.');
  });

  it('hides the form controls', () => {
    expect(face({ kind: 'awaiting', carried, status: undefined })).toContain('disabled=""');
  });
});

describe('when the USDG lands', () => {
  const markup = face({ kind: 'arrived', carried, fillHash: FILL, landed: micro(475_067n) });

  it('shows what landed and links the landing on Robinhood Chain', () => {
    expect(markup).toContain('Arrived');
    expect(markup).toContain('$0.48');
    expect(markup).toContain('USDG is in the mandate and pays providers from now.');
    expect(markup).toContain('The USDG landing on Robinhood Chain');
    expect(markup).toContain(FILL);
    expect(markup).toContain('Fund again');
  });

  it('falls back to the quoted amount when the receipt was not read', () => {
    expect(face({ kind: 'arrived', carried, fillHash: undefined, landed: undefined })).toContain('$0.48');
    expect(face({ kind: 'arrived', carried: { ...carried, expected: undefined }, fillHash: undefined, landed: undefined })).toContain('USDG landed');
  });
});

describe('when it does not', () => {
  it('says why, links the refund, and offers a fresh start', () => {
    const refund = '0x3333333333333333333333333333333333333333333333333333333333333333';
    const markup = face({ kind: 'failed', carried, reason: 'The price moved past what the quote allowed before Relay could fill it. The funds were returned on Base.', refundHash: refund });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('The funds were returned on Base.');
    expect(markup).toContain(`https://basescan.org/tx/${refund}`);
    expect(markup).toContain('Start over');
  });

  it('shows a refusal with the form still open', () => {
    const markup = face({ kind: 'refused', reason: 'Relay will not carry an amount this small. Enter more.' });
    expect(markup).toContain('Relay will not carry an amount this small. Enter more.');
    expect(markup).toContain('USDC on Base');
  });
});

describe('source amounts', () => {
  it('read as money, two to six places', () => {
    expect(formatSource(500_000n, chain('base'))).toBe('0.50 USDC');
    expect(formatSource(475_067n, chain('arc'))).toBe('0.475067 USDC');
    expect(formatSource(50_000_000n, chain('base'))).toBe('50.00 USDC');
  });
});
