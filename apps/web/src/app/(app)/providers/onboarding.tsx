'use client';

import { micro } from '@bursar/core';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { ADDRESSES, agentRegistryAbi, settlementAssetAbi, shortAddress } from '@/chain';
import { LevelDot } from '@/components/badge';
import { AmountInput } from '@/components/amount-input';
import { Countdown, Instant } from '@/components/instant';
import { Card, Field, FieldGrid } from '@/components/layout';
import { TxButton, preventNavigation } from '@/components/tx-button';
import { formatSpan } from '@/lib';
import { bps, usd } from '@/money';
import type { AnyState } from '@/state';

import type { ProviderDesk } from './desk';
import { NAME_MAX_LENGTH, deactivateGate, factsOf, nameProblem, reactivateGate, registrationGate, topUpGate, withdrawalCancelGate, withdrawalExecuteGate, withdrawalRequestGate } from './registry';
import type { Gate } from './registry';
import { useWriteContract } from '@/wallet/write';

export type PanelProps = {
  readonly desk: ProviderDesk;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
};

/**
 * Joining the registry, which is the step that makes an address payable at all.
 *
 * The escrow refuses a lock whose payee the registry does not list and mark active, so until this
 * transaction lands nothing in the product can pay this address, however well it delivers. The
 * stake is collateral, not a listing fee, and the card says what takes it.
 */
export function RegisterCard({
  desk,
  blockedBy,
  onDone,
  onRegistered,
}: PanelProps & {
  /** The receipt landed. The desk waits for the reader before it reads the listing back. */
  readonly onRegistered: () => void;
}) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [atomic, setAtomic] = useState<bigint | undefined>(undefined);
  // The receipt has landed and the reader has not moved past it. The form is cleared by then, so
  // the gate note under the button would answer the empty form and read as a failure under a
  // confirmation.
  const [landed, setLanded] = useState(false);
  // What was registered, kept for the confirmation once the form has been cleared.
  const [listed, setListed] = useState<{ readonly name: string; readonly stake: bigint } | undefined>(undefined);
  const { writeContractAsync } = useWriteContract();

  const facts = factsOf(desk);
  const { standing } = desk;
  const gate = registrationGate(facts, { name, stake: atomic });
  const amount = atomic ?? 0n;
  const floor = standing.minStake;
  const ruling = standing.slashBps;

  return (
    <Card
      title="Join the registry"
      description="List your address so payers can pay you."
    >
      <form className="space-y-4" onSubmit={preventNavigation}>
        {landed && listed !== undefined && (
          <p className="text-sm">
            Listed as <span className="font-medium">{listed.name}</span> with a stake of {usd(micro(listed.stake))}. Payers
            can open jobs with this address now.
          </p>
        )}
        {!landed && (
          <FieldGrid columns={2}>
            <div className="space-y-1">
              <label
                htmlFor="provider-handle"
                className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]"
              >
                Handle
              </label>
              <input
                id="provider-handle"
                value={name}
                maxLength={NAME_MAX_LENGTH}
                autoComplete="off"
                spellCheck={false}
                placeholder="transcribe_eu"
                aria-invalid={nameProblem(name) !== undefined}
                onChange={(event) => setName(event.target.value)}
                className="h-11 w-full border bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
                style={{ borderColor: nameProblem(name) ? 'var(--color-state-blocked)' : 'var(--color-line)' }}
              />
              <p className="text-note" style={{ color: nameProblem(name) ? 'var(--color-state-blocked)' : 'var(--color-muted)' }}>
                {nameProblem(name) ??
                  'A display name. Your address remains your identity.'}
              </p>
            </div>

            <AmountInput
              label="Stake"
              asset="USDG"
              value={text}
              onChange={(next, value) => {
                setText(next);
                setAtomic(value);
              }}
              max={desk.balance === undefined ? undefined : { atomic: desk.balance, label: 'All of it' }}
              hint={
                floor === undefined
                  ? 'The minimum stake could not be read.'
                  : `At least ${usd(floor)}. A ruling against a job can take part of it.`
              }
            />
          </FieldGrid>
        )}

        {!landed && <StakeTerms desk={desk} />}

        {/*
          Keyed apart because these are two different actions in one slot. Without the keys React
          keeps one button instance across the swap, and the allowance's confirmed state is still
          on screen under the label of the call that has not been made yet.
        */}
        {gate.kind === 'approve' ? (
          <TxButton
            key="approve"
            label={`Allow the registry ${usd(micro(amount))}`}
            tone="secondary"
            type="submit"
            blockedBy={blockedBy}
            send={() =>
              writeContractAsync({
                address: ADDRESSES.usdg,
                abi: settlementAssetAbi,
                functionName: 'approve',
                args: [ADDRESSES.agentRegistry, amount],
              })
            }
            onContinue={onDone}
          />
        ) : (
          <TxButton
            key="register"
            label="Register with this stake"
            type="submit"
            disabled={gate.kind !== 'ready'}
            blockedBy={blockedBy}
            send={() =>
              writeContractAsync({
                address: ADDRESSES.agentRegistry,
                abi: agentRegistryAbi,
                functionName: 'register',
                args: [name, amount],
              })
            }
            onConfirmed={() => {
              setListed({ name, stake: amount });
              setText('');
              setAtomic(undefined);
              setLanded(true);
              onRegistered();
            }}
            continueLabel="Open your desk"
            onContinue={onDone}
          />
        )}

        {!landed && <GateNote gate={gate} />}

        {!landed && (
          <p className="text-detail text-[color:var(--color-muted)]">
            Two transactions: allow the registry to take the stake, then register. The stake is paid in USDG and
            transaction fees in ETH.
            {ruling !== undefined && ` One ruling can take up to ${bps(ruling)} of the stake.`}
          </p>
        )}
      </form>
    </Card>
  );
}

