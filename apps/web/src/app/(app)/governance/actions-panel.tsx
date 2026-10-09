'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { readContract } from 'viem/actions';
import type { Address } from 'viem';

import { adminTimelockAbi, rhcClient, sameAddress } from '@/chain';
import { governedByKey, pauseControllerOf } from '@/chain/admin-actions';
import type { AdminAction } from '@/chain/admin-actions';
import { Address as AddressLabel } from '@/components/address';
import { Badge } from '@/components/badge';
import { Button } from '@/components/button';
import { Card, Section } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { spellDuration } from '@/lib';
import type { AnyState } from '@/state';

import { CalldataBuilder } from './builder';
import { governanceTimelocks } from './read';
import type { BrakeTarget, TimelockTag } from './read';
import { permits } from './roles';
import type { Answer } from './roles';
import { useWriteContract } from '@/wallet/write';

/**
 * Proposing a change.
 *
 * The proposer's own approval counts as the first of the two, so a change made here needs exactly
 * one further signer and then the full delay. Nothing on this panel can shorten either.
 */
/**
 * The governance delay a proposal on `action` has to go to: the one that administers its target.
 * A proposal sent to the other would wait out its delay and then revert, so the answer is read
 * from the target and the propose control stays off until it lands.
 */
function useProposingTimelock(action: AdminAction | undefined): {
  readonly timelock: TimelockTag | undefined;
  readonly problem: string | undefined;
} {
  const timelocks = governanceTimelocks();
  const contract = action === undefined ? undefined : governedByKey(action.contract);
  const target = contract?.address();
  const self = timelocks.find((entry) => sameAddress(entry.address, target));
  const controller = action === undefined ? 'admin' : pauseControllerOf(action.contract);

  const admin = useQuery({
    queryKey: ['governance', 'admin-of', target, controller],
    queryFn: async () =>
      (await readContract(rhcClient(), { address: target as Address, abi: contract?.abi as never, functionName: controller })) as Address,
    enabled: target !== undefined && self === undefined,
    staleTime: 60_000,
  });

  if (action === undefined || contract === undefined) return { timelock: undefined, problem: undefined };
  if (self) return { timelock: self, problem: undefined };
  if (admin.isPending) return { timelock: undefined, problem: `Reading which governance delay administers ${contract.name}.` };
  if (admin.data === undefined) {
    return { timelock: undefined, problem: `Could not read which governance delay administers ${contract.name}. Read again before proposing.` };
  }
  const match = timelocks.find((entry) => sameAddress(entry.address, admin.data));
  if (!match) {
    return {
      timelock: undefined,
      problem: `${capitalise(contract.name)} is administered by ${admin.data}, which is not one of the governance delays, so a proposal from here cannot change it.`,
    };
  }
  return { timelock: match, problem: undefined };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

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
        `Proposing counts as your approval. The change then needs one more signer and the delay that administers it${
          delaySeconds === undefined ? '' : `, ${spellDuration(Number(delaySeconds))} on the current contracts`
        }.`
      }
    >
      <Card>
        <CalldataBuilder only={only}>
          {(built, action) => (
            <ProposeControl
              built={built}
              action={action}
              allowed={allowed}
              blockedBy={blockedBy}
              onProposed={onProposed}
              send={(timelock) => {
                if (!built.ok) throw new Error('The change is not complete yet.');
                return writeContractAsync({
                  address: timelock,
                  abi: adminTimelockAbi,
                  functionName: 'propose',
                  args: [built.target, built.data],
                });
              }}
            />
          )}
        </CalldataBuilder>
      </Card>
    </Section>
  );
}

