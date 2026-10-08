'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { onCurrentSet } from '@/chain/deployments';
import { Address } from '@/components/address';
import { Badge } from '@/components/badge';
import { Button } from '@/components/button';
import { EmptyState, Skeleton } from '@/components/layout';
import { ErrorSurface } from '@/components/error-surface';
import { StatusStrip } from '@/components/status';
import { usd } from '@/money';
import { SwitchNetworkButton } from '@/wallet/switch-network';
import { useMandateScope } from './mandate-scope';
import type { MandateStanding } from './mandate-scope';

/** The header and the sub-navigation every mandate screen sits under. */
export function MandateChrome({ children }: { readonly children: ReactNode }) {
  const { address, account, system, isOwner, ownerOffChain, connected, refresh, ledger, standing, standingError } = useMandateScope();
  const pathname = usePathname();
  const base = `/console/${address}`;

  // Until the factory has vouched for the account, nothing below renders: no balance, no badges, no
  // tabs, no owner note, no controls. A look-alike contract would otherwise get the full console on
  // this domain for as long as the check takes, and that is long enough to be screenshotted.
  if (standing !== 'mandate' || account === undefined) {
    return (
      <div className="space-y-8">
        <div className="min-w-0 space-y-2">
          <Link href="/console" className="font-mono text-label uppercase tracking-wide text-[color:var(--color-muted)] transition-colors hover:text-[color:var(--color-ink)]">
            All mandates
          </Link>
          <h1 className="page-title">Mandate</h1>
          <Address value={address} full />
        </div>
        <Unvouched standing={standing} error={standingError} onRetry={refresh} />
      </div>
    );
  }

  const earlier = !onCurrentSet(account.contractSet);
  const tabs = [
    { href: base, label: 'Overview' },
    { href: `${base}/approvals`, label: 'Approvals' },
    { href: `${base}/settlements`, label: 'Settlements' },
    { href: `${base}/exceptions`, label: 'Exceptions' },
  ];

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <Link href="/console" className="font-mono text-label uppercase tracking-wide text-[color:var(--color-muted)] transition-colors hover:text-[color:var(--color-ink)]">
              All mandates
            </Link>
            <h1 className="page-title">Mandate</h1>
            <Address value={address} full />
          </div>
          <div className="flex items-center gap-2">
            <span className="tabular text-sm">{usd(account.balance)}</span>
            <Button size="sm" onClick={refresh} disabled={system.isFetching || ledger.isFetching}>
              {system.isFetching || ledger.isFetching ? 'Checking' : 'Check again'}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {account.paused && <Badge>Paused</Badge>}
          {account.revoked && <Badge>Agent revoked</Badge>}
          <Badge tone="quiet">Version {account.version.toString()}</Badge>
          {earlier && <Badge tone="quiet">Earlier contracts</Badge>}
          <StatusStrip system={system} />
        </div>

        {earlier && (
          <p className="max-w-3xl text-detail text-[color:var(--color-muted)]">
            This mandate runs on earlier contracts and works as before. Stocks, parking and collateral are available on new
            mandates.
          </p>
        )}

        {ownerOffChain && (
          <SwitchNetworkButton reason="Your wallet owns this mandate. Switch to Robinhood Chain to manage it." />
        )}

        {connected !== undefined && !isOwner && !ownerOffChain && (
          <p className="text-detail text-[color:var(--color-muted)]">
            This mandate belongs to another address. Connect the owner's wallet to make changes.
          </p>
        )}
      </div>

      <nav aria-label="Mandate" className="flex gap-2 overflow-x-auto border-b border-[color:var(--color-line)]">
        {tabs.map((tab) => {
          const active = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-3 font-mono text-note uppercase tracking-wide transition-colors ${
                active
                  ? 'border-[color:var(--color-primary)] text-[color:var(--color-ink)]'
                  : 'border-transparent text-[color:var(--color-muted)] hover:text-[color:var(--color-ink)]'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {children}
    </div>
  );
}

/** Every answer about the address other than "a mandate the factory made". */
export function Unvouched({
  standing,
  error,
  onRetry,
}: {
  readonly standing: MandateStanding;
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  if (standing === 'foreign') {
    return (
      <EmptyState
        title="This address is not a BURSAR mandate."
        action={
          <Link href="/console" className="text-detail underline underline-offset-2">
            Open the console
          </Link>
        }
      >
        BURSAR did not create the contract at this address, so the console shows no controls for it. If someone sent
        you this link, confirm the address with them before you fund or sign anything.
      </EmptyState>
    );
  }

  if (standing === 'absent') {
    return (
      <EmptyState
        title="This address is not a BURSAR mandate."
        action={
          <Link href="/console" className="text-detail underline underline-offset-2">
            Open the console
          </Link>
        }
      >
        Check the address, or create a mandate from the console.
      </EmptyState>
    );
  }

  // No reading landed at all, which is a different answer from an address holding no account.
  if (standing === 'unread' && error) {
    return <ErrorSurface error={error} action="Reading this mandate" onRetry={onRetry} />;
  }

  return (
    <div className="space-y-2" aria-busy="true">
      <Skeleton height={18} />
      <Skeleton width="60%" height={18} />
    </div>
  );
}
