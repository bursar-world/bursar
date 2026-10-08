'use client';

import { useId, useState } from 'react';
import { useSignMessage } from 'wagmi';
import type { Address, Hex } from 'viem';

import { CHAIN_ID, oracleRegistryAbi, shortAddress } from '@/chain';
import { CopyControl } from '@/components/address';
import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { Card } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { formatSpan } from '@/lib';
import type { AnyState } from '@/state';

import type { DisputeRow, OracleConfig } from './desk';
import { deviationWarning, parseScore, refundBpsForScore, scoreMeaning, scoreProblem } from './phases';
import { resolverFailure } from './refusal';
import {
  browserStorage,
  commitmentFor,
  newSalt,
  noteFor,
  recoveryText,
  saltFromSignatures,
  saltMessage,
  voteStore,
} from './salt';
import type { DrawnSalt, SaltSubject } from './salt';
import { useWriteContract } from '@/wallet/write';

/**
 * Sealing a score, and the one thing that can lose it.
 *
 * The registry stores `keccak256(abi.encode(disputeId, resolver, score, salt))` and nothing else.
 * The salt is what opens that hash, and a commitment that is never revealed is slashed for silence
 * once the reveal window closes.
 *
 * So the salt is drawn from the wallet, not from this browser: one fixed message, signed, hashed.
 * The same wallet draws the same salt in any browser six hours later, which is what a resolver
 * has when they come back to reveal. A copy is still taken here, because a wallet is
 * allowed to sign the same message two different ways and the resolver cannot tell which kind
 * theirs is, and the seal is not offered until they say they have that copy.
 */
