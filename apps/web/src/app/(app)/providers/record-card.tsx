'use client';


import { ADDRESSES, escrowAbi } from '@/chain';
import { Card } from '@/components/layout';
import { Countdown, Instant } from '@/components/instant';
import { LevelDot } from '@/components/badge';
import { TxButton } from '@/components/tx-button';
import { formatDuration } from '@/lib';
import { usd } from '@/money';
import type { AnyState } from '@/state';

import type { ProviderDesk, ProviderLock } from './desk';
import { useWriteContract } from '@/wallet/write';

/**
 * The step a payee would otherwise never find.
 *
 * `release` pays immediately, so from the payee's side the job looks finished. The reputation
 * counter behind their per-job ceiling is written by a second call, `finalizeRelease`, which the
 * escrow refuses until the payer's window to contest the release has closed. It is permissionless
 * and nobody is obliged to make it, so a payee who does not know about it delivers work, gets paid,
 * and watches their ceiling stay where it was.
 */
export function RecordCard({
  desk,
  blockedBy,
  onRecorded,
}: {
  readonly desk: ProviderDesk;
  readonly blockedBy: readonly AnyState[];
  readonly onRecorded: () => void;
}) {
  const { unrecorded, recordable, record } = desk;

  // The desk walks lock ids from the newest down and that order survives the filter, so the head
  // of this list would otherwise be the job whose window closes last. The line under it names the
  // first one to open, and the list reads in the order they will open.
  const waiting = unrecorded
    .filter((lock) => lock.stage === 'paid-open-to-dispute')
    .sort((a, b) => opensAt(a) - opensAt(b));
  const windowWords = desk.terms.disputeWindow === undefined ? 'the window' : formatDuration(Number(desk.terms.disputeWindow));

  if (unrecorded.length === 0) {
    return (
      <Card title="How a payment reaches your record" description="Getting paid and being credited for the job are two separate steps.">
        <p className="text-sm">
          {desk.complete ? 'Nothing is waiting.' : 'Whether anything is waiting could not be read.'} A payment is final
          the moment you release it, and the job joins your record{' '}
          {windowWords} later, once the payer&rsquo;s time to contest it has run out. That second step is open to anyone
          to make. When one is outstanding it appears here, because a job outside the record does nothing for the
          ceiling on your next one.
        </p>
      </Card>
    );
  }

  const lift =
    record.cap !== undefined && desk.projectedCap !== undefined && desk.projectedCap > record.cap && recordable.length > 0
      ? `Your ceiling is ${usd(record.cap)}. Recording ${countWord(recordable.length, 'this one', `these ${recordable.length}`)} moves it to ${usd(desk.projectedCap)}.`
      : record.cap === undefined
        ? ''
        : `Your ceiling is ${usd(record.cap)} and stays there until these are recorded.`;

  return (
    <Card
      title="Paid work that is not in your record yet"
      description={`${unrecorded.length} ${unrecorded.length === 1 ? 'payment' : 'payments'} settled, ${unrecorded.length === 1 ? 'it is' : 'they are'} still outside the count your ceiling is built from.`}
    >
      <div className="space-y-4">
        <p className="text-sm">
          You were paid when you released each of these. The job joins your record separately, {windowWords}{' '}
          after the release, once the payer&rsquo;s time to contest it has run out. That call is open to anyone and
          nobody is obliged to make it, so work can sit here for as long as it takes someone to notice. {lift}
        </p>

        <ul className="divide-y divide-[color:var(--color-line)] border-y border-[color:var(--color-line)]">
          {[...recordable, ...waiting].map((lock) => (
            <RecordRow key={lock.id.toString()} lock={lock} blockedBy={blockedBy} onRecorded={onRecorded} />
          ))}
        </ul>

        {recordable.length === 0 && waiting.length > 0 && (
          <p className="text-detail text-[color:var(--color-muted)]">
            Nothing can be recorded this minute. The first one opens <Countdown to={waiting[0]?.recordableAt} />.
          </p>
        )}
      </div>
    </Card>
  );
}

function RecordRow({
  lock,
  blockedBy,
  onRecorded,
}: {
  readonly lock: ProviderLock;
  readonly blockedBy: readonly AnyState[];
  readonly onRecorded: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const ready = lock.stage === 'paid-unrecorded';

  return (
    <li className="flex flex-wrap items-start justify-between gap-4 py-3">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <LevelDot level={ready ? 'attention' : 'ok'} label={ready ? 'Ready to record' : 'Still contestable'} />
          Job {lock.id.toString()}
          <span className="tabular font-normal text-[color:var(--color-muted)]">{usd(lock.net)} paid</span>
        </div>
        <p className="text-detail text-[color:var(--color-muted)]">
          Released <Instant at={lock.releasedAt} relative />.{' '}
          {ready ? (
            'Ready to record now.'
          ) : (
            <>
              Ready to record <Instant at={lock.recordableAt} relative />.
            </>
          )}
        </p>
      </div>

      <div className="shrink-0">
        {ready ? (
          <TxButton
            label="Record it"
            tone="secondary"
            blockedBy={blockedBy}
            send={() =>
              writeContractAsync({
                address: ADDRESSES.escrow,
                abi: escrowAbi,
                functionName: 'finalizeRelease',
                args: [lock.id],
              })
            }
            onContinue={onRecorded}
          />
        ) : (
          <span className="text-detail text-[color:var(--color-muted)]">
            Opens <Countdown to={lock.recordableAt} />
          </span>
        )}
      </div>
    </li>
  );
}

function countWord(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** A lock whose window could not be read sorts last: an unknown moment is not a soon one. */
function opensAt(lock: ProviderLock): number {
  return lock.recordableAt?.getTime() ?? Number.POSITIVE_INFINITY;
}