/** Adding to a stake that is already posted. */
export function AddStakeCard({ desk, blockedBy, onDone }: PanelProps) {
  const [text, setText] = useState('');
  const [atomic, setAtomic] = useState<bigint | undefined>(undefined);
  const { writeContractAsync } = useWriteContract();

  const facts = factsOf(desk);
  const gate = topUpGate(facts, atomic);
  const amount = atomic ?? 0n;
  const pending = desk.standing.withdrawal;

  return (
    <Card title="Add to the stake" description="Payers see your stake before they allow your address.">
      <form className="max-w-md space-y-4" onSubmit={preventNavigation}>
        <AmountInput
          label="Amount to add"
          asset="USDG"
          value={text}
          onChange={(next, value) => {
            setText(next);
            setAtomic(value);
          }}
          max={desk.balance === undefined ? undefined : { atomic: desk.balance, label: 'All of it' }}
          hint="Only your score raises the job ceiling."
        />

        {/*
          Keyed apart because these are two different actions in one slot. Without the keys React
          keeps one button instance across the swap, and the allowance's confirmed state is still
          on screen under the label of the call that has not been made yet.
        */}
        {gate.kind === 'approve' ? (
          <TxButton
            key="approve"
            label={`Allow the registry ${usd(micro(amount))}`}
            tone="secondary"
            type="submit"
            blockedBy={blockedBy}
            send={() =>
              writeContractAsync({
                address: ADDRESSES.usdg,
                abi: settlementAssetAbi,
                functionName: 'approve',
                args: [ADDRESSES.agentRegistry, amount],
              })
            }
            onContinue={onDone}
          />
        ) : (
          <TxButton
            key="add"
            label="Add it"
            type="submit"
            disabled={gate.kind !== 'ready'}
            blockedBy={blockedBy}
            send={() =>
              writeContractAsync({
                address: ADDRESSES.agentRegistry,
                abi: agentRegistryAbi,
                functionName: 'addStake',
                args: [amount],
              })
            }
            onConfirmed={() => {
              setText('');
              setAtomic(undefined);
              onDone();
            }}
          />
        )}

        <GateNote gate={gate} />

        {pending && (
          <p className="text-detail" style={{ color: 'var(--color-state-attention)' }}>
            A withdrawal of {usd(pending.amount)} is pending. Adding stake cancels it, and a new request starts the wait
            again.
          </p>
        )}
      </form>
    </Card>
  );
}

/**
 * Taking a stake back out, in the three steps the registry has.
 *
 * The delay is the point of the design: it closes the window between a bad job and the ruling on
 * it, so a stake cannot leave while a dispute is being decided. The thing a payee has to be told
 * here is that asking changes nothing about the work. Locks already open still have to be
 * delivered, and the stake stays slashable until the day it leaves.
 */
