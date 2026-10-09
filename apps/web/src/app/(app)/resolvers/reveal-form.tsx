'use client';

import { useId, useState } from 'react';
import { useSignMessage } from 'wagmi';
import type { Address, Hex } from 'viem';

import { CHAIN_ID, oracleRegistryAbi, shortAddress } from '@/chain';
import { CopyControl } from '@/components/address';
import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { Countdown } from '@/components/instant';
import { Card } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import type { AnyState } from '@/state';

import type { DisputeRow } from './desk';
import { parseScore, scoreMeaning, scoreProblem } from './phases';
import { resolverFailure } from './refusal';
import { browserStorage, commitmentFor, isSalt, saltFromSignature, saltMessage, saltProblem, scoreFor, voteStore } from './salt';
import { useWriteContract } from '@/wallet/write';

/**
 * Opening a sealed score.
 *
 * Three ways in, and a resolver with a bond at stake should have all of them. The quickest is the
 * note this browser kept when the score was sealed. The one that works anywhere is the wallet: the
 * salt was drawn by signing a fixed message, so signing it again on any machine gives the salt
 * back, and the score behind the commitment follows from it. The third is the copy the resolver
 * took away, typed in by hand.
 *
 * Every path verifies locally first. `revealVote` reverts `BadReveal` on a mismatch, and a
 * resolver with one reveal window left should not spend it finding that out from a receipt.
 */
export function RevealForm({
  dispute,
  account,
  registry,
  blockedBy,
  onDone,
}: {
  readonly dispute: DisputeRow;
  readonly account: Address;
  readonly registry: Address;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
}) {
  const [manual, setManual] = useState(false);
  const [note] = useState(() => {
    const storage = browserStorage();
    return storage === undefined ? undefined : voteStore(storage).read(registry, account, dispute.id);
  });

  const sealed = dispute.yours?.commitment;
  const noteOpens = note !== undefined && sealed !== undefined && note.commitment.toLowerCase() === sealed.toLowerCase();
  const showManual = manual || note === undefined || !noteOpens;

  return (
    <Card
      title="Reveal your score"
      description={
        <>
          The reveal window closes <Countdown to={dispute.revealEndsAt} />. A score not revealed by then is slashed.
        </>
      }
    >
      <div className="space-y-4">
        {note !== undefined && noteOpens && (
          <OneTouchReveal
            title="Sealed from this browser"
            dispute={dispute}
            registry={registry}
            blockedBy={blockedBy}
            onDone={onDone}
            score={note.score}
            salt={note.salt}
          />
        )}

        {note !== undefined && !noteOpens && (
          <p className="text-detail" style={{ color: 'var(--color-state-attention)' }}>
            The salt saved in this browser for dispute {dispute.id.toString()} does not match what this address sealed.
            Enter the salt you kept instead.
          </p>
        )}

        {note === undefined && !manual && (
          <p className="text-detail text-[color:var(--color-muted)]">
            This browser has no salt saved for dispute {dispute.id.toString()}. Draw it from the wallet that sealed the
            score, or enter the copy you kept.
          </p>
        )}

        {showManual ? (
          <>
            <WalletReveal
              dispute={dispute}
              account={account}
              registry={registry}
              blockedBy={blockedBy}
              onDone={onDone}
              sealed={sealed}
            />
            <ManualReveal
              dispute={dispute}
              account={account}
              registry={registry}
              blockedBy={blockedBy}
              onDone={onDone}
              sealed={sealed}
            />
          </>
        ) : (
          <button type="button" onClick={() => setManual(true)} className="text-detail underline underline-offset-2">
            I am revealing from a different machine
          </button>
        )}
      </div>
    </Card>
  );
}

