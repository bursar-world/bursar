'use client';

import { useState } from 'react';

import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { StatusList } from '@/components/status';
import { useSystemState } from '@/state';
import { ConnectModal } from '@/wallet';
import { useWalletAccount } from '@/wallet/account';

import { DeskView } from './desk-view';
import { OpenDesk } from './open-desk';
import { useRegistryTerms } from './use-desk';

/**
 * The provider surface.
 *
 * Connected, it is the desk for the wallet the escrow pays. Unconnected, it is still a working
 * page: the registry's terms and any address's settlement record are public, so a payee weighing
 * BURSAR can read what a listing costs and how another provider has settled before they connect
 * anything. The console answers the same question from the payer's side.
 */
export function ProviderView() {
  const { address, isConnected } = useWalletAccount();

  if (isConnected && address) return <DeskView payee={address} owned />;

  return <Introduction />;
}

function Introduction() {
  const [connecting, setConnecting] = useState(false);
  const system = useSystemState();

  return (
    <div className="space-y-10">
      <Section
        title="Getting paid"
        description="Locks held against an address, the record they build, and the ceiling that record earns."
      >
        <Card>
          <div className="space-y-4">
            <p className="max-w-prose text-sm">
              A payer locks USDG in the escrow before the work starts, and the payee releases it on delivery. The escrow
              will only do that for an address the registry lists, so a provider joins the registry with a stake before
              anything can pay them. The stake is collateral a ruling is taken from, not a fee.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button tone="primary" onClick={() => setConnecting(true)}>
                Connect a wallet
              </Button>
              <span className="text-detail text-[color:var(--color-muted)]">
                Connecting is only needed to sign. Reading needs no wallet.
              </span>
            </div>
          </div>
        </Card>
        <ConnectModal open={connecting} onClose={() => setConnecting(false)} />
      </Section>

      <Section
        title="Open a desk by address"
        description="Escrow locks, the settlement record and the ceiling it earns are public. Reading one needs no wallet and signs nothing."
      >
        <Card>
          <OpenDesk />
        </Card>
      </Section>

      <RegistryTerms />

      <Section title="Current conditions" description="Read from this network whether or not a wallet is connected.">
        <Card>
          <div className="space-y-3">
            <ErrorSurface error={system.error} action="Reading the current conditions" onRetry={system.refresh} />
            <StatusList system={system} />
          </div>
        </Card>
      </Section>
    </div>
  );
}

/** What joining costs and what it risks, read from the registry rather than written into the page. */
function RegistryTerms() {
  const { lines, isLoading, isFetching, error, refresh } = useRegistryTerms();

  // Three renderings, never two: a figure still on its way is not a figure the registry refused to
  // give, and neither is a zero.
  const show = (value: string | undefined): string => value ?? (isLoading ? 'Reading' : 'Not read');

  return (
    <Section
      title="What a listing costs"
      description="Read live from the registry and the reputation curve on Robinhood Chain."
      actions={
        <Button size="sm" onClick={refresh} disabled={isFetching}>
          {isFetching ? 'Reading' : 'Read again'}
        </Button>
      }
    >
      <Card>
        <div className="space-y-4">
          <ErrorSurface error={error} action="read the registry terms" onRetry={refresh} />
          <FieldGrid columns={4}>
            <Field label="Stake to join" hint="Posted in USDG and held by the registry">
              {show(lines.minStake)}
            </Field>
            <Field label="Most a ruling can take" hint="Of the stake, per ruling. What is taken does not come back.">
              {show(lines.slashBps)}
            </Field>
            <Field label="Wait to withdraw" hint="Between asking for the stake and taking it">
              {show(lines.withdrawalDelay)}
            </Field>
            <Field label="First job ceiling" hint="The largest single lock a payer may open at a score of nothing">
              {show(lines.baseCap)}
            </Field>
          </FieldGrid>

          {lines.pausedLine && (
            <p className="text-detail" style={{ color: 'var(--color-state-attention)' }}>
              {lines.pausedLine}
            </p>
          )}

          <p className="max-w-prose text-detail text-[color:var(--color-muted)]">
            {lines.curveLine ??
              'The reputation curve could not be read, so what a score is worth is unknown on this reading.'}{' '}
            Score is delivered jobs as a share of every job that reached an outcome
            {lines.creditLine === null ? '' : ', scaled by the credit that work has earned'}. A job that ran past its
            deadline or was contested counts as settled and not as delivered.
          </p>
          {lines.creditLine !== null && (
            <p className="max-w-prose text-detail text-[color:var(--color-muted)]">
              {lines.creditLine ?? 'How a point is earned could not be read on this reading.'}
            </p>
          )}
          <p className="max-w-prose text-detail text-[color:var(--color-muted)]">
            The stake does not raise the ceiling on a single job; only the score does. Deeper collateral is what a
            principal reads before allowlisting an address, and it is what a ruling is taken from.
          </p>
        </div>
      </Card>
    </Section>
  );
}
