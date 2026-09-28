'use client';

import { useState } from 'react';
import type { Address } from 'viem';

import { ADDRESSES, adminTimelockAbi, sameAddress } from '@/chain';
import { Address as AddressLabel } from '@/components/address';
import { Badge } from '@/components/badge';
import { Button } from '@/components/button';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { formatDuration } from '@/lib';
import type { AnyState } from '@/state';

import { CalldataBuilder } from './builder';
import type { BrakeTarget } from './read';
import { permits } from './roles';
import type { Answer } from './roles';
import { useWriteContract } from '@/wallet/write';

/**
 * Proposing a change.
 *
 * The proposer's own approval counts as the first of the two, so a change made here needs exactly
 * one further signer and then the full delay. Nothing on this panel can shorten either.
 */
export function ProposePanel({
  canPropose,
  delaySeconds,
  blockedBy,
  onProposed,
  only,
  title = 'Propose a change',
  description,
}: {
  readonly canPropose: Answer;
  readonly delaySeconds: bigint | undefined;
  readonly blockedBy: readonly AnyState[];
  readonly onProposed: () => void;
  readonly only?: readonly string[];
  readonly title?: string;
  readonly description?: string;
}) {
  const { writeContractAsync } = useWriteContract();
  const allowed = permits(canPropose);

  return (
    <Section
      title={title}
      description={
        description ??
        `Proposing counts as your own approval. One more signer and ${
          delaySeconds === undefined ? 'the delay' : formatDuration(Number(delaySeconds))
        } stand between this and the change taking effect.`
      }
    >
      <Card>
        <CalldataBuilder only={only}>
          {(built) => (
            <div className="space-y-2">
              {built.ok ? (
                <TxButton
                  label="Propose"
                  disabled={!allowed}
                  blockedBy={blockedBy}
                  send={() =>
                    writeContractAsync({
                      address: ADDRESSES.adminTimelock,
                      abi: adminTimelockAbi,
                      functionName: 'propose',
                      args: [built.target as Address, built.data],
                    })
                  }
                  onConfirmed={onProposed}
                />
              ) : (
                <Button disabled>Propose</Button>
              )}
              {!allowed && (
                <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
                  Proposing needs one of the three signer keys. This wallet is not one of them.
                </p>
              )}
            </div>
          )}
        </CalldataBuilder>
      </Card>
    </Section>
  );
}

/**
 * The brake.
 *
 * A pause that takes two days is not a brake, so the guardian stops a contract in the same block
 * with no approvals and no wait. Starting one again is an ordinary proposal and waits out the full
 * delay. That asymmetry is the whole design: a stolen guardian key costs an outage, never a loss.
 */
export function GuardianPanel({
  canPause,
  targets,
  timelock,
  delaySeconds,
  blockedBy,
  onPaused,
}: {
  readonly canPause: Answer;
  readonly targets: readonly BrakeTarget[];
  readonly timelock: Address;
  readonly delaySeconds: bigint | undefined;
  readonly blockedBy: readonly AnyState[];
  readonly onPaused: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const [chosen, setChosen] = useState<readonly Address[]>([]);
  const allowed = permits(canPause);

  const toggle = (address: Address) =>
    setChosen((current) => (current.some((entry) => sameAddress(entry, address)) ? current.filter((entry) => !sameAddress(entry, address)) : [...current, address]));

  return (
    <Section
      title="The brake"
      description="Stops an administered contract in the same block. No approvals, no delay, and no other call this key can make."
    >
      <Card>
        <div className="max-w-3xl space-y-3 text-sm">
          <p>
            The guardian key pauses and does nothing else. The call it sends is built inside the timelock and is always{' '}
            <code>pause()</code>, so the key cannot be talked into anything adjacent to a pause. Restarting is an ordinary
            proposal: two signatures and{' '}
            {delaySeconds === undefined ? 'the full delay' : formatDuration(Number(delaySeconds))}. Stopping is instant and
            starting is not, because a brake that takes two days is not a brake, and a stolen guardian key should cost an
            outage rather than a loss.
          </p>
          <p className="text-[color:var(--color-muted)]">
            Three contracts carry a pause. The escrow, reputation, the dispute registry, the mandate account factory and the
            token carry none, so stopping the money path means stopping the registry the agents using it are registered in.
          </p>
        </div>

        <div className="mt-5 space-y-2">
          {targets.map((target) => {
            const administered = target.admin === undefined ? undefined : sameAddress(target.admin, timelock);
            const stopped = target.paused;
            const checked = chosen.some((entry) => sameAddress(entry, target.address));

            return (
              <div
                key={target.address}
                className="flex flex-wrap items-center gap-3 rounded-md border border-[color:var(--color-line)] px-3 py-2"
              >
                {/* The label covers the checkbox and the name only. The copy and explorer controls
                    on the address are their own buttons, and inside a label a press on either of
                    them would tick the box instead. */}
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!allowed || stopped === true || administered === false}
                    onChange={() => toggle(target.address)}
                  />
                  <span className="text-sm font-medium">{target.name}</span>
                </label>
                <AddressLabel value={target.address} />
                <span className="ml-auto flex items-center gap-2">
                  <Badge tone={stopped === true ? 'neutral' : 'quiet'}>
                    {stopped === undefined ? 'Not read' : stopped ? 'Stopped' : 'Running'}
                  </Badge>
                  {administered === false && <Badge tone="quiet">Out of reach</Badge>}
                </span>
              </div>
            );
          })}
        </div>

        {targets.some((target) => target.admin !== undefined && !sameAddress(target.admin, timelock)) && (
          <p className="mt-3 text-detail" style={{ color: 'var(--color-state-attention)' }}>
            A contract marked out of reach has an admin other than the timelock, so the brake cannot stop it. Propose{' '}
            <code>acceptAdmin</code> on it, wait out the delay, and the brake reaches it afterwards.
          </p>
        )}

        <div className="mt-5 space-y-2">
          <TxButton
            label={chosen.length > 1 ? `Stop ${chosen.length} contracts` : 'Stop'}
            tone="destructive"
            disabled={chosen.length === 0 || !allowed}
            blockedBy={blockedBy}
            confirmPhrase="PAUSE"
            confirmTitle="Stop these contracts now"
            confirmDescription="This lands in the next block with no approvals and no delay. Starting them again is a proposal, which takes two signatures and the full delay."
            send={() =>
              writeContractAsync({
                address: ADDRESSES.adminTimelock,
                abi: adminTimelockAbi,
                functionName: 'guardianPause',
                args: [chosen],
              })
            }
            onConfirmed={() => {
              setChosen([]);
              onPaused();
            }}
          />
          {!allowed && (
            <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
              The pause needs the guardian key. This wallet is not the guardian, and no signer key can send it.
            </p>
          )}
          {allowed && chosen.length === 0 && (
            <p className="text-detail text-[color:var(--color-muted)]">Choose at least one contract to stop.</p>
          )}
        </div>

        <div className="mt-5">
          <FieldGrid columns={2}>
            <Field label="Guardian sends through" hint="The timelock builds the call, so the key cannot reach anything else.">
              <AddressLabel value={timelock} />
            </Field>
            <Field label="Restarting" hint="A proposal on the contract's own unpause, from the list above.">
              {delaySeconds === undefined ? 'The full delay' : `Two signatures and ${formatDuration(Number(delaySeconds))}`}
            </Field>
          </FieldGrid>
        </div>
      </Card>
    </Section>
  );
}
