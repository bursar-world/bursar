'use client';

import { micro, mulBps, subMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { LockStatus } from '@bursar/sdk';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Hex } from 'viem';

import { bareLabel } from '@/chain/capabilities';
import { shortAddress } from '@/chain/rhc';
import { Address as AddressView, TxHash } from '@/components/address';
import { LevelDot } from '@/components/badge';
import { Card, Section, Skeleton } from '@/components/layout';
import { Countdown, Instant } from '@/components/instant';
import { ErrorSurface } from '@/components/error-surface';
import { Stat, StatGrid } from '@/components/stat';
import { Table } from '@/components/table';
import { usd, usdExact } from '@/money';
import { useCapabilityLabels } from '../../lib/capability-labels';
import { OVERDUE_WORD, contestable, lockDetail, lockLevel, lockWord, returnable } from '../../lib/format';
import type { LockEvents, MandateEvent } from '../../lib/activity';
import type { LockRecord } from '../../lib/reads';
import { refusalOf, weaker } from '../../lib/reading';
import type { Reading } from '../../lib/reading';
import { useMandateScope } from '../mandate-scope';

type Row = {
  readonly key: string;
  readonly spent: Extract<MandateEvent, { kind: 'spent' }>;
  readonly lock: LockRecord | undefined;
  readonly events: LockEvents | undefined;
};

/**
 * Every payment this mandate has made, and what became of it.
 *
 * The row is a spend the account recorded. Its outcome is read from the escrow, because the escrow
 * is where the money is: a payment that left the mandate and a payment the provider claimed are two
 * different facts and this screen keeps them apart.
 */