function ProposeControl({
  built,
  action,
  allowed,
  blockedBy,
  onProposed,
  send,
}: {
  readonly built: { readonly ok: boolean };
  readonly action: AdminAction;
  readonly allowed: boolean;
  readonly blockedBy: readonly AnyState[];
  readonly onProposed: () => void;
  readonly send: (timelock: Address) => Promise<`0x${string}`>;
}) {
  const { timelock, problem } = useProposingTimelock(action);

  return (
    <div className="space-y-2">
      {built.ok && timelock ? (
        <TxButton label="Propose" disabled={!allowed} blockedBy={blockedBy} send={() => send(timelock.address)} onConfirmed={onProposed} />
      ) : (
        <Button disabled>Propose</Button>
      )}
      {timelock && (
        <p className="text-detail text-[color:var(--color-muted)]">
          Goes to the governance delay for {timelock.name.toLowerCase()}, <AddressLabel value={timelock.address} />, which
          administers this contract.
        </p>
      )}
      {problem && <p className="text-detail text-[color:var(--color-muted)]">{problem}</p>}
      {!allowed && (
        <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
          Proposing needs one of the three signer keys. This wallet is not one of them.
        </p>
      )}
    </div>
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
  delaySeconds,
  escrowDelaySeconds,
  blockedBy,
  onPaused,
}: {
  readonly canPause: Answer;
  readonly targets: readonly BrakeTarget[];
  readonly delaySeconds: bigint | undefined;
  /** The delay of the timelock that keeps the escrow's brake, where it is not the current one. */
  readonly escrowDelaySeconds?: bigint | undefined;
  readonly blockedBy: readonly AnyState[];
  readonly onPaused: () => void;
}) {
  const allowed = permits(canPause);
  const escrowRestart = escrowDelaySeconds === undefined || escrowDelaySeconds === delaySeconds ? undefined : spellDuration(Number(escrowDelaySeconds));
  const timelocks = governanceTimelocks();
  const outOfReach = targets.filter((target) => target.admin !== undefined && !timelocks.some((tag) => sameAddress(tag.address, target.admin)));
  const unread = targets.filter((target) => target.admin === undefined);

  return (
    <Section
      title="The brake"
      description="Pauses a contract at once, with no approvals and no delay. This key can do nothing else."
    >
      <Card>
        <div className="max-w-3xl space-y-3 text-sm">
          <p>
            The guardian key only pauses. The governance delay builds the call itself, and it is always{' '}
            <code>pause()</code>. Restarting is an ordinary proposal: two signatures and the full delay of the contract
            that paused it{delaySeconds === undefined ? '' : `, ${spellDuration(Number(delaySeconds))} on the current contracts`}
            {escrowRestart === undefined ? '' : ` and ${escrowRestart} for the escrow`}. Stopping is instant and starting is
            not, so a stolen guardian key can cause an outage but cannot move funds.
          </p>
          <p className="text-[color:var(--color-muted)]">
            The escrow, the dispute registry, the provider registry, the staking pool and the buyback can be paused.
            Reputation, the mandate factories and the token cannot. Each contract can only be paused through the delay
            that administers it, so they are grouped by delay below.
          </p>
        </div>

        {timelocks.map((tag) => {
          const group = targets.filter((target) => sameAddress(target.admin, tag.address));
          if (group.length === 0) return null;
          return <BrakeGroup key={tag.address} tag={tag} targets={group} allowed={allowed} blockedBy={blockedBy} onPaused={onPaused} />;
        })}

        {(outOfReach.length > 0 || unread.length > 0) && (
          <div className="mt-5 space-y-2">
            {[...outOfReach, ...unread].map((target) => (
              <div key={target.address} className="flex flex-wrap items-center gap-3 rounded-md border border-[color:var(--color-line)] px-3 py-2">
                <span className="text-sm font-medium">{target.name}</span>
                <AddressLabel value={target.address} />
                <span className="ml-auto">
                  <Badge tone="quiet">{target.admin === undefined ? 'Not read' : 'Out of reach'}</Badge>
                </span>
              </div>
            ))}
            {outOfReach.length > 0 && (
              <p className="text-detail" style={{ color: 'var(--color-state-attention)' }}>
                A contract marked Out of reach is paused through an address that is not a governance delay, so the brake
                cannot stop it.
              </p>
            )}
          </div>
        )}

        {!allowed && (
          <p className="mt-5 text-detail text-[color:var(--color-muted)]">
            The pause needs the guardian key. This wallet is not the guardian, and no signer key can send it.
          </p>
        )}
      </Card>
    </Section>
  );
}

/** "the escrow", or "the escrow and the buyback": what the confirmation is about to stop. */
function namesOf(targets: readonly BrakeTarget[], chosen: readonly Address[]): string {
  const names = targets.filter((target) => chosen.some((entry) => sameAddress(entry, target.address))).map((target) => target.name);
  if (names.length <= 1) return names[0] ?? 'these contracts';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function BrakeGroup({
  tag,
  targets,
  allowed,
  blockedBy,
  onPaused,
}: {
  readonly tag: TimelockTag;
  readonly targets: readonly BrakeTarget[];
  readonly allowed: boolean;
  readonly blockedBy: readonly AnyState[];
  readonly onPaused: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const [chosen, setChosen] = useState<readonly Address[]>([]);

  const toggle = (address: Address) =>
    setChosen((current) => (current.some((entry) => sameAddress(entry, address)) ? current.filter((entry) => !sameAddress(entry, address)) : [...current, address]));

  return (
    <div className="mt-5 space-y-2">
      <p className="text-detail text-[color:var(--color-muted)]">
        {tag.current ? 'Stopped through the current governance delay at' : 'Stopped through the delay at'} <AddressLabel value={tag.address} />
      </p>
      {tag.brake !== undefined && (
        <p className="text-detail text-[color:var(--color-muted)]">
          {tag.brake === 'each-target'
            ? 'Each contract stops on its own. One that refuses, because it is already stopped or cannot be paused, is skipped and the rest still stop. A skipped contract keeps showing as running below.'
            : 'On this delay the brake is all or nothing: if one of the chosen contracts refuses the pause, none of them stop. Choose only contracts that are running.'}
        </p>
      )}
      {targets.map((target) => {
        const stopped = target.paused;
        const checked = chosen.some((entry) => sameAddress(entry, target.address));
        return (
          <div key={target.address} className="flex flex-wrap items-center gap-3 rounded-md border border-[color:var(--color-line)] px-3 py-2">
            {/* The label covers the checkbox and the name only. The copy and explorer controls on the
                address are their own buttons, and inside a label a press on either of them would
                tick the box instead. */}
            <label className="flex items-center gap-3">
              <input type="checkbox" checked={checked} disabled={!allowed || stopped === true} onChange={() => toggle(target.address)} />
              <span className="text-sm font-medium">{target.name}</span>
            </label>
            <AddressLabel value={target.address} />
            <span className="ml-auto">
              <Badge tone={stopped === true ? 'neutral' : 'quiet'}>{stopped === undefined ? 'Not read' : stopped ? 'Stopped' : 'Running'}</Badge>
            </span>
          </div>
        );
      })}
      {allowed && (
        <TxButton
          label={chosen.length > 1 ? `Stop ${chosen.length} contracts` : 'Stop'}
          tone="destructive"
          disabled={chosen.length === 0}
          blockedBy={blockedBy}
          confirmPhrase="PAUSE"
          confirmTitle={`Stop ${namesOf(targets, chosen)} now`}
          confirmDescription={`This lands in the next block with no approvals and no delay. Starting ${chosen.length > 1 ? 'them' : 'it'} again is a proposal, which takes two signatures and the full delay.`}
          send={() =>
            writeContractAsync({
              address: tag.address,
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
      )}
    </div>
  );
}
