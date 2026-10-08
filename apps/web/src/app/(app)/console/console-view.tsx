'use client';

import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { isZeroAddress, shortAddress } from '@/chain/rhc';
import { Address as AddressView } from '@/components/address';
import { Badge } from '@/components/badge';
import { Button } from '@/components/button';
import { Card, EmptyState, Section, Skeleton } from '@/components/layout';
import { ErrorSurface } from '@/components/error-surface';
import { Stat, StatGrid } from '@/components/stat';
import { StatusList } from '@/components/status';
import { Table } from '@/components/table';
import { ConnectButton } from '@/wallet/connect-button';
import { usd } from '@/money';
import { useMandates, useSystemState } from '@/state';
import { exampleMandate } from '@/chain/mandates';
import type { MandateSummary } from '@/chain/mandates';
import { AddressInput, readAddress } from '@/components/address-input';
import { useWalletAccount } from '@/wallet/account';
import { readingOf, refusalOf } from './lib/reading';
import type { Reading } from './lib/reading';

/** Where a visitor with no wallet can go next. */
function StartLinks() {
  const example = exampleMandate();
  return (
    <>
      {example !== undefined && (
        <Link href={`/console/${example}`}>
          <Button size="sm">See an example mandate</Button>
        </Link>
      )}
      <Link href="/workspace">
        <Button size="sm">Open the workspace</Button>
      </Link>
      <Link href="/console/new">
        <Button tone="primary" size="sm">
          Create a mandate
        </Button>
      </Link>
    </>
  );
}

/**
 * Every mandate the connected wallet owns.
 *
 * The figures in the table are what each account has left, not what it was granted, read from the
 * accounts themselves in two requests however many there are. A mandate that is paused or
 * has no agent says so here, because that is the difference between a quiet agent and a stopped one.
 */