export function SettlementsView() {
  const { address, account, ledger, system, isOwner } = useMandateScope();
  const { labelFor } = useCapabilityLabels();
  const feeBps = system.snapshot?.escrow.feeBps;
  const disputeWindow = system.snapshot?.escrow.disputeWindow;

  const rows: readonly Row[] = ledger.events
    .filter((event): event is Extract<MandateEvent, { kind: 'spent' }> => event.kind === 'spent')
    .map((spent) => ({
      key: `${spent.transactionHash}:${spent.logIndex}`,
      spent,
      lock: ledger.locks.get(spent.escrowId.toString()),
      events: ledger.lockEvents.get(spent.escrowId.toString()),
    }));

  const history = ledger.timeline;
  // A row is a spend the index reported, and its outcome is a lock the escrow reported. The split
  // between paid, held and returned is a figure only once both of them have answered.
  const outcomes = weaker(history, ledger.chain);

  const totals = rows.reduce(
    (carry, row) => {
      const status = row.lock?.status;
      // A ruling splits the payment: what came back is the refund, and the rest is spent for good.
      const ruled = status === LockStatus.Resolved ? row.events?.resolved : undefined;
      if (ruled !== undefined) {
        return { ...carry, paid: add(carry.paid, micro(row.spent.amount - ruled.refunded)), returned: add(carry.returned, ruled.refunded) };
      }
      if (status === LockStatus.Released || status === LockStatus.Resolved) return { ...carry, paid: add(carry.paid, row.spent.amount) };
      if (status === LockStatus.Locked) {
        const overdue = returnable(row.lock, ledger.chainTime) ? add(carry.overdue, row.spent.amount) : carry.overdue;
        return { ...carry, held: add(carry.held, row.spent.amount), overdue };
      }
      if (status === LockStatus.TimedOut || status === LockStatus.Cancelled) return { ...carry, returned: add(carry.returned, row.spent.amount) };
      return carry;
    },
    { paid: micro(0n), held: micro(0n), overdue: micro(0n), returned: micro(0n) },
  );

  return (
    <div className="space-y-8">
      <Section title="Settlements" description="What this mandate paid, to whom, and for what.">
        <Card>
          <StatGrid columns={3}>
            <Stat
              label="Settled"
              value={<Figure reading={outcomes}>{usd(totals.paid)}</Figure>}
              hint={figureHint(outcomes, 'Delivered and paid for.')}
              level={outcomes.state === 'read' ? 'ok' : 'unknown'}
            />
            <Stat
              label="Held by the escrow"
              value={<Figure reading={outcomes}>{usd(totals.held)}</Figure>}
              hint={figureHint(
                outcomes,
                // Past its deadline the provider can no longer claim it, and the money is the owner's
                // to take back. "Waiting for the provider" would send the reader the wrong way.
                totals.overdue === 0n
                  ? 'Waiting for the provider to deliver and claim.'
                  : totals.overdue === totals.held
                    ? 'Past its deadline. Return it from the exceptions page.'
                    : `${usd(totals.overdue)} of it is past its deadline. Return that from the exceptions page.`,
              )}
              level={outcomes.state !== 'read' ? 'unknown' : totals.held > 0n ? 'attention' : 'ok'}
            />
            <Stat
              label="Came back"
              value={<Figure reading={outcomes}>{usd(totals.returned)}</Figure>}
              hint={figureHint(outcomes, 'Not delivered, so the money and the budget came back.')}
              level={outcomes.state === 'read' ? undefined : 'unknown'}
            />
          </StatGrid>
        </Card>
      </Section>

      <Section
        title="Payments"
        description={
          feeBps === undefined
            ? 'Every payment the agent made from this mandate.'
            : `Every payment the agent made. Providers pay a ${feeBps / 100}% fee on each settled payment.`
        }
      >
        <Card>
          {history.state === 'unreadable' || history.state === 'refused' ? (
            <ErrorSurface error={history.error} action="Reading the payment history" onRetry={ledger.refresh} />
          ) : history.state === 'loading' ? (
            <p className="text-detail text-[color:var(--color-muted)]">Loading payments.</p>
          ) : (
            <Table
              rows={rows}
              rowKey={(row) => row.key}
              caption="Payments made from this mandate"
              empty={
                <p className="text-detail text-[color:var(--color-muted)]">
                  No payments yet. They appear here as the agent makes them.
                </p>
              }
              columns={[
                {
                  key: 'when',
                  header: 'When',
                  cell: (row) => (
                    <span className="whitespace-nowrap text-detail">
                      <Instant at={row.spent.at} relative />
                    </span>
                  ),
                },
                {
                  key: 'payee',
                  header: 'Paid to',
                  cell: (row) => (
                    <span className="whitespace-nowrap">
                      <AddressView value={row.spent.merchant} />
                    </span>
                  ),
                },
                {
                  key: 'capability',
                  header: 'For',
                  secondary: true,
                  cell: (row) => <Capability id={row.spent.capabilityId} labelFor={labelFor} />,
                },
                {
                  key: 'amount',
                  header: 'Amount',
                  align: 'right',
                  cell: (row) => (
                    <span className="tabular">
                      {usd(row.spent.amount)}
                      {row.lock?.status === LockStatus.Released && feeBps !== undefined && (
                        <span className="block whitespace-nowrap text-note text-[color:var(--color-muted)]">
                          {usdExact(subMicro(row.spent.amount, mulBps(row.spent.amount, feeBps)))} to the provider
                        </span>
                      )}
                      {row.lock?.status === LockStatus.Resolved && row.events?.resolved && (
                        <span className="block text-note text-[color:var(--color-muted)]">
                          {usd(row.events.resolved.paid)} paid, {usd(row.events.resolved.refunded)} returned
                        </span>
                      )}
                    </span>
                  ),
                },
                {
                  key: 'outcome',
                  header: 'Outcome',
                  cell: (row) => (
                    <>
                      <Outcome row={row} chainTime={ledger.chainTime} />
                      {isOwner && contestable(row.lock, disputeWindow, ledger.chainTime, account?.contractSet) && (
                        <Link
                          href={`/console/${address}/exceptions`}
                          className="mt-1 block text-note underline underline-offset-2"
                        >
                          Contest this payment
                        </Link>
                      )}
                    </>
                  ),
                },
                {
                  key: 'transactions',
                  header: 'On chain',
                  align: 'right',
                  secondary: true,
                  cell: (row) => (
                    <span className="inline-flex flex-col items-end gap-1">
                      <span className="text-note text-[color:var(--color-muted)]">
                        {/* The agent's transaction moves the money into the escrow; the provider is paid only on its claim. */}
                        Sent <TxHash hash={row.spent.transactionHash} />
                      </span>
                      {row.events?.released && (
                        <span className="whitespace-nowrap text-note text-[color:var(--color-muted)]">
                          Claimed <TxHash hash={row.events.released.transactionHash} />
                        </span>
                      )}
                      {row.events?.timedOut && (
                        <span className="whitespace-nowrap text-note text-[color:var(--color-muted)]">
                          Returned <TxHash hash={row.events.timedOut.transactionHash} />
                        </span>
                      )}
                      {row.events?.reopened && (
                        <span className="text-note text-[color:var(--color-muted)]">
                          Dispute closed without a ruling, back in escrow <TxHash hash={row.events.reopened.transactionHash} />
                        </span>
                      )}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Card>
      </Section>
    </div>
  );
}

/** A total is a total only when the readings under it landed. Until then it says which it is. */
function Figure({ reading, children }: { readonly reading: Reading; readonly children: ReactNode }) {
  if (reading.state === 'loading') return <Skeleton width="4rem" height={22} />;
  if (reading.state === 'unreadable') return <>Unread</>;
  if (reading.state === 'refused') return <>Refused</>;
  return <>{children}</>;
}

/**
 * Why a tile carries no figure.
 *
 * "Check again at the top of the page" is the right answer for a read that did not arrive and the
 * wrong one for a read that was turned down: the index charges for this history, and pressing the
 * control again buys another 402. So a stated refusal is stated here instead, in the refuser's own
 * words.
 */
function figureHint(reading: Reading, whenRead: string): string {
  switch (reading.state) {
    case 'loading':
      return 'Loading payments.';
    case 'unreadable':
      return 'Could not be loaded. Use Check again at the top of the page.';
    case 'refused':
      return refusalOf(reading.error)?.condition ?? 'Could not be loaded. Use Check again at the top of the page.';
    case 'read':
      return whenRead;
  }
}

function Outcome({ row, chainTime }: { readonly row: Row; readonly chainTime: Date | undefined }) {
  if (!row.lock) {
    return (
      <span className="inline-flex items-center gap-1.5 text-detail text-[color:var(--color-muted)]">
        <LevelDot level="unknown" label="Unknown" />
        Unknown
      </span>
    );
  }

  const status = row.lock.status;
  // A deadline that has gone is not a deadline the provider still has. Counting down to a moment
  // in the past reads as "until 52m ago to deliver", which is where the payer stops believing the
  // screen. The exceptions page carries the control that ends it.
  const past = returnable(row.lock, chainTime);

  return (
    <span className="text-detail">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <LevelDot level={lockLevel(status)} label={past ? OVERDUE_WORD : lockWord(status)} />
        {past ? OVERDUE_WORD : lockWord(status)}
      </span>
      <span className="block text-note text-[color:var(--color-muted)]">
        {past ? (
          <>
            Not delivered in time.{' '}
            <Link href="./exceptions" className="underline underline-offset-2">
              Take it back
            </Link>
            .
          </>
        ) : status === LockStatus.Locked ? (
          <>
            The provider has to deliver <Countdown to={row.lock.deadline} />.
          </>
        ) : (
          lockDetail(status)
        )}
      </span>
    </span>
  );
}

function Capability({ id, labelFor }: { readonly id: Hex; readonly labelFor: (id: Hex) => string | undefined }) {
  const label = labelFor(id);
  return label ? (
    <span className="text-detail" title={label}>
      {bareLabel(label)}
    </span>
  ) : (
    <span className="tabular text-detail text-[color:var(--color-muted)]" title={id}>
      {shortAddress(id, 10, 6)}
    </span>
  );
}

function add(a: Micro, b: Micro): Micro {
  return micro(a + b);
}

