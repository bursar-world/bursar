'use client';

import type { ReactNode } from 'react';

import { LevelDot } from '@/components/badge';
import { Button } from '@/components/button';
import type { IndexUnavailable } from './explorer';
import type { ListState } from './reading';

/**
 * What a gate table says when it has no rows.
 *
 * Four answers for four conditions, and the two that matter are the reads that did not produce a
 * list. "This mandate pays nobody" is a claim about what the account permits, and neither a
 * request that never arrived nor one the index turned down can support it. The contract holds the
 * list either way.
 *
 * A refusal is kept apart from a failure because the fixes have nothing in common. The index
 * charges for this history and answers HTTP 402 to a deployment with no key: nothing is down,
 * nothing is slow, and the reader in front of the screen is not the person who clears it.
 */

export type GateSubject = 'payees' | 'capabilities';

type Copy = {
  readonly unreadable: string;
  /** The half that holds however the read failed: the contract is unaffected by any of it. */
  readonly holds: string;
  readonly loading: string;
  readonly empty: string;
};

const COPY: Readonly<Record<GateSubject, Copy>> = {
  payees: {
    unreadable: 'The payee list could not be read. Nothing here says the list is empty; the request for it did not come back.',
    holds: 'The contract still holds the list and still refuses anyone who is not on it.',
    loading: 'Reading the payee list from the account.',
    empty: 'No payee has been allowed yet, so this mandate pays nobody.',
  },
  capabilities: {
    unreadable: 'The capability list could not be read. Nothing here says the list is empty; the request for it did not come back.',
    holds: 'The contract still holds the list and still refuses work that is not on it.',
    loading: 'Reading the capability list from the account.',
    empty: 'No capability has been allowed yet, so every payment is refused.',
  },
};

export function GateEmpty({
  state,
  subject,
  refusal,
  onRetry,
}: {
  readonly state: ListState;
  readonly subject: GateSubject;
  /** The refusal behind a `refused` state, so the panel can name it rather than describe an outage. */
  readonly refusal?: IndexUnavailable | undefined;
  readonly onRetry: () => void;
}) {
  const copy = COPY[subject];

  switch (state) {
    case 'unreadable':
      return (
        <Unread onRetry={onRetry}>
          {copy.unreadable} {copy.holds}
        </Unread>
      );
    case 'refused':
      // Without the refusal itself there is nothing to name, so this says only what it knows.
      return refusal === undefined ? (
        <Unread onRetry={onRetry}>
          {copy.unreadable} {copy.holds}
        </Unread>
      ) : (
        <Unread onRetry={onRetry}>
          {refusal.condition} Nothing here says the list is empty. {copy.holds} {refusal.nextAction}
        </Unread>
      );
    case 'loading':
      return <p className="text-detail text-[color:var(--color-muted)]">{copy.loading}</p>;
    case 'empty':
      return <p className="text-detail text-[color:var(--color-muted)]">{copy.empty}</p>;
    case 'filled':
      return null;
  }
}

/** The reading did not land. An empty table that says so beats one that reads as a decision. */
function Unread({ children, onRetry }: { readonly children: ReactNode; readonly onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <p className="flex items-start gap-2 text-detail">
        <span className="pt-1">
          <LevelDot level="unknown" />
        </span>
        <span>{children}</span>
      </p>
      <Button size="sm" onClick={onRetry}>
        Read again
      </Button>
    </div>
  );
}
