'use client';

import type { Address } from 'viem';

import { LevelDot } from '@/components/badge';
import { Button } from '@/components/button';
import { Card, EmptyState, Section, Skeleton } from '@/components/layout';
import type { AnyState } from '@/state';

import type { DisputeRow, ResolverDesk } from './desk';
import { DisputeCard } from './dispute-card';
import { disputeListState } from './reading';

/**
 * The open panel.
 *
 * A read in flight, a read that failed and a registry with nothing open all produce an empty list,
 * and on this screen they mean opposite things. A resolver who is told "nothing needs you" by a
 * rate-limited endpoint misses a reveal window and is slashed for it, so the three are rendered
 * apart and only one of them says the bench is clear.
 */
export function DisputeList({
  desk,
  error,
  account,
  blockedBy,
  onDone,
  onRetry,
}: {
  readonly desk: ResolverDesk | undefined;
  readonly error: unknown;
  readonly account: Address | undefined;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
  readonly onRetry: () => void;
}) {
  const state = disputeListState(desk, error);

  return (
    <Section
      title="Open disputes"
      description="Contested settlements still open, soonest deadline first."
      actions={desk === undefined ? undefined : <ScanNote desk={desk} />}
    >
      {state === 'loading' && (
        <Card>
          <Skeleton height={72} />
        </Card>
      )}

      {state === 'unreadable' && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <p className="flex items-start gap-2 text-sm">
              <span className="pt-1">
                <LevelDot level="unknown" />
              </span>
              <span>
                Open disputes could not be read right now. Read again before assuming nothing is due.
              </span>
            </p>
            <Button size="sm" onClick={onRetry}>
              Read again
            </Button>
          </div>
        </Card>
      )}

      {state === 'empty' && (
        <EmptyState title="No dispute is open.">
          A dispute opens when a payer contests a settlement. Keep your bond posted to vote on the next one.
        </EmptyState>
      )}

      {state === 'filled' && desk !== undefined && (
        <div className="space-y-6">
          {ordered(desk.open).map((row) => (
            <DisputeCard
              key={rowKey(row)}
              dispute={row}
              config={row.config}
              resolverFeeBps={row.resolverFeeBps}
              chainTime={desk.chainTime}
              account={account}
              registry={row.deployment.oracleRegistry}
              standing={
                desk.standing === undefined
                  ? undefined
                  : {
                      status: desk.standing.status,
                      bond: desk.standing.bond,
                      floor: desk.standing.floor,
                      barred: desk.standing.barred,
                    }
              }
              blockedBy={blockedBy}
              onDone={onDone}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

/** Settled disputes, for the record. Read-only and never mixed in with what is still due. */
export function SettledList({ desk }: { readonly desk: ResolverDesk | undefined }) {
  if (desk === undefined || desk.settled.length === 0) return null;

  return (
    <Section title="Closed" description="Settled disputes, newest first.">
      <div className="space-y-6">
        {desk.settled.map((row) => (
          <DisputeCard
            key={rowKey(row)}
            dispute={row}
            config={row.config}
            resolverFeeBps={row.resolverFeeBps}
            chainTime={desk.chainTime}
            account={undefined}
            registry={row.deployment.oracleRegistry}
            standing={undefined}
            blockedBy={[]}
            onDone={() => undefined}
          />
        ))}
      </div>
    </Section>
  );
}

/** Dispute ids restart with every deployment, so a row is named by both. */
function rowKey(row: DisputeRow): string {
  return `${row.deployment.name}:${row.id.toString()}`;
}

function ScanNote({ desk }: { readonly desk: ResolverDesk }) {
  if (!desk.disputesReadable) return null;

  const current =
    desk.scanned.to === 0n
      ? 'No disputes on the current contracts.'
      : desk.scanned.truncated
        ? `Showing disputes ${desk.scanned.from.toString()} to ${desk.scanned.to.toString()}, the latest ${(desk.scanned.to - desk.scanned.from + 1n).toString()}.`
        : `All ${desk.scanned.to.toString()} disputes shown.`;
  const earlier = desk.earlier.map((entry) =>
    !entry.disputesReadable
      ? 'Disputes on earlier contracts could not be read.'
      : `${entry.scanned.to.toString()} on earlier contracts.`,
  );

  return <span className="text-note text-[color:var(--color-muted)]">{[current, ...earlier].join(' ')}</span>;
}

/**
 * Soonest deadline first, because that is the order a resolver has to work in. A dispute waiting on
 * somebody to close it has no clock and sorts last: it is already late, and nothing about it gets
 * worse while it waits.
 */
function ordered(rows: readonly DisputeRow[]): readonly DisputeRow[] {
  return [...rows].sort((a, b) => {
    const left = a.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
    const right = b.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
    if (left !== right) return left - right;
    return a.id > b.id ? -1 : 1;
  });
}
