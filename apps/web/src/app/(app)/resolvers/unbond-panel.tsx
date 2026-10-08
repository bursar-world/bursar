'use client';

import type { Address } from 'viem';

import { oracleRegistryAbi } from '@/chain';
import { Countdown, Instant } from '@/components/instant';
import { Card, Field, FieldGrid } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { formatDuration, isPast } from '@/lib';
import { formatBrsr } from '@/money';
import type { AnyState } from '@/state';

import type { ResolverDesk } from './desk';
import { ResolverStatus } from './phases';
import { resolverFailure } from './refusal';
import { useWriteContract } from '@/wallet/write';

/**
 * Leaving, in the three steps the registry has.
 *
 * Asking to unbond stops the registry drawing this address into anything new. It does not release
 * a single vote already sealed: `completeUnbond` reads the live count of open commitments and
 * refuses while any of them stand, whatever the cooldown says. A resolver who reads "requested" as
 * "finished" walks away from a reveal and is slashed for silence, so the count is on the card and
 * the sentence says it plainly.
 */
export function UnbondPanel({
  desk,
  account,
  blockedBy,
  onDone,
}: {
  readonly desk: ResolverDesk | undefined;
  readonly account: Address | undefined;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const standing = desk?.standing;
  const registry = desk?.registry;
  const config = desk?.config;

  const period = config === undefined ? undefined : formatDuration(Number(config.unbondingPeriod));
  const waiting = standing?.status === ResolverStatus.Unbonding;
  const active = standing?.status === ResolverStatus.Active;
  const openVotes = standing?.openVotes;
  const maturesAt = standing?.maturesAt ?? null;
  const matured = maturesAt !== null && isPast(maturesAt, desk?.chainTime ?? new Date());

  if (account === undefined) {
    return (
      <Card title="Leaving the bench" description="How to take your bond back.">
        <p className="text-sm">
          Leaving takes three steps: ask to unbond, wait out the cooldown
          {period === undefined ? '' : ` of ${period}`}, then complete the exit. Connect a wallet to see your bond.
        </p>
      </Card>
    );
  }

  if (registry === undefined || standing === undefined) {
    return (
      <Card title="Leaving the bench">
        <p className="text-sm text-[color:var(--color-muted)]">
          {desk === undefined ? 'Reading your bond.' : 'Could not read your bond. Read again.'}
        </p>
      </Card>
    );
  }

  if (!waiting && !active) {
    return (
      <Card title="Leaving the bench" description="This wallet has no bond to withdraw.">
        <p className="text-sm">
          With a bond, leaving takes three steps: ask to unbond, wait out the cooldown
          {period === undefined ? '' : ` of ${period}`}, then complete the exit.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="Leaving the bench"
      description={waiting ? 'Your exit is in progress.' : 'Ask to unbond, wait out the cooldown, then complete the exit.'}
    >
      <div className="space-y-4">
        <FieldGrid columns={3}>
          <Field label="Bonded">
            <span className="tabular">{standing.bond === undefined ? 'Not read' : `${formatBrsr(standing.bond)} BRSR`}</span>
          </Field>
          <Field label="Votes still open" hint="Sealed scores on disputes still open.">
            <span className="tabular">{openVotes === undefined ? 'Not read' : openVotes.toString()}</span>
          </Field>
          <Field label={waiting ? (matured ? 'Ready since' : 'Cooldown ends') : 'Cooldown'} hint={waiting ? 'Counted from your request.' : 'Starts when you ask.'}>
            {waiting ? (
              standing.maturesAt === null ? (
                'Not read'
              ) : matured ? (
                <Instant at={standing.maturesAt} />
              ) : (
                <Countdown to={standing.maturesAt} />
              )
            ) : (
              (period ?? 'Not read')
            )}
          </Field>
        </FieldGrid>

        <p className="text-sm">
          Asking to unbond stops new votes from this address and starts the cooldown. Any score you sealed still has to
          be revealed, and the bond stays locked until those disputes close, even after the cooldown ends.
        </p>

        {waiting ? (
          <div className="flex flex-wrap gap-3">
            <TxButton
              label="Complete the exit"
              disabled={!matured || openVotes === undefined || openVotes > 0}
              blockedBy={blockedBy}
              send={() =>
                writeContractAsync({
                  address: registry,
                  abi: oracleRegistryAbi,
                  functionName: 'completeUnbond',
                }).catch((caught: unknown) => {
                  throw resolverFailure(caught, { action: 'Complete the exit' });
                })
              }
              onContinue={onDone}
            />
            <TxButton
              label="Cancel the exit"
              tone="secondary"
              blockedBy={blockedBy}
              send={() =>
                writeContractAsync({
                  address: registry,
                  abi: oracleRegistryAbi,
                  functionName: 'cancelUnbond',
                }).catch((caught: unknown) => {
                  throw resolverFailure(caught, { action: 'Cancel the exit' });
                })
              }
              onContinue={onDone}
            />
          </div>
        ) : (
          <TxButton
            label="Ask to unbond"
            tone="secondary"
            blockedBy={blockedBy}
            send={() =>
              writeContractAsync({
                address: registry,
                abi: oracleRegistryAbi,
                functionName: 'requestUnbond',
              }).catch((caught: unknown) => {
                throw resolverFailure(caught, { action: 'Ask to unbond' });
              })
            }
            onContinue={onDone}
            confirmPhrase="unbond"
            confirmTitle="Ask to unbond"
            confirmDescription={
              <>
                This stops new votes from this address and starts a cooldown
                {period === undefined ? '' : ` of ${period}`}. You still have to reveal any score you sealed. Cancelling
                puts you back on the bench without moving the bond.
              </>
            }
          />
        )}

        {waiting && openVotes !== undefined && openVotes > 0 && (
          <p className="text-detail" style={{ color: 'var(--color-state-attention)' }}>
            {openVotes} {openVotes === 1 ? 'vote is' : 'votes are'} still open, so the bond cannot leave until those
            disputes close. Reveal any score you sealed.
          </p>
        )}
        {waiting && !matured && openVotes === 0 && (
          <p className="text-detail text-[color:var(--color-muted)]">
            Only the cooldown is left. You can complete the exit when the countdown ends.
          </p>
        )}
        {waiting && (
          <p className="text-detail text-[color:var(--color-muted)]">
            The cooldown uses the period governance sets now, counted from your request. If governance shortens it, this
            date moves.
          </p>
        )}
        {!waiting && (
          <p className="text-detail text-[color:var(--color-muted)]">
            You can cancel any time before completing, and the bond goes back to work without moving.
          </p>
        )}
      </div>
    </Card>
  );
}