export function WithdrawalCard({ desk, blockedBy, onDone }: PanelProps) {
  const [text, setText] = useState('');
  const [atomic, setAtomic] = useState<bigint | undefined>(undefined);
  const { writeContractAsync } = useWriteContract();

  const facts = factsOf(desk);
  const { standing } = desk;
  const pending = standing.withdrawal;
  const delay = standing.withdrawalDelay === undefined ? undefined : formatSpan(Number(standing.withdrawalDelay));

  const requestGate = withdrawalRequestGate(facts, atomic);
  const executeGate = withdrawalExecuteGate(facts);
  const cancelGate = withdrawalCancelGate(facts);

  const openLocks = desk.complete ? desk.working.length : undefined;
  const caveat =
    openLocks === undefined
      ? 'Your open jobs could not be read right now.'
      : openLocks === 0
        ? 'You have no open jobs.'
        : `You still have ${openLocks} open ${openLocks === 1 ? 'job' : 'jobs'}. Deliver each one, or it counts against your record when its deadline passes.`;

  if (pending === undefined) {
    return (
      <Card title="Take stake out">
        <p className="text-sm text-[color:var(--color-muted)]">
          Could not read whether a withdrawal is pending. Read the desk again.
        </p>
      </Card>
    );
  }

  if (pending !== null) {
    return (
      <Card title="Withdrawal pending" description="The registry releases it when the waiting period ends.">
        <div className="space-y-4">
          <FieldGrid columns={3}>
            <Field label="Amount">
              <span className="tabular">{usd(pending.amount)}</span>
            </Field>
            <Field label="Requested">
              <Instant at={pending.requestedAt} />
            </Field>
            <Field label={pending.matured === true ? 'Ready since' : 'Ready'}>
              {pending.maturesAt === null ? (
                'Not read'
              ) : pending.matured === true ? (
                <Instant at={pending.maturesAt} />
              ) : (
                <Countdown to={pending.maturesAt} />
              )}
            </Field>
          </FieldGrid>

          <p className="text-sm">
            {caveat} A ruling during the waiting period can still take from this stake.
          </p>

          <div className="flex flex-wrap items-start gap-3">
            <TxButton
              label="Take it"
              disabled={executeGate.kind !== 'ready'}
              blockedBy={blockedBy}
              send={() =>
                writeContractAsync({
                  address: ADDRESSES.agentRegistry,
                  abi: agentRegistryAbi,
                  functionName: 'executeWithdrawal',
                })
              }
              onContinue={onDone}
            />
            <TxButton
              label="Cancel the request"
              tone="secondary"
              disabled={cancelGate.kind !== 'ready'}
              blockedBy={blockedBy}
              send={() =>
                writeContractAsync({
                  address: ADDRESSES.agentRegistry,
                  abi: agentRegistryAbi,
                  functionName: 'cancelWithdrawal',
                })
              }
              onContinue={onDone}
            />
          </div>

          <GateNote gate={executeGate} />

          <p className="text-detail text-[color:var(--color-muted)]">
            If what remains falls below {standing.minStake === undefined ? 'the minimum' : usd(standing.minStake)},
            taking it also stops you taking work. Cancelling resets the wait: a new request starts it again.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Take stake out"
      description={delay === undefined ? 'Request it now and take it after a waiting period.' : `Request it now and take it ${delay} later.`}
    >
      <form className="max-w-md space-y-4" onSubmit={preventNavigation}>
        <AmountInput
          label="Amount to take out"
          asset="USDG"
          value={text}
          onChange={(next, value) => {
            setText(next);
            setAtomic(value);
          }}
          max={standing.stake === undefined ? undefined : { atomic: standing.stake, label: 'All of it' }}
          hint={
            standing.active === false
              ? 'You are not taking work, so all of it can come out.'
              : standing.minStake === undefined
                ? 'While you take work, the minimum stake has to stay.'
                : `While you take work, ${usd(standing.minStake)} has to stay. Stop taking work to withdraw all of it.`
          }
        />

        <TxButton
          label="Ask to withdraw"
          type="submit"
          disabled={requestGate.kind !== 'ready'}
          blockedBy={blockedBy}
          send={() =>
            writeContractAsync({
              address: ADDRESSES.agentRegistry,
              abi: agentRegistryAbi,
              functionName: 'requestWithdrawal',
              args: [atomic ?? 0n],
            })
          }
          onConfirmed={() => {
            setText('');
            setAtomic(undefined);
          }}
          onContinue={onDone}
        />

        <GateNote gate={requestGate} />

        <p className="text-detail text-[color:var(--color-muted)]">{caveat}</p>
      </form>
    </Card>
  );
}

/** Whether payers can reach this address at all, which is one call in each direction. */
export function AvailabilityCard({ desk, blockedBy, onDone }: PanelProps) {
  const { writeContractAsync } = useWriteContract();
  const facts = factsOf(desk);
  const stop = deactivateGate(facts);
  const start = reactivateGate(facts);
  const active = desk.standing.active;

  return (
    <Card title="Taking work" description="Whether payers can open new jobs with you.">
      <div className="space-y-4">
        <p className="text-sm">
          {active === undefined
            ? 'Could not read whether you are taking work. Read the desk again.'
            : active
              ? 'Payers can open jobs with you. Stopping refuses new jobs right away, and open jobs still need delivering.'
              : 'You are not taking new jobs. Your stake stays posted, and a ruling can still take from it.'}
        </p>

        <div className="flex flex-wrap items-start gap-3">
          {active === false ? (
            <TxButton
              key="reactivate"
              label="Take work again"
              disabled={start.kind !== 'ready'}
              blockedBy={blockedBy}
              send={() =>
                writeContractAsync({
                  address: ADDRESSES.agentRegistry,
                  abi: agentRegistryAbi,
                  functionName: 'reactivate',
                })
              }
              onContinue={onDone}
            />
          ) : (
            <TxButton
              key="deactivate"
              label="Stop taking work"
              tone="secondary"
              disabled={stop.kind !== 'ready'}
              blockedBy={blockedBy}
              confirmPhrase="stop"
              confirmTitle="Stop taking work"
              confirmDescription="New jobs are refused as soon as this lands. Open jobs still need delivering."
              send={() =>
                writeContractAsync({
                  address: ADDRESSES.agentRegistry,
                  abi: agentRegistryAbi,
                  functionName: 'deactivate',
                })
              }
              onContinue={onDone}
            />
          )}
        </div>

        <GateNote gate={active === false ? start : stop} />
      </div>
    </Card>
  );
}

/** What the stake buys and what takes it, read from the registry rather than written into the page. */
function StakeTerms({ desk }: { readonly desk: ProviderDesk }) {
  const { standing } = desk;
  const delay = standing.withdrawalDelay === undefined ? undefined : formatSpan(Number(standing.withdrawalDelay));

  return (
    <FieldGrid columns={3}>
      <Field label="What it buys" hint={`Held by the registry at ${shortAddress(ADDRESSES.agentRegistry)}`}>
        Payers can open jobs with your address.
      </Field>
      <Field
        label="What it risks"
        hint={
          standing.slashBps === undefined
            ? 'The ruling limit could not be read.'
            : `Up to ${bps(standing.slashBps)} of the stake per ruling`
        }
      >
        A ruling against a job can take part of the stake. That part is not returned.
      </Field>
      <Field label="Getting it back" hint={delay === undefined ? undefined : `${delay} between asking and taking`}>
        Request a withdrawal, then take it after the waiting period.
      </Field>
    </FieldGrid>
  );
}

/**
 * Why a control is off.
 *
 * A dimmed button with nothing under it is the failure this app keeps closing: the reader is left
 * to guess between "I typed something wrong", "the chain says no" and "the page never read it".
 * Those are three different next moves and they belong to three different people.
 */
export function GateNote({ gate }: { readonly gate: Gate }): ReactNode {
  if (gate.kind === 'ready' || gate.kind === 'approve') return null;

  if (gate.kind === 'unread') {
    return (
      <p className="flex items-start gap-2 text-detail text-[color:var(--color-muted)]">
        <span className="pt-1">
          <LevelDot level="unknown" />
        </span>
        <span>
          Could not read {gate.missing}. Read the desk again.
        </span>
      </p>
    );
  }

  return (
    <p className="flex items-start gap-2 text-detail">
      <span className="pt-1">
        <LevelDot level="blocked" />
      </span>
      <span style={{ color: 'var(--color-state-blocked)' }}>{gate.reason}</span>
    </p>
  );
}
