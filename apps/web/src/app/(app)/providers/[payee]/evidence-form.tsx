'use client';

import { canonicalStringify, commitCanonical, toDataUri } from '@bursar/core';
import { MAX_OUTPUT_URI_CHARS, deliveryEvidenceTypedData, encodeEvidence } from '@bursar/sdk';
import type { DeliveryEvidence } from '@bursar/sdk';
import Link from 'next/link';
import { useId, useState } from 'react';
import type { Hex } from 'viem';
import { useSignTypedData } from 'wagmi';

import { CHAIN_ID } from '@/chain/rhc';
import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { TextField } from '@/components/fields';
import { Instant } from '@/components/instant';
import { Card } from '@/components/layout';
import { useWalletAccount } from '@/wallet/account';
import { onWrongChain } from '@/wallet/write';

import { POLICY_PATH } from '../../resolvers/ruling';
import type { ProviderLock } from '../desk';

type Sent = { readonly counted: boolean; readonly cutoff: Date | null };

/**
 * Signed delivery evidence, from a provider's own wallet.
 *
 * A payer who disputes before the release leaves no output on chain, and to the resolvers that
 * reads as a job nobody did. A provider running the sidecar sends this automatically. This form is
 * the same statement for a provider without one: paste what was delivered, say where it is
 * published or let it travel inline, and sign. Nothing here is a transaction and nothing costs gas.
 */
export function EvidenceForm({ lock }: { readonly lock: ProviderLock }) {
  const textId = useId();
  const account = useWalletAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const [outputText, setOutputText] = useState('');
  const [uriText, setUriText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [sent, setSent] = useState<Sent | undefined>(undefined);

  const draft = readDraft(outputText, uriText);
  const cutoff = cutoffOf(lock);
  const wrongChain = onWrongChain({ isConnected: account.isConnected, chainId: account.chainId });

  const send = async () => {
    if (draft.evidence === undefined) return;
    setBusy(true);
    setFailure(null);
    try {
      const evidence: DeliveryEvidence = { escrowId: lock.id, inputCommit: lock.inputCommit, ...draft.evidence, deliveredAt: BigInt(Math.floor(Date.now() / 1000)) };
      const signature = await signTypedDataAsync(deliveryEvidenceTypedData(lock.deployment.escrow, CHAIN_ID, evidence));
      const response = await fetch('/api/evidence', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(encodeEvidence({ kind: 'delivery', chainId: CHAIN_ID, escrow: lock.deployment.escrow, evidence, signature: signature as Hex })),
      });
      const body = (await response.json().catch(() => ({}))) as { counted?: unknown; cutoff?: unknown; detail?: unknown };
      if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'The ruling service could not take the evidence. Try again.');
      setSent({ counted: body.counted === true, cutoff: typeof body.cutoff === 'string' ? new Date(body.cutoff) : cutoff });
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={`Send evidence for job ${lock.id.toString()}`}
      description={
        <>
          The payer contested this job before it was paid. Sign what you delivered so the resolvers can check it.{' '}
          {cutoff === null ? (
            'Send it within the first half of the sealing window.'
          ) : (
            <>
              Send it before <Instant at={cutoff} />.
            </>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor={textId} className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
            What you delivered
          </label>
          <textarea
            id={textId}
            value={outputText}
            onChange={(event) => {
              setOutputText(event.target.value);
              setSent(undefined);
            }}
            rows={6}
            spellCheck={false}
            placeholder='{"summary": "…"}'
            aria-invalid={draft.outputProblem !== undefined}
            className="w-full border border-[color:var(--color-line)] bg-surface px-3.5 py-2.5 font-mono text-note outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
          />
          <p className="text-note" style={{ color: draft.outputProblem === undefined ? 'var(--color-muted)' : 'var(--color-state-blocked)' }}>
            {draft.outputProblem ?? 'The job’s JSON output, exactly as delivered.'}
          </p>
        </div>

        <TextField
          label="Published at"
          value={uriText}
          onChange={(value) => {
            setUriText(value);
            setSent(undefined);
          }}
          placeholder="Leave empty to send it inline"
          mono
          problem={draft.uriProblem}
          help="An https link to the same output. Leave it empty to send the output with the evidence."
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button tone="primary" disabled={draft.evidence === undefined || busy || !account.isConnected || wrongChain} onClick={() => void send()}>
            {busy ? 'Waiting for the wallet' : 'Sign and send'}
          </Button>
          <span className="text-note text-[color:var(--color-muted)]">
            {!account.isConnected
              ? 'Connect the wallet this job paid to.'
              : wrongChain
                ? 'Switch the wallet to Robinhood Chain.'
                : 'A signature only. No transaction and no fee.'}
          </span>
        </div>

        {sent !== undefined && (
          <p className="text-sm" role="status">
            {sent.counted
              ? 'Received in time. The resolvers will check it and publish the ruling with its reasons.'
              : 'Received after the cutoff. It is published with the ruling but does not affect the score.'}{' '}
            <Link href={POLICY_PATH} className="underline underline-offset-2">
              How rulings are made
            </Link>
          </p>
        )}
        <ErrorSurface error={failure} action="Sending the evidence" onRetry={() => void send()} />
      </div>
    </Card>
  );
}

type Draft = {
  readonly evidence: Pick<DeliveryEvidence, 'outputCommit' | 'outputURI'> | undefined;
  readonly outputProblem: string | undefined;
  readonly uriProblem: string | undefined;
};

/** What the two fields would sign, or which of them is in the way. */
export function readDraft(outputText: string, uriText: string): Draft {
  if (outputText.trim() === '') return { evidence: undefined, outputProblem: undefined, uriProblem: undefined };

  let output: unknown;
  try {
    output = JSON.parse(outputText);
  } catch {
    return { evidence: undefined, outputProblem: 'This is not JSON. Paste the output exactly as the job produced it.', uriProblem: undefined };
  }
  if (output === null || (typeof output === 'object' && Object.keys(output).length === 0)) {
    return { evidence: undefined, outputProblem: 'The output is empty.', uriProblem: undefined };
  }

  const outputCommit = commitCanonical(output);
  const uri = uriText.trim();
  if (uri === '') {
    const inline = toDataUri(canonicalStringify(output));
    return inline.length > MAX_OUTPUT_URI_CHARS
      ? { evidence: undefined, outputProblem: undefined, uriProblem: 'Too large to send inline. Publish it and paste the link.' }
      : { evidence: { outputCommit, outputURI: inline }, outputProblem: undefined, uriProblem: undefined };
  }

  if (!/^https:\/\/[^\s]+$/.test(uri)) {
    return { evidence: undefined, outputProblem: undefined, uriProblem: 'Use an https link.' };
  }
  return { evidence: { outputCommit, outputURI: uri }, outputProblem: undefined, uriProblem: undefined };
}

/** Half the sealing window after the dispute opened: 30 minutes on the current registry, three hours on v1. */
function cutoffOf(lock: ProviderLock): Date | null {
  const opened = lock.dispute?.openedAt;
  const sealing = lock.dispute?.commitEndsAt;
  if (!opened || !sealing) return null;
  return new Date(opened.getTime() + (sealing.getTime() - opened.getTime()) / 2);
}