/** A score and a salt that already open the commitment, and the one call that publishes them. */
function OneTouchReveal({
  title,
  dispute,
  registry,
  blockedBy,
  onDone,
  score,
  salt,
}: {
  readonly title: string;
  readonly dispute: DisputeRow;
  readonly registry: Address;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
  readonly score: number;
  readonly salt: Hex;
}) {
  const { writeContractAsync } = useWriteContract();

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-[color:var(--color-line)] bg-[color:var(--color-raised)] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-label uppercase tracking-wide text-[color:var(--color-muted)]">
            {title}
          </span>
          <CopyControl value={salt} label="Copy the salt" />
        </div>
        <p className="mt-1 text-sm">
          Score <span className="tabular font-semibold">{score}</span>. {scoreMeaning(score)}
        </p>
        <p className="tabular mt-1 break-all text-note text-[color:var(--color-muted)]">{salt}</p>
      </div>

      <TxButton
        label="Reveal this score"
        blockedBy={blockedBy}
        send={() =>
          writeContractAsync({
            address: registry,
            abi: oracleRegistryAbi,
            functionName: 'revealVote',
            args: [dispute.id, score, salt],
          }).catch((caught: unknown) => {
            throw resolverFailure(caught, { action: 'Reveal your score' });
          })
        }
        // Read the dispute again as soon as the reveal lands, so the line above stops saying it is not revealed.
        onConfirmed={onDone}
        onContinue={onDone}
      />
    </div>
  );
}

/**
 * The path that needs nothing but the wallet.
 *
 * The salt was drawn by signing a fixed message, so signing it again produces the same value on a
 * machine that has never seen this deployment. The score follows from it: a score is 0 to 100, so
 * the one that was sealed is the one whose commitment matches the registry's. A resolver who lost
 * a browser profile between the commit and the reveal loses nothing.
 *
 * A wallet is free to sign one message two different ways, and one that does lands here with a
 * salt that opens nothing. That is said plainly rather than sent as a transaction that reverts.
 */
function WalletReveal({
  dispute,
  account,
  registry,
  blockedBy,
  onDone,
  sealed,
}: {
  readonly dispute: DisputeRow;
  readonly account: Address;
  readonly registry: Address;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
  readonly sealed: Hex | undefined;
}) {
  const { signMessageAsync } = useSignMessage();
  const [drawing, setDrawing] = useState(false);
  const [drawn, setDrawn] = useState<{ readonly salt: Hex; readonly score: number | undefined } | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);

  if (sealed === undefined) {
    return (
      <p className="text-detail text-[color:var(--color-muted)]">
        Could not read what this address sealed, so a salt from the wallet cannot be checked. Read again, or reveal
        with the copy you kept.
      </p>
    );
  }

  const draw = async () => {
    setError(null);
    setDrawing(true);
    try {
      const signature = await signMessageAsync({
        account,
        message: saltMessage({ registry, chainId: CHAIN_ID, disputeId: dispute.id, resolver: account }),
      });
      const salt = saltFromSignature(signature);
      setDrawn({ salt, score: scoreFor(dispute.id, account, salt, sealed) });
    } catch (caught) {
      setError(caught);
    } finally {
      setDrawing(false);
    }
  };

  if (drawn?.score !== undefined) {
    return (
      <OneTouchReveal
        title={`Drawn from ${shortAddress(account)}`}
        dispute={dispute}
        registry={registry}
        blockedBy={blockedBy}
        onDone={onDone}
        score={drawn.score}
        salt={drawn.salt}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => void draw()} disabled={drawing}>
          {drawing ? 'Waiting for your wallet' : 'Draw the salt from your wallet'}
        </Button>
        <span className="text-detail text-[color:var(--color-muted)]">
          Signs the same message you signed when you sealed the score. No transaction, no fee.
        </span>
      </div>

      {drawn !== undefined && drawn.score === undefined && (
        <p className="text-detail" style={{ color: 'var(--color-state-attention)' }}>
          The salt from this wallet does not match what this address sealed. The score may have been sealed from another
          wallet, or this wallet signs the message differently each time. Reveal with the copy you kept instead.
        </p>
      )}

      {error !== null && <ErrorSurface error={error} action="Drawing the salt from your wallet" />}
    </div>
  );
}

