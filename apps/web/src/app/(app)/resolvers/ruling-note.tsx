'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Instant } from '@/components/instant';
import { isPast } from '@/lib';

import { POLICY_PATH, readRuling, ruleLabel } from './ruling';
import type { RulingReading } from './ruling';

/** A sealed score becomes readable at the reveal, so the note asks again at the pace of the desk. */
const REFETCH_MS = 60_000;
/** Once the reveal is open, Bursar's reveals and the reasons are seconds away. */
const REVEALING_REFETCH_MS = 5_000;

function revealOpen(reading: RulingReading | undefined): boolean {
  return reading?.kind === 'sealed' && reading.revealsFrom !== null && isPast(reading.revealsFrom);
}

/** The published reasons behind a dispute, under the on-chain outcome they explain. */
export function RulingNote({ disputeId, registry }: { readonly disputeId: bigint; readonly registry?: string }) {
  const query = useQuery({
    queryKey: ['bursar', 'ruling', registry ?? 'current', disputeId.toString()],
    queryFn: ({ signal }) => readRuling(disputeId, signal, registry),
    refetchInterval: (state) =>
      state.state.data?.kind === 'published' ? false : revealOpen(state.state.data) ? REVEALING_REFETCH_MS : REFETCH_MS,
  });

  if (query.data === undefined) return null;
  return <RulingNoteView reading={query.data} />;
}

export function RulingNoteView({ reading }: { readonly reading: RulingReading }) {
  const policy = (
    <Link href={POLICY_PATH} className="underline underline-offset-2">
      How rulings are made
    </Link>
  );

  if (reading.kind === 'sealed' && revealOpen(reading)) {
    return (
      <Note title="Ruling sealed">
        The reveal is open. The resolvers&rsquo; reasons appear here as soon as their scores are revealed. {policy}.
      </Note>
    );
  }

  if (reading.kind === 'sealed') {
    return (
      <Note title="Ruling sealed">
        The resolvers&rsquo; score stays sealed until the reveal
        {reading.revealsFrom === null ? '' : <> opens <Instant at={reading.revealsFrom} relative /></>}. Their reasons appear here
        after that. {policy}.
      </Note>
    );
  }

  if (reading.kind === 'none') {
    return (
      <Note title="No published ruling">
        No reasons were published for this dispute. The outcome above comes from the chain. {policy}.
      </Note>
    );
  }

  if (reading.kind === 'unavailable') {
    return (
      <Note title="Published ruling not read">
        The reasons could not be loaded right now. The outcome above comes from the chain and is unaffected.
      </Note>
    );
  }

  return (
    <Note title={`Published ruling, policy ${reading.policyVersion}`}>
      <span className="block">
        <span className="font-medium text-[color:var(--color-ink)]">
          {reading.rule === null ? '' : `${reading.rule}. `}
          {ruleLabel(reading.rule)}
        </span>
        {reading.score === null ? '. No score was cast.' : `, scored ${reading.score} out of 100.`}
      </span>
      {reading.reasons.length > 0 && <span className="mt-1 block">{reading.reasons.join(' ')}</span>}
      {reading.evidence > 0 && (
        <span className="mt-1 block">
          {reading.counted} of {reading.evidence} delivery {reading.evidence === 1 ? 'statement' : 'statements'} arrived before the cutoff and
          counted.
        </span>
      )}
      {reading.statements.length > 0 && (
        <span className="mt-1 block">The payer&rsquo;s statement, published and not scored: &ldquo;{reading.statements[0]}&rdquo;</span>
      )}
      {reading.operatorParty && (
        <span className="mt-1 block">Bursar is a party to this dispute, so it was ruled without any override.</span>
      )}
      {reading.note !== null && <span className="mt-1 block">{reading.note}</span>}
      <span className="mt-1 block">{policy}.</span>
    </Note>
  );
}

function Note({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="border-l-2 border-[color:var(--color-line-strong)] pl-4">
      <p className="text-label uppercase tracking-wide text-[color:var(--color-muted)]">{title}</p>
      <p className="mt-1 max-w-prose text-detail text-[color:var(--color-muted)]">{children}</p>
    </div>
  );
}
