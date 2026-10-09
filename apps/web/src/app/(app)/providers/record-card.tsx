'use client';

import { useState } from 'react';
import { useSignMessage } from 'wagmi';

import { ADDRESSES, escrowAbi } from '@/chain';
import { Button } from '@/components/button';
import { Card } from '@/components/layout';
import { Countdown, Instant } from '@/components/instant';
import { LevelDot } from '@/components/badge';
import { TxButton } from '@/components/tx-button';
import { formatDuration } from '@/lib';
import { usd } from '@/money';
import type { AnyState } from '@/state';

import type { ProviderDesk, ProviderLock } from './desk';
import { useWalletAccount } from '@/wallet/account';
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
      <Card title="How a payment reaches your record" description="Getting paid and recording the job are two steps.">
        <p className="text-sm">
          {desk.complete ? 'Nothing is waiting to be recorded.' : 'Could not read whether anything is waiting.'} You are
          paid the moment you release a job. It can be recorded {windowWords} later, once the payer&rsquo;s contest window
          closes, and only recorded jobs raise your ceiling. Jobs ready to record appear here.
        </p>
      </Card>
    );
  }

  const lift =
    record.cap !== undefined && desk.projectedCap !== undefined && desk.projectedCap > record.cap && recordable.length > 0
      ? `Your ceiling is ${usd(record.cap)}. Recording ${countWord(recordable.length, 'this one', `these ${recordable.length}`)} moves it to ${usd(desk.projectedCap)}.`
      : record.cap === undefined
        ? ''
        : `Your ceiling is ${usd(record.cap)}. Recording adds ${countWord(unrecorded.length, 'this job', 'these jobs')} to your record.`;

  return (
    <Card
      title="Paid work to record"
      description={`${unrecorded.length} paid ${unrecorded.length === 1 ? 'job' : 'jobs'} not yet on your record.`}
    >
      <div className="space-y-4">
        <p className="text-sm">
          You were paid when you released each of these. Each can be recorded {windowWords} after release, once the
          payer&rsquo;s contest window closes. {lift}
        </p>

        <ul className="divide-y divide-[color:var(--color-line)] border-y border-[color:var(--color-line)]">
          {[...recordable, ...waiting].map((lock) => (
            <RecordRow key={lock.id.toString()} lock={lock} blockedBy={blockedBy} onRecorded={onRecorded} />
          ))}
        </ul>

        {recordable.length === 0 && waiting.length > 0 && (
          <p className="text-detail text-[color:var(--color-muted)]">
            Nothing is ready to record yet. The next one opens <Countdown to={waiting[0]?.recordableAt} />.
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

/**
 * Delivering and collecting in one step, for a provider without a sidecar. `release` pays the
 * payee from the lock before its deadline; no output is committed, so the payer has nothing to
 * check the work against and can still contest within the window.
 */
export function TakePayment({
  lock,
  blockedBy,
  onTaken,
}: {
  readonly lock: ProviderLock;
  readonly blockedBy: readonly AnyState[];
  readonly onTaken: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  if (lock.stage !== 'awaiting-delivery' || !lock.deployment.current) return null;

  return (
    <TxButton
      label="Take the payment"
      tone="secondary"
      blockedBy={blockedBy}
      send={() =>
        writeContractAsync({
          address: ADDRESSES.escrow,
          abi: escrowAbi,
          functionName: 'release',
          args: [lock.id, `0x${'0'.repeat(64)}`, ''],
        })
      }
      onContinue={onTaken}
    />
  );
}

type Brief = { readonly task?: string; readonly acceptance?: readonly string[]; readonly text: string };

function readBrief(text: string): Brief {
  try {
    const parsed = JSON.parse(text) as { task?: unknown; acceptance?: unknown };
    return {
      text,
      ...(typeof parsed.task === 'string' ? { task: parsed.task } : {}),
      ...(Array.isArray(parsed.acceptance) ? { acceptance: parsed.acceptance.filter((line): line is string => typeof line === 'string') } : {}),
    };
  } catch {
    return { text };
  }
}

/**
 * A private payment's brief is sealed to the provider's viewing key, so the desk opens it here: the
 * wallet signs the viewing-key message, which costs nothing, and the key it yields never leaves the page.
 */
export function ReadBrief({ lock }: { readonly lock: ProviderLock }) {
  const { address } = useWalletAccount();
  const { signMessageAsync } = useSignMessage();
  const [brief, setBrief] = useState<Brief | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  if (!lock.inputURI.toLowerCase().startsWith(SEALED_PREFIX) || address === undefined) return null;

  const open = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const { deriveViewingKey, openSealedURI, viewingKeyMessage } = await import('@bursar/sdk');
      const key = deriveViewingKey(await signMessageAsync({ message: viewingKeyMessage(address) }));
      setBrief(readBrief(await openSealedURI(key.privateKey, lock.inputURI)));
    } catch {
      setProblem('The brief did not open with this wallet’s viewing key.');
    } finally {
      setBusy(false);
    }
  };

  if (brief) {
    return (
      <div className="max-w-sm space-y-1 text-left text-detail">
        {brief.task ? <p>{brief.task}</p> : <p className="break-words font-mono text-note">{brief.text}</p>}
        {brief.acceptance && brief.acceptance.length > 0 && (
          <ul className="list-disc pl-4 text-[color:var(--color-muted)]">
            {brief.acceptance.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Button size="sm" onClick={() => void open()} disabled={busy}>
        {busy ? 'Waiting for the signature' : 'Read the brief'}
      </Button>
      {problem && <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>{problem}</p>}
    </div>
  );
}

const SEALED_PREFIX = 'data:application/vnd.bursar.sealed;base64,';