export function CommitForm({
  dispute,
  config,
  account,
  registry,
  blockedBy,
  onDone,
}: {
  readonly dispute: DisputeRow;
  readonly config: OracleConfig;
  readonly account: Address;
  readonly registry: Address;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
}) {
  const fieldId = useId();
  const [text, setText] = useState('');
  const [kept, setKept] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [salt, setSalt] = useState<DrawnSalt | undefined>(undefined);
  const [drawing, setDrawing] = useState(false);
  const [drawError, setDrawError] = useState<unknown>(null);
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();

  const [storage] = useState(() => usableStorage());

  const subject: SaltSubject = { registry, chainId: CHAIN_ID, disputeId: dispute.id, resolver: account };
  const score = parseScore(text);
  const problem = text.trim() === '' ? undefined : scoreProblem(score);
  const scored = score !== undefined && problem === undefined;
  const commitment = scored && salt !== undefined ? commitmentFor(dispute.id, account, score, salt.value) : undefined;

  // A salt the wallet will produce again needs the resolver to know that, and saying so is enough.
  // A salt drawn here needs a copy that exists outside this tab, and a tick box is not one: the
  // file has to have been taken before the commitment can be sent.
  const safeguarded = salt === undefined ? false : salt.source === 'wallet' ? kept : downloaded;
  const ready = scored && safeguarded;

  // Signed twice on purpose. A wallet is free to sign one message two different ways, and the one
  // that does would hand back a salt that never reopens this commitment. Asking now costs a second
  // prompt; finding out at reveal costs the bond. A wallet that disagrees with itself is treated as
  // a wallet that cannot reproduce anything, so the copy becomes the only route back and the seal
  // waits for it.
  const draw = async () => {
    setDrawError(null);
    setDrawing(true);
    try {
      const message = saltMessage(subject);
      const first = await signMessageAsync({ account, message });
      const second = await signMessageAsync({ account, message });
      setSalt(saltFromSignatures(first, second));
    } catch (caught) {
      setDrawError(caught);
    } finally {
      setDrawing(false);
    }
  };

  const keep = () => {
    if (!scored || salt === undefined) return;
    const note = noteFor(dispute.id, account, score, salt.value, new Date());
    download(`bursar-dispute-${dispute.id.toString()}-salt.txt`, recoveryText(subject, note));
    setDownloaded(true);
  };

  return (
    <Card
      title="Seal a score"
      description="Your score stays hidden until you reveal it, so no one can copy it."
    >
      <div className="space-y-4">
        <div className="max-w-md space-y-1">
          <label htmlFor={fieldId} className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
            Score, 0 to 100
          </label>
          <input
            id={fieldId}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            value={text}
            placeholder="0"
            aria-invalid={problem !== undefined}
            aria-describedby={`${fieldId}-note`}
            onChange={(event) => setText(event.target.value)}
            className="tabular h-11 w-full border bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
            style={{ borderColor: problem === undefined ? 'var(--color-line)' : 'var(--color-state-blocked)' }}
          />
          <p
            id={`${fieldId}-note`}
            className="text-note"
            style={{ color: problem === undefined ? 'var(--color-muted)' : 'var(--color-state-blocked)' }}
          >
            {problem ?? (score === undefined ? 'How much of the work was delivered, from 0 for nothing to 100 for all of it.' : scoreMeaning(score))}
          </p>
        </div>

        <ScoreScale />

        {scored && <p className="text-detail text-[color:var(--color-muted)]">{deviationWarning(score, config)}</p>}

        <SaltPanel
          account={account}
          salt={salt}
          commitment={commitment}
          scored={scored}
          drawing={drawing}
          downloaded={downloaded}
          storage={storage !== undefined}
          onDraw={() => void draw()}
          onKeep={keep}
          onRandom={() => {
            setDrawError(null);
            setDownloaded(false);
            setSalt({ value: newSalt(), source: 'random' });
          }}
        />

        {drawError !== null && <ErrorSurface error={drawError} action="Drawing the salt from your wallet" />}

        <div
          className="rounded-md border px-4 py-3 text-detail"
          style={{ borderColor: 'var(--color-state-attention)', color: 'var(--color-state-attention)' }}
        >
          After sealing, you have to come back to reveal. The reveal window opens when the sealing window closes and
          lasts {formatSpan(Number(config.revealWindow))}. A sealed score that is never revealed loses{' '}
          {(config.slashBps / 100).toFixed(config.slashBps % 100 === 0 ? 0 : 2)}% of your bond, and only you can reveal
          it. Your bond stays locked until this dispute closes, even if you start unbonding.
        </div>

        {/*
          The label wraps its input rather than naming one, so the base rule for `label[for]` in
          globals.css does not reach it and the pointer is set on the label itself.
        */}
        {salt?.source === 'wallet' && (
          <label className="flex cursor-pointer items-start gap-2 text-detail">
            <input type="checkbox" checked={kept} onChange={(event) => setKept(event.target.checked)} className="mt-0.5" />
            <span>
              I understand that I reveal by signing the same message from this wallet again, and that losing this
              wallet loses the score.
            </span>
          </label>
        )}

        {salt !== undefined && salt.source !== 'wallet' && (
          <p className="text-detail" style={{ color: downloaded ? 'var(--color-state-ok)' : 'var(--color-state-blocked)' }}>
            {downloaded
              ? 'Copy downloaded. Keep it until this dispute closes. It is the only way to reveal this score.'
              : salt.source === 'wallet-unstable'
                ? 'This wallet signed the same message two different ways, so signing again will not recover this salt. Download the copy before sealing.'
                : 'This salt cannot be recreated. Download the copy before sealing.'}
          </p>
        )}

        <TxButton
          label="Seal this score"
          disabled={!ready}
          blockedBy={blockedBy}
          send={async () => {
            if (score === undefined) throw new Error('Enter a score between 0 and 100 first.');
            if (salt === undefined) throw new Error('Draw the salt before sealing the score.');

            // Written before the call leaves, never after. A transaction that lands while this tab
            // is closing must not be the first moment the salt existed anywhere but in memory.
            if (storage !== undefined) {
              voteStore(storage).save(registry, noteFor(dispute.id, account, score, salt.value, new Date()));
            }

            return writeContractAsync({
              address: registry,
              abi: oracleRegistryAbi,
              functionName: 'commitVote',
              args: [dispute.id, commitmentFor(dispute.id, account, score, salt.value)],
            }).catch((caught: unknown) => {
              throw resolverFailure(caught, { action: 'Seal a score' });
            });
          }}
          onContinue={onDone}
          confirmPhrase="seal"
          confirmTitle="Seal this score"
          confirmDescription={
            <>
              You are sealing {score ?? 0} on dispute {dispute.id.toString()}.{' '}
              {score === undefined ? '' : `${scoreMeaning(score)} `}
              You need this score and its salt to reveal, and a sealed score that is never revealed costs{' '}
              {(config.slashBps / 100).toFixed(config.slashBps % 100 === 0 ? 0 : 2)}% of your bond.
            </>
          }
        />
      </div>
    </Card>
  );
}

/**
 * Where the salt comes from, said plainly, with the way back to it.
 *
 * Three renderings, and they are not the same answer: no salt drawn yet, a salt the wallet will
 * produce again, and a salt that exists only in the copy the resolver takes. The last one is the
 * old behaviour and it stays available, because a contract wallet cannot sign a message at all.
 */
