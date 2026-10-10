'use client';

import Link from 'next/link';

import { FundingPanel } from '@/app/(app)/console/[mandate]/funding-panel';
import { MandateScopeProvider, useMandateScope } from '@/app/(app)/console/[mandate]/mandate-scope';
import { deployment, explorerAddress, shortAddress } from '@/chain/rhc';
import { Card, EmptyState, Section, Skeleton } from '@/components/layout';

/**
 * The live funding panel on the example mandate, with the three steps written out above it.
 *
 * Nothing here is staged: the mandate is the one recorded for this network, the quote is Relay's
 * answer at the moment the amount is typed, and a deposit signed on this page lands USDG in it.
 */
export function RelayFundingDemo() {
  const mandate = deployment().examples.mandate;

  return (
    <div className="space-y-8">
      <Section
        title="Fund a mandate from Base, Arc or Solana"
        description="Hold USDC on another chain and fund a mandate from it in one step. Relay carries the transfer; USDG lands in the mandate on Robinhood Chain."
      >
        <Card>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>Choose the chain your USDC is on and type the amount. Relay quotes what the mandate receives, what it costs and how long it takes.</li>
            <li>Sign the deposit in your wallet. On Base and Arc that is your connected wallet; on Solana, your Solana wallet on Relay&#39;s own page.</li>
            <li>Watch the USDG land. Relay pays the mandate from its own balance on Robinhood Chain, usually within a minute, and the panel follows it until it does.</li>
          </ol>
          {mandate !== undefined && (
            <p className="mt-4 text-detail text-[color:var(--color-muted)]">
              The mandate below is live on Robinhood Chain at{' '}
              <a href={explorerAddress(mandate)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                {shortAddress(mandate)}
              </a>
              . Type an amount to see a quote; connect a wallet that holds USDC on Base or Arc to send one. The same panel sits on every mandate in the{' '}
              <Link href={`/console/${mandate}`} className="underline underline-offset-2">
                console
              </Link>
              .
            </p>
          )}
        </Card>
      </Section>

      {mandate === undefined ? (
        <EmptyState title="No example mandate is recorded for this network.">Open any mandate in the console to find the same panel.</EmptyState>
      ) : (
        <MandateScopeProvider address={mandate}>
          <ExamplePanel />
        </MandateScopeProvider>
      )}
    </div>
  );
}

function ExamplePanel() {
  const { standing } = useMandateScope();

  if (standing === 'checking') {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton height={18} />
        <Skeleton width="60%" height={18} />
      </div>
    );
  }
  if (standing !== 'mandate') {
    return <EmptyState title="The example mandate could not be read right now.">Reload the page, or open any mandate in the console.</EmptyState>;
  }
  return <FundingPanel />;
}
