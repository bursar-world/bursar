'use client';

import { useState } from 'react';

import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { NETWORK_CONDITIONS, StatusList } from '@/components/status';
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
        description="Agents pay providers through escrow, and a provider's record sets the largest job a payer can open."
      >
        <Card>
          <div className="space-y-4">
            <p className="max-w-prose text-sm">
              A payer locks USDG in escrow before the work starts, and you release it when you deliver. To be paid, your
              address joins the provider registry with a stake. A ruling against a job can take part of that stake.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button tone="primary" onClick={() => setConnecting(true)}>
                Connect a wallet
              </Button>
              <span className="text-detail text-[color:var(--color-muted)]">
                A wallet is only needed to sign.
              </span>
            </div>
          </div>
        </Card>
        <ConnectModal open={connecting} onClose={() => setConnecting(false)} />
      </Section>

      <Section
        title="Open a desk by address"
        description="Every provider's payments and record are public. Paste an address to read its desk."
      >
        <Card>
          <OpenDesk />
        </Card>
      </Section>

      <RegistryTerms />

      <Section title="Current conditions" description="The network and USDG, read live from Robinhood Chain.">
        <Card>
          <div className="space-y-3">
            <ErrorSurface error={system.error} action="Reading the current conditions" onRetry={system.refresh} />
            <StatusList system={system} only={NETWORK_CONDITIONS} />
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
      description="Live from the provider registry on Robinhood Chain."
      actions={
        <Button size="sm" onClick={refresh} disabled={isFetching}>
          {isFetching ? 'Reading' : 'Read again'}
        </Button>
      }
    >
      <Card>
        <div className="space-y-4">
          <ErrorSurface error={error} action="Reading the registry terms" onRetry={refresh} />
          <FieldGrid columns={4}>
            <Field label="Stake to join" hint="Paid in USDG and held by the registry">
              {show(lines.minStake)}
            </Field>
            <Field label="Most a ruling can take" hint="Share of the stake one ruling can take">
              {show(lines.slashBps)}
            </Field>
            <Field label="Wait to withdraw" hint="Between asking for the stake and taking it">
              {show(lines.withdrawalDelay)}
            </Field>
            <Field label="First job ceiling" hint="The largest job a payer can open with a new provider">
              {show(lines.baseCap)}
            </Field>
          </FieldGrid>

          {lines.pausedLine && (
            <p className="text-detail" style={{ color: 'var(--color-state-attention)' }}>
              {lines.pausedLine}
            </p>
          )}

          <p className="max-w-prose text-detail text-[color:var(--color-muted)]">
            {lines.curveLine ?? 'The score curve could not be read right now.'} Your score is the share of your jobs that
            were delivered{lines.creditLine === null ? '' : ', weighted by the credit that work earned'}. A job that missed
            its deadline or was contested counts against it.
          </p>
          {lines.creditLine !== null && (
            <p className="max-w-prose text-detail text-[color:var(--color-muted)]">
              {lines.creditLine ?? 'How score is earned could not be read right now.'}
            </p>
          )}
          <p className="max-w-prose text-detail text-[color:var(--color-muted)]">
            Only your score raises the job ceiling. Your stake is what payers see at risk behind your work.
          </p>
        </div>
      </Card>
    </Section>
  );
}