function SaltPanel({
  account,
  salt,
  commitment,
  scored,
  drawing,
  downloaded,
  storage,
  onDraw,
  onKeep,
  onRandom,
}: {
  readonly account: Address;
  readonly salt: DrawnSalt | undefined;
  readonly commitment: Hex | undefined;
  readonly scored: boolean;
  readonly drawing: boolean;
  readonly downloaded: boolean;
  readonly storage: boolean;
  readonly onDraw: () => void;
  readonly onKeep: () => void;
  readonly onRandom: () => void;
}) {
  // With the salt, a score is found by trying 0 to 100 against the sealed hash, so a salt on
  // screen is a score anyone watching can read before the reveal.
  const [shown, setShown] = useState(false);
  return (
    <div className="space-y-3 rounded-md border border-[color:var(--color-line)] bg-[color:var(--color-raised)] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-label uppercase tracking-wide text-[color:var(--color-muted)]">
          Your salt for this dispute
        </span>
        {salt !== undefined && <CopyControl value={salt.value} label="Copy the salt" />}
      </div>

      {salt === undefined ? (
        <>
          <p className="text-detail text-[color:var(--color-muted)]">
            The salt is the secret that opens your sealed score. Drawing it asks the wallet at {shortAddress(account)}{' '}
            to sign a fixed message, with no transaction and no fee. The same wallet gives the same salt on any machine,
            so you can reveal from another browser.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={onDraw} disabled={drawing}>
              {drawing ? 'Waiting for your wallet' : 'Draw the salt from your wallet'}
            </Button>
            <button type="button" onClick={onRandom} className="text-detail underline underline-offset-2">
              My wallet cannot sign a message
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-detail">
            <span className="tabular break-all">{shown ? salt.value : `${salt.value.slice(0, 6)}…${salt.value.slice(-4)}`}</span>
            <button type="button" onClick={() => setShown((value) => !value)} className="text-note underline underline-offset-2">
              {shown ? 'Hide the salt' : 'Show the salt'}
            </button>
          </p>
          {!shown && (
            <p className="text-note text-[color:var(--color-muted)]">
              Hidden on screen: anyone who reads the salt can work out your score before you reveal it.
            </p>
          )}
          <p className="text-detail text-[color:var(--color-muted)]">
            {salt.source === 'wallet'
              ? `Drawn from ${shortAddress(account)}, which signed the message the same way twice, so signing again recovers it on any machine. Download the copy too if you might reveal from a different wallet.`
              : salt.source === 'wallet-unstable'
                ? `Drawn from ${shortAddress(account)}, but this wallet signed the message two different ways, so signing cannot recover it. The copy below is the only way back to it.`
                : 'Drawn at random in this browser. It cannot be recreated, so the copy below is the only way back to it.'}
            {storage
              ? ' This browser also saves it when you seal. Do not rely on that as a backup.'
              : ' This browser does not keep site data, so it will not save the salt.'}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" tone="secondary" onClick={onKeep} disabled={!scored}>
              {downloaded ? 'Download it again' : 'Download the copy'}
            </Button>
            {!scored && (
              <span className="text-note text-[color:var(--color-muted)]">
                Enter the score first. The copy holds both the score and the salt.
              </span>
            )}
          </div>
          {commitment !== undefined && (
            <p className="tabular break-all text-note text-[color:var(--color-muted)]">Sealed as {commitment}</p>
          )}
        </>
      )}
    </div>
  );
}

/** What the four bands do to the money, straight off `refundBpsForScore`. */
function ScoreScale() {
  const bands = [
    { range: '0 to 49', refund: refundBpsForScore(0) },
    { range: '50 to 64', refund: refundBpsForScore(50) },
    { range: '65 to 79', refund: refundBpsForScore(65) },
    { range: '80 to 100', refund: refundBpsForScore(80) },
  ];

  return (
    <div>
      <p className="text-detail text-[color:var(--color-muted)]">
        The median of the revealed scores falls in one of four bands, so resolvers a few points apart still reach the
        same outcome.
      </p>
      <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
        {bands.map((band) => (
          <li key={band.range} className="flex items-baseline gap-2 text-detail">
            <span className="tabular w-20 shrink-0 text-[color:var(--color-muted)]">{band.range}</span>
            <span>{refundWord(band.refund)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function refundWord(refundBps: number): string {
  if (refundBps === 10_000) return 'The payer is refunded in full.';
  if (refundBps === 0) return 'The payee keeps the whole payment.';
  return `The payer gets ${refundBps / 100}% back.`;
}

/** The copy, as a file. A browser that blocks the download leaves the value on screen to copy. */
function download(name: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Storage this browser will accept a write into.
 *
 * `localStorage` is present and throws on `setItem` in a private window with site data off, and
 * absent on the server. Finding that out here is what lets the panel say whether anything will be
 * kept here at all, rather than telling a resolver their salt was saved when it was not.
 */
function usableStorage() {
  const storage = browserStorage();
  if (storage === undefined) return undefined;

  const probe = 'bursar.resolver-vote.probe';
  try {
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return undefined;
  }
}