export function ConsoleView() {
  const { address: owner, isConnected } = useWalletAccount();
  const system = useSystemState();
  const list = useMandates(owner);
  const router = useRouter();

  if (!isConnected || owner === undefined) {
    return (
      <div className="space-y-8">
        <Section
          title="Console"
          description="A mandate is an account your AI agent pays from, inside limits you set and the contract enforces."
          actions={<StartLinks />}
        >
          <EmptyState title="Connect a wallet to see your mandates." action={<ConnectButton />}>
            Your wallet owns the mandates it creates and can stop any of them in one transaction. To look around first,
            open the example mandate or draft terms in the workspace.
          </EmptyState>
        </Section>

        <Section
          title="Open a mandate by address"
          description="Paste a mandate's address to read its limits and payments. No wallet needed."
        >
          <Card>
            <OpenByAddress />
          </Card>
        </Section>

        <Section title="Current conditions" description="What stands between an agent and a settled payment, checked live.">
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

  // A sum over a list that never arrived is zero, and zero reads as an answer. The reading below
  // decides whether these three are figures at all.
  const reading = readingOf(!list.isLoading, list.error);
  const held = list.mandates.reduce((carry, entry) => micro(carry + entry.balance), micro(0n) as Micro);
  const leftToday = list.mandates.reduce((carry, entry) => micro(carry + entry.dailyRemaining), micro(0n) as Micro);
  const stopped = list.mandates.filter((entry) => entry.paused || entry.revoked).length;

  return (
    <div className="space-y-10">
      <Section
        title="Console"
        description="Mandates this wallet owns."
        actions={
          <>
            <Link href="/workspace">
              <Button size="sm">Drafts in your workspace</Button>
            </Link>
            <Link href="/console/private">
              <Button size="sm">Private mandates</Button>
            </Link>
            <Link href="/console/shielded">
              <Button size="sm">Shielded funds</Button>
            </Link>
            <Link href="/console/new">
              <Button tone="primary" size="sm">
                Create a mandate
              </Button>
            </Link>
          </>
        }
      >
        {/* A wallet with no mandates gets the empty state below, not three zeroes. */}
        {!(reading.state === 'read' && list.mandates.length === 0) && (
        <Card>
          <StatGrid columns={3}>
            <Stat
              label="Mandates"
              value={<Figure reading={reading}>{list.mandates.length}</Figure>}
              hint={hintFor(reading, stopped === 0 ? 'All of them are running.' : `${stopped} paused or without an agent.`)}
              level={reading.state !== 'read' ? 'unknown' : stopped > 0 ? 'attention' : 'ok'}
            />
            <Stat
              label="Held across all of them"
              value={<Figure reading={reading}>{usd(held)}</Figure>}
              hint={hintFor(reading, 'Available to pay providers.')}
              level={reading.state === 'read' ? undefined : 'unknown'}
            />
            <Stat
              label="Left this period"
              value={<Figure reading={reading}>{usd(leftToday)}</Figure>}
              hint={hintFor(reading, "The sum across mandates. Each mandate's own limits still apply.")}
              level={reading.state === 'read' ? undefined : 'unknown'}
            />
          </StatGrid>
        </Card>
        )}
      </Section>

      <Section title="Your mandates" description="What each one has left right now.">
        <Card>
          {list.error ? (
            <ErrorSurface error={list.error} action="Reading your mandates" onRetry={list.refresh} />
          ) : list.isLoading ? (
            <div className="space-y-2">
              <Skeleton height={18} />
              <Skeleton width="70%" height={18} />
            </div>
          ) : (
            <Table
              rows={list.mandates}
              rowKey={(row) => row.address}
              caption="Mandates owned by the connected wallet"
              onRowClick={(row) => router.push(`/console/${row.address}`)}
              empty={
                <EmptyState
                  title="No mandates yet."
                  action={
                    <Link href="/console/new">
                      <Button tone="primary">Create one</Button>
                    </Link>
                  }
                >
                  Create one to give your agent its first budget.
                </EmptyState>
              }
              columns={[
                {
                  key: 'mandate',
                  header: 'Mandate',
                  cell: (row) => (
                    <Link href={`/console/${row.address}`} className="tabular text-detail underline underline-offset-2">
                      {shortAddress(row.address)}
                    </Link>
                  ),
                },
                {
                  key: 'agent',
                  header: 'Agent',
                  secondary: true,
                  cell: (row) =>
                    isZeroAddress(row.agent) ? (
                      <span className="text-detail text-[color:var(--color-muted)]">None seated</span>
                    ) : (
                      <AddressView value={row.agent} />
                    ),
                },
                { key: 'state', header: 'Status', cell: (row) => <State row={row} /> },
                { key: 'balance', header: 'Holds', align: 'right', cell: (row) => <span className="tabular">{usd(row.balance)}</span> },
                {
                  key: 'perCall',
                  header: 'Per payment',
                  align: 'right',
                  secondary: true,
                  cell: (row) => <span className="tabular">{usd(row.perCallCap)}</span>,
                },
                {
                  key: 'daily',
                  header: 'Left this period',
                  align: 'right',
                  cell: (row) => <span className="tabular">{usd(row.dailyRemaining)}</span>,
                },
                {
                  key: 'monthly',
                  header: 'Left in total',
                  align: 'right',
                  secondary: true,
                  cell: (row) => (
                    <span className="tabular">
                      {usd(row.monthlyRemaining)}
                      {!row.totalBudget && <span className="text-[color:var(--color-muted)]"> · rolling</span>}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Card>
      </Section>

      <Section
        title="Current conditions"
        description="Network and USDG checks, live. Open a mandate to see its own."
      >
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

/**
 * The way into a mandate for a reader with no wallet.
 *
 * Every screen under a mandate reads without one, and the only entry point used to be a list of
 * what a connected wallet owns, which leaves a treasurer holding an address and no door.
 */
function OpenByAddress() {
  const router = useRouter();
  const [text, setText] = useState('');
  const reading = readAddress(text);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (reading.value !== undefined) router.push(`/console/${reading.value}`);
      }}
    >
      <AddressInput
        label="Mandate account"
        value={text}
        onChange={setText}
        hint="The mandate's 0x address."
        action={
          <Button type="submit" tone="primary" disabled={reading.value === undefined}>
            Open it
          </Button>
        }
      />
    </form>
  );
}

/** A figure stands for itself only when the list under it arrived. Until then it says which it is. */
function Figure({ reading, children }: { readonly reading: Reading; readonly children: ReactNode }) {
  if (reading.state === 'loading') return <Skeleton width="3rem" height={22} />;
  if (reading.state === 'unreadable') return <>Unread</>;
  if (reading.state === 'refused') return <>Refused</>;
  return <>{children}</>;
}

function hintFor(reading: Reading, whenRead: string): string {
  switch (reading.state) {
    case 'loading':
      return 'Reading your mandates.';
    case 'unreadable':
      return 'Could not load. Try again below.';
    // This list comes off the contracts rather than the index, so a stated refusal is not a shape
    // it produces today. The case is handled anyway.
    case 'refused':
      return refusalOf(reading.error)?.condition ?? 'Could not load. Try again below.';
    case 'read':
      return whenRead;
  }
}

/**
 * The mandate's own state, and separately whether it holds anything.
 *
 * A running mandate with an empty account is running: it refuses a payment on funds, not on its
 * limits, and those are two different problems with two different fixes. One badge that says
 * "Unfunded" and stops there hides whether the owner also has to unpause it.
 */
function State({ row }: { readonly row: MandateSummary }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {row.revoked ? <Badge>Agent revoked</Badge> : row.paused ? <Badge>Paused</Badge> : <Badge tone="quiet">Running</Badge>}
      {row.balance === 0n && <Badge tone="quiet">Unfunded</Badge>}
    </span>
  );
}