function ManualReveal({
  dispute,
  account,
  registry,
  blockedBy,
  onDone,
  sealed,
}: {
  readonly dispute: DisputeRow;
  readonly account: Address;
  readonly registry: Address;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
  readonly sealed: Hex | undefined;
}) {
  const scoreId = useId();
  const saltId = useId();
  const [scoreText, setScoreText] = useState('');
  const [saltText, setSaltText] = useState('');
  const { writeContractAsync } = useWriteContract();

  const score = parseScore(scoreText);
  const scoreIssue = scoreText.trim() === '' ? undefined : scoreProblem(score);
  const saltIssue = saltText.trim() === '' ? undefined : saltProblem(saltText);

  const salt = saltText.trim();
  const complete = score !== undefined && scoreIssue === undefined && isSalt(salt);
  const computed = complete ? commitmentFor(dispute.id, account, score, salt) : undefined;
  const opens = computed !== undefined && sealed !== undefined && computed.toLowerCase() === sealed.toLowerCase();

  return (
    <div className="space-y-3 border-t border-[color:var(--color-line)] pt-4">
      <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]">
        <div className="space-y-1">
          <label htmlFor={scoreId} className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
            Score
          </label>
          <input
            id={scoreId}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            value={scoreText}
            placeholder="0"
            aria-invalid={scoreIssue !== undefined}
            onChange={(event) => setScoreText(event.target.value)}
            className="tabular h-11 w-full border bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
            style={{ borderColor: scoreIssue === undefined ? 'var(--color-line)' : 'var(--color-state-blocked)' }}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={saltId} className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
            Salt
          </label>
          <input
            id={saltId}
            autoComplete="off"
            spellCheck={false}
            value={saltText}
            placeholder="0x…"
            aria-invalid={saltIssue !== undefined}
            onChange={(event) => setSaltText(event.target.value)}
            className="tabular h-11 w-full border bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
            style={{ borderColor: saltIssue === undefined ? 'var(--color-line)' : 'var(--color-state-blocked)' }}
          />
        </div>
      </div>

      <p className="text-detail" style={{ color: verdictColour(scoreIssue, saltIssue, complete, opens, sealed) }}>
        {verdict(scoreIssue, saltIssue, complete, opens, sealed, score)}
      </p>

      <TxButton
        label="Reveal this score"
        disabled={!opens}
        blockedBy={blockedBy}
        send={() => {
          if (score === undefined || !isSalt(salt)) throw new Error('Enter the score and the salt you sealed.');
          return writeContractAsync({
            address: registry,
            abi: oracleRegistryAbi,
            functionName: 'revealVote',
            args: [dispute.id, score, salt],
          }).catch((caught: unknown) => {
            throw resolverFailure(caught, { action: 'Reveal your score' });
          });
        }}
        onContinue={onDone}
      />
    </div>
  );
}

function verdict(
  scoreIssue: string | undefined,
  saltIssue: string | undefined,
  complete: boolean,
  opens: boolean,
  sealed: Hex | undefined,
  score: number | undefined,
): string {
  if (scoreIssue !== undefined) return scoreIssue;
  if (saltIssue !== undefined) return saltIssue;
  if (!complete) return 'Enter the score you sealed and its salt, exactly as sealed.';
  if (sealed === undefined) {
    return 'Could not read what this address sealed, so this pair cannot be checked here. The reveal still works if both are right.';
  }
  if (!opens) {
    return 'These do not match what this address sealed, so the reveal would be refused. Check the score and every character of the salt.';
  }
  return `This matches your sealed score. ${score === undefined ? '' : scoreMeaning(score)}`;
}

function verdictColour(
  scoreIssue: string | undefined,
  saltIssue: string | undefined,
  complete: boolean,
  opens: boolean,
  sealed: Hex | undefined,
): string {
  if (scoreIssue !== undefined || saltIssue !== undefined) return 'var(--color-state-blocked)';
  if (!complete) return 'var(--color-muted)';
  if (sealed === undefined) return 'var(--color-state-attention)';
  return opens ? 'var(--color-state-ok)' : 'var(--color-state-blocked)';
}
