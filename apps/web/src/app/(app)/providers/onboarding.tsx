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
import { formatDuration } from '@/lib';
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
      description="A payer cannot open a lock against an address the registry does not list. This is that listing."
    >
      <form className="space-y-4" onSubmit={preventNavigation}>
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
              placeholder="acme_transcribe"
              aria-invalid={nameProblem(name) !== undefined}
              onChange={(event) => setName(event.target.value)}
              className="h-11 w-full border bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
              style={{ borderColor: nameProblem(name) ? 'var(--color-state-blocked)' : 'var(--color-line)' }}
            />
            <p className="text-note" style={{ color: nameProblem(name) ? 'var(--color-state-blocked)' : 'var(--color-muted)' }}>
              {nameProblem(name) ??
                'A display name. It is not unique and nothing in the protocol resolves it, so the address stays the identity.'}
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
                ? 'The registry did not answer its minimum.'
                : `At least ${usd(floor)}. More stake does not raise the ceiling on a job; it is what a ruling is taken from.`
            }
          />
        </FieldGrid>

        <StakeTerms desk={desk} />

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

        <p className="text-detail text-[color:var(--color-muted)]">
          Two transactions. The first lets the registry at {floor === undefined ? 'the stake' : usd(floor)} of USDG from
          this wallet; the second joins the registry and moves it. Transaction fees are paid in ETH from the wallet that
          signs, and the stake is paid in USDG.
          {ruling !== undefined && ` A single ruling can take up to ${bps(ruling)} of the stake.`}
        </p>
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
    <Card title="Add to the stake" description="Deeper collateral is what a principal reads before allowlisting an address.">
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
          hint="Added to the collateral a ruling is taken from. It does not raise the ceiling on a single job; only the score does that."
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
            A withdrawal of {usd(pending.amount)} is waiting. Adding stake cancels it, and the wait starts again from
            zero if it is asked for a second time.
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
  const delay = standing.withdrawalDelay === undefined ? undefined : formatDuration(Number(standing.withdrawalDelay));

  const requestGate = withdrawalRequestGate(facts, atomic);
  const executeGate = withdrawalExecuteGate(facts);
  const cancelGate = withdrawalCancelGate(facts);

  const openLocks = desk.complete ? desk.working.length : undefined;
  const caveat =
    openLocks === undefined
      ? 'Whether anything is locked against you could not be read, so what a request would leave outstanding is unknown.'
      : openLocks === 0
        ? 'Nothing is locked against you right now, so a request leaves no work outstanding.'
        : `Asking does not settle the ${openLocks} ${openLocks === 1 ? 'job' : 'jobs'} already locked against you. Each one still has to be delivered, or it runs to its deadline and counts against your record.`;

  if (pending === undefined) {
    return (
      <Card title="Take stake out">
        <p className="text-sm text-[color:var(--color-muted)]">
          The registry did not answer whether a withdrawal is waiting, so neither step is offered. Nothing has changed on
          chain; only the reading failed.
        </p>
      </Card>
    );
  }

  if (pending !== null) {
    return (
      <Card title="Stake on its way out" description="One request at a time. The registry holds it until the wait runs down.">
        <div className="space-y-4">
          <FieldGrid columns={3}>
            <Field label="Amount">
              <span className="tabular">{usd(pending.amount)}</span>
            </Field>
            <Field label="Asked for">
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
            {caveat} The stake stays slashable until it leaves, so a ruling made inside the wait still reaches it.
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
            Taking it while you are still listed and the remainder falls under{' '}
            {standing.minStake === undefined ? 'the minimum' : usd(standing.minStake)} stops you taking work in the
            same transaction. Cancelling costs the wait: a second request starts the{' '}
            {delay ?? 'full'} clock again.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Take stake out"
      description={delay === undefined ? 'Asked for first, taken later.' : `Asked for first, taken ${delay} later.`}
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
            standing.minStake === undefined
              ? 'A listed address has to leave the registry minimum behind.'
              : `A listed address has to leave ${usd(standing.minStake)} behind. Stop taking work first to withdraw the whole stake.`
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
    <Card title="Taking work" description="Whether the escrow will accept a new lock naming your address.">
      <div className="space-y-4">
        <p className="text-sm">
          {active === undefined
            ? 'The registry did not answer whether you are taking work, so neither control is offered.'
            : active
              ? 'Payers can open locks against you now. Stopping refuses new ones from the next block. Locks already open are unaffected: each still has to be delivered, or it runs to its deadline and counts against your record.'
              : 'The registry is refusing new locks against you. Your stake stays posted and stays slashable while you are stopped, so this is a pause on new work and not an exit.'}
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
              confirmDescription="New locks naming your address are refused from the moment this lands. Work already locked still has to be delivered."
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
  const delay = standing.withdrawalDelay === undefined ? undefined : formatDuration(Number(standing.withdrawalDelay));

  return (
    <FieldGrid columns={3}>
      <Field label="What it buys" hint={`Held by the registry at ${shortAddress(ADDRESSES.agentRegistry)}`}>
        The escrow will accept a lock naming your address. Without a listing it refuses every one.
      </Field>
      <Field
        label="What it risks"
        hint={
          standing.slashBps === undefined
            ? 'The registry did not answer the ceiling on a ruling.'
            : `Up to ${bps(standing.slashBps)} of the stake per ruling`
        }
      >
        A resolver ruling against a job can take part of the stake. What it takes leaves the registry and does not
        come back.
      </Field>
      <Field label="Getting it back" hint={delay === undefined ? undefined : `${delay} between asking and taking`}>
        Through a request that matures on a delay, so a stake cannot leave between a bad job and the ruling on it.
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
          Held back because {gate.missing} could not be read. Nothing has changed on chain; only the reading failed.
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
