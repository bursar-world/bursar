'use client';

import { micro, mulBps, subMicro } from '@bursar/core';
import { LockStatus } from '@bursar/sdk';
import type { Micro } from '@bursar/core';
import { useState } from 'react';
import type { Address } from 'viem';

import { ADDRESSES, RHC, deploymentLabel, shortAddress } from '@/chain';
import { Address as AddressView } from '@/components/address';
import { LevelDot } from '@/components/badge';
import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { Instant } from '@/components/instant';
import { Card, EmptyState, Field, FieldGrid, Section, Skeleton } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { Unread } from '@/components/status';
import { Table } from '@/components/table';
import type { Column } from '@/components/table';
import { formatDuration } from '@/lib';
import { bps, usd, usdExact } from '@/money';
import { useSystemState } from '@/state';
import type { AnyState } from '@/state';

import { RulingNote } from '../resolvers/ruling-note';
import { EvidenceForm } from './[payee]/evidence-form';
import type { ProviderDesk, ProviderLock } from './desk';
import { AddStakeCard, AvailabilityCard, RegisterCard, WithdrawalCard } from './onboarding';
import { RecordCard } from './record-card';
import { ReputationPanel } from './reputation';
import { stageDetail, stageLabel, stageLevel, ttlRange } from './stages';
import { useProviderDesk } from './use-desk';

/**
 * The desk for one payee address.
 *
 * Everything on it is public: the escrow indexes its locks by id, the registry publishes every
 * listing and the reputation contract publishes the record and the curve. So the address comes in
 * as a parameter and a wallet is only ever asked for to sign something. A connected wallet adds
 * controls. It never adds a reading.
 */
export function DeskView({ payee, owned }: { readonly payee: Address; readonly owned: boolean }) {
  const { desk, isLoading, isFetching, error, refresh } = useProviderDesk(payee);

  // Connectivity, the asset and the fee float decide whether a write can be sent at all. Reading
  // them here is what lets a control name whichever one is in the way. A dimmed button says nothing.
  const system = useSystemState();
  const writeBlockers = [system.connectivity, system.asset, system.funding];

  return (
    <div className="space-y-10">
      <Section
        title={owned ? 'Getting paid' : 'Payee desk'}
        description={
          owned
            ? 'Read against the connected wallet, which is the address the escrow pays.'
            : 'Read from the chain against this one address. No wallet is involved and nothing here is signed.'
        }
        actions={
          <Button size="sm" onClick={refresh} disabled={isFetching}>
            {isFetching ? 'Reading' : 'Read again'}
          </Button>
        }
      >
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <AddressView value={payee} label={desk?.standing.name} />
            <span className="text-note text-[color:var(--color-muted)]">
              {desk ? (
                <>
                  Read <Instant at={desk.readAt} relative />
                  {desk.blockNumber !== undefined && <> at block {desk.blockNumber.toString()}</>}, in {desk.requests}{' '}
                  {desk.requests === 1 ? 'request' : 'requests'}.
                </>
              ) : (
                <Skeleton width={220} />
              )}
            </span>
          </div>
        </Card>
        <ErrorSurface error={error} action={owned ? 'read your payments' : 'read this desk'} onRetry={refresh} />
      </Section>

      {isLoading && !desk && (
        <Card>
          <Skeleton height={80} />
        </Card>
      )}

      {desk && !desk.complete && (
        <Unread onRetry={refresh}>
          The escrow did not answer this reading. Anything showing as empty below is unknown, not clear. Nothing has
          changed on chain; only the reading failed.
        </Unread>
      )}

      {desk && (
        <>
          <DeskHeadline desk={desk} owned={owned} />

          {owned && <Onboarding desk={desk} blockedBy={writeBlockers} onDone={refresh} />}

          <Section
            title={owned ? 'Your record' : 'The record'}
            description="What settled work has earned, and what is still outside the count."
          >
            {owned ? (
              <RecordCard desk={desk} blockedBy={writeBlockers} onRecorded={refresh} />
            ) : (
              <UnrecordedNote desk={desk} />
            )}
            <ReputationPanel desk={desk} owned={owned} />
          </Section>

          <Work desk={desk} owned={owned} />
          <Disputes desk={desk} owned={owned} />
          <Settled desk={desk} owned={owned} />
          <DeskStanding desk={desk} owned={owned} />
          <Terms desk={desk} />
        </>
      )}
    </div>
  );
}

/** Registration when the address is not listed, and the staking lifecycle once it is. */
function Onboarding({
  desk,
  blockedBy,
  onDone,
}: {
  readonly desk: ProviderDesk;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
}) {
  const { registered } = desk.standing;

  // A registration that landed and has not been moved past. The desk reads itself again every
  // twenty seconds on its own, so without this the join panel is replaced by the stake screen
  // before the button that was pressed has painted anything.
  const [joined, setJoined] = useState(false);

  if (joined || registered === false) {
    return (
      <Section
        title={joined ? 'Your listing' : 'Become payable'}
        description={
          joined
            ? 'The registry holds your stake. Your desk opens when you continue.'
            : 'The escrow gates every lock on the payee being listed and taking work. Neither is true of this address yet.'
        }
      >
        <RegisterCard
          desk={desk}
          blockedBy={blockedBy}
          onRegistered={() => setJoined(true)}
          onDone={() => {
            setJoined(false);
            onDone();
          }}
        />
      </Section>
    );
  }

  if (registered === undefined) {
    return (
      <Section title="Your listing" description="Whether the escrow will accept a payment to this address.">
        <Card>
          <p className="text-sm text-[color:var(--color-muted)]">
            The registry did not answer whether this address is listed, so no control is offered. Nothing has changed on
            chain; only the reading failed. Press Read again above.
          </p>
        </Card>
      </Section>
    );
  }

  return (
    <Section title="Your stake" description="Collateral the registry holds, and the two ways it moves.">
      <AvailabilityCard desk={desk} blockedBy={blockedBy} onDone={onDone} />
      <AddStakeCard desk={desk} blockedBy={blockedBy} onDone={onDone} />
      <WithdrawalCard desk={desk} blockedBy={blockedBy} onDone={onDone} />
    </Section>
  );
}

export function DeskHeadline({ desk, owned }: { readonly desk: ProviderDesk; readonly owned: boolean }) {
  const owedToYou = desk.complete ? usd(totalNet(desk.working)) : '—';
  const unrecordedValue = desk.complete ? usd(totalNet(desk.unrecorded)) : '—';

  return (
    <Card>
      <StatGrid columns={4}>
        <Stat
          label={owned ? 'Waiting on your delivery' : 'Waiting on delivery'}
          value={owedToYou}
          hint={
            desk.complete
              ? `${desk.working.length} ${desk.working.length === 1 ? 'job' : 'jobs'} held against a deadline`
              : 'Not read'
          }
          level={desk.working.some((lock) => lock.stage === 'deadline-passed') ? 'blocked' : undefined}
        />
        <Stat
          label="Largest single job"
          value={desk.record.cap === undefined ? '—' : usd(desk.record.cap)}
          hint={`A payer cannot lock more than this against ${owned ? 'you' : 'this address'}`}
        />
        <Stat
          label="Paid, not yet recorded"
          value={unrecordedValue}
          hint={
            desk.complete
              ? `${desk.unrecorded.length} ${desk.unrecorded.length === 1 ? 'payment' : 'payments'} outside the record`
              : 'Not read'
          }
          level={desk.recordable.length > 0 ? 'attention' : undefined}
        />
        <Stat
          label="Stake posted"
          value={desk.standing.stake === undefined ? '—' : usd(desk.standing.stake)}
          hint={
            desk.standing.minStake === undefined
              ? 'Collateral a ruling is taken from'
              : `Against a ${usd(desk.standing.minStake)} minimum`
          }
          level={
            desk.standing.stake !== undefined && desk.standing.minStake !== undefined && desk.standing.stake < desk.standing.minStake
              ? 'attention'
              : undefined
          }
        />
      </StatGrid>
    </Card>
  );
}

/** The public reading of the same gap the record card closes for the payee. */
function UnrecordedNote({ desk }: { readonly desk: ProviderDesk }) {
  if (desk.unrecorded.length === 0) return null;

  return (
    <Card title="Paid work outside the record">
      <p className="text-sm">
        {desk.unrecorded.length} {desk.unrecorded.length === 1 ? 'payment has' : 'payments have'} settled without being
        written into the count the ceiling is built from. The escrow takes that second call from anyone once the payer&rsquo;s
        time to contest has run out, and nobody is obliged to make it, so the score below can sit lower than the work
        behind it.
      </p>
    </Card>
  );
}

function Work({ desk, owned }: { readonly desk: ProviderDesk; readonly owned: boolean }) {
  return (
    <Section
      title={owned ? 'Work held against you' : 'Work held against this address'}
      description="Money a payer has locked, waiting on delivery."
    >
      <Card>
        <Table
          caption="Open locks"
          rows={desk.working}
          rowKey={lockKey}
          columns={lockColumns(desk, owned)}
          empty={
            desk.complete ? (
              <EmptyState title={`Nothing is locked against ${owned ? 'you' : 'this address'} right now.`}>
                A payer opens a lock when an agent buys from a provider. It appears here the moment it lands.
              </EmptyState>
            ) : (
              <EmptyState title="This list was not read.">
                The escrow did not answer, so whether anything is locked is unknown.
              </EmptyState>
            )
          }
        />
      </Card>
    </Section>
  );
}

/** Open disputes and the ones already settled, which is the history a payer weighs. */
function Disputes({ desk, owned }: { readonly desk: ProviderDesk; readonly owned: boolean }) {
  const closed = desk.settled.filter(
    (lock) => lock.stage === 'ruled' || lock.stage === 'dispute-closed' || lock.stage === 'dispute-unread',
  );
  const rows = [...desk.contested, ...closed];
  if (rows.length === 0) return null;

  // Only a lock frozen before release has a ruling to reach. One contested after it was paid is a
  // mark on the record and nothing more, so it gets no form.
  const awaitingEvidence = owned ? desk.contested.filter((lock) => lock.status === LockStatus.Disputed && lock.releasedAt === null) : [];

  return (
    <Section
      title={owned ? 'Disputes against you' : 'Disputes against this address'}
      description="A payer challenged these. Each states where the ruling stands and, once the resolvers have revealed, why."
    >
      <div className="space-y-6">
        <Card>
          <Table caption="Disputed locks" rows={rows} rowKey={lockKey} columns={lockColumns(desk, owned, true)} />
        </Card>
        {awaitingEvidence.map((lock) => (
          <EvidenceForm key={lockKey(lock)} lock={lock} />
        ))}
      </div>
    </Section>
  );
}

function Settled({ desk, owned }: { readonly desk: ProviderDesk; readonly owned: boolean }) {
  return (
    <Section
      title="Settled"
      description={`${
        !desk.complete
          ? 'The escrow did not answer how many jobs it holds.'
          : desk.scanned.truncated
            ? `The most recent ${(desk.scanned.to - desk.scanned.from + 1n).toString()} jobs on the escrow, ending at job ${desk.scanned.to.toString()}.`
            : `Everything the escrow has recorded against ${owned ? 'your address' : 'this address'}.`
      }${earlierNote(desk)}`}
    >
      <Card>
        <Table
          caption="Settled locks"
          rows={desk.settled}
          rowKey={lockKey}
          columns={lockColumns(desk, owned)}
          empty={
            desk.complete ? (
              <EmptyState title="No settled jobs yet.">A job lands here once it reaches an outcome.</EmptyState>
            ) : (
              <EmptyState title="This list was not read.">The escrow did not answer, so past jobs are unknown.</EmptyState>
            )
          }
        />
      </Card>
    </Section>
  );
}

export function DeskStanding({ desk, owned }: { readonly desk: ProviderDesk; readonly owned: boolean }) {
  const { standing } = desk;
  const short = standing.minStake !== undefined && standing.stake !== undefined && standing.stake < standing.minStake;
  const whose = owned ? 'you' : 'this address';

  return (
    <Section
      title={owned ? 'Whether a payer can reach you' : 'Whether a payer can reach this address'}
      description="Three separate conditions. Each one refuses a payment on its own."
    >
      <Card>
        <div className="space-y-4">
          <FieldGrid columns={3}>
            <Field label="Listed" hint={standing.registeredAt ? <>Since <Instant at={standing.registeredAt} /></> : undefined}>
              <Condition
                level={standing.registered === undefined ? 'unknown' : standing.registered ? 'ok' : 'blocked'}
                text={
                  standing.registered === undefined
                    ? 'The registry did not answer.'
                    : standing.registered
                      ? standing.name
                        ? `Listed as ${standing.name}.`
                        : 'Listed.'
                      : 'Not listed. The escrow refuses a lock naming an unlisted payee.'
                }
              />
            </Field>

            <Field
              label="Taking work"
              hint={
                standing.stake === undefined
                  ? undefined
                  : `Stake ${usd(standing.stake)}${standing.minStake === undefined ? '' : ` against a ${usd(standing.minStake)} minimum`}`
              }
            >
              <Condition
                level={
                  standing.barred
                    ? 'blocked'
                    : standing.active === undefined
                      ? 'unknown'
                      : standing.active
                        ? short
                          ? 'attention'
                          : 'ok'
                        : 'blocked'
                }
                text={
                  standing.barred
                    ? 'Barred by the registry. No payer can open a lock naming this address.'
                    : standing.active === undefined
                      ? 'The registry did not answer.'
                      : standing.active
                        ? short
                          ? `Taking work, and the stake sits under the minimum. ${owned ? 'Top it up before the registry stops accepting locks.' : 'The registry stops accepting locks once it falls short.'}`
                          : 'Taking work, and payers can open locks against it.'
                        : owned
                          ? 'Stopped. Take work again from the stake panel above.'
                          : 'Stopped. Only this address can start it again.'
                }
              />
            </Field>

            <Field label="Able to receive USDG" hint={<>Checked against {shortAddress(desk.payee)}</>}>
              <Condition
                // Two reads, and both have to land before this can say ok. A pause that did not
                // answer is not a pause that is off: reporting "not blocked" on half the evidence
                // is the one way this field can be wrong in the direction that costs a provider a
                // payout.
                level={
                  desk.tokenPaused || desk.blocked
                    ? 'blocked'
                    : desk.tokenPaused === undefined || desk.blocked === undefined
                      ? 'unknown'
                      : 'ok'
                }
                // The last branch is the one both readings landed clear on. It used to fall through
                // to the pause sentence, so a fully read, fully clear address showed a green dot
                // beside the word unknown.
                text={
                  desk.tokenPaused
                    ? 'USDG is paused by its issuer. Nothing settles while it stays that way.'
                    : desk.blocked
                      ? 'The asset issuer has blocked this address. A payout to it reverts on the token, whatever the escrow decides.'
                      : desk.blocked === undefined
                        ? 'The blocklist did not answer, so this one is unknown.'
                        : desk.tokenPaused === undefined
                          ? 'The pause did not answer, so this one is unknown.'
                          : 'Not blocked, and USDG is not paused. A payout can land here.'
                }
              />
            </Field>
          </FieldGrid>

          <p className="text-detail text-[color:var(--color-muted)]">
            The stake is what a ruling against {whose} is taken from. It is held in USDG by the registry at{' '}
            {shortAddress(ADDRESSES.agentRegistry)} and returned through a withdrawal that matures on a delay.
            {standing.slashBps !== undefined &&
              ` A single ruling can take up to ${bps(standing.slashBps)} of it${standing.maxSlash === undefined ? '' : `, which is ${usd(standing.maxSlash)} at the stake posted now`}.`}
          </p>
        </div>
      </Card>
    </Section>
  );
}

/** One hundred USDG, as the worked example the fee is easiest to read against. */
const EXAMPLE_JOB: Micro = micro(100_000_000n);

function Terms({ desk }: { readonly desk: ProviderDesk }) {
  const { terms } = desk;
  const examplePayout = terms.feeBps === undefined ? undefined : subMicro(EXAMPLE_JOB, mulBps(EXAMPLE_JOB, terms.feeBps));

  return (
    <Section title="What a settlement costs" description={`Read from the escrow at ${shortAddress(ADDRESSES.escrow)} on ${RHC.name}.`}>
      <Card>
        <FieldGrid columns={3}>
          <Field
            label="Settlement fee"
            hint={examplePayout === undefined ? undefined : `A ${usd(EXAMPLE_JOB)} job pays the payee ${usd(examplePayout)}.`}
          >
            {terms.feeBps === undefined ? 'Reading' : `${bps(terms.feeBps)}, charged on the payee's side`}
          </Field>
          <Field label="Delivery window" hint="The range a payer may choose from when opening a lock.">
            {ttlRange(terms) ?? 'Reading'}
          </Field>
          <Field label="Time to contest" hint="After a payment, before the job joins the record.">
            {terms.disputeWindow === undefined ? 'Reading' : formatDuration(Number(terms.disputeWindow))}
          </Field>
          <Field
            label="Cost of contesting"
            hint="Posted as a bond by whoever opens a dispute, returned only if the ruling goes their way."
          >
            {terms.disputeBondBps === undefined ? 'Reading' : `${bps(terms.disputeBondBps)} of the locked amount`}
          </Field>
          <Field label="If a ruling never lands" hint="Anyone can make that call, so the money is never stranded.">
            {terms.disputeTimeoutPeriod === undefined
              ? 'Reading'
              : `The lock returns to the payer after ${formatDuration(Number(terms.disputeTimeoutPeriod))}`}
          </Field>
          <Field label="Transaction fees" hint="Paid in ETH out of the wallet that signs, never out of the payout.">
            Paid by the payee on every transaction it sends, a release and a record included
          </Field>
        </FieldGrid>
      </Card>
    </Section>
  );
}

function Condition({ level, text }: { readonly level: 'ok' | 'attention' | 'blocked' | 'unknown'; readonly text: string }) {
  return (
    <span className="flex items-start gap-2">
      <span className="pt-1">
        <LevelDot level={level} />
      </span>
      <span className="text-detail">{text}</span>
    </span>
  );
}

function earlierNote(desk: ProviderDesk): string {
  return desk.earlier
    .map((entry) =>
      entry.complete
        ? ` Jobs on the earlier ${entry.deployment.contractSet} escrow are included and marked.`
        : ` The earlier ${entry.deployment.contractSet} escrow did not answer.`,
    )
    .join('');
}

/** Lock ids restart with every escrow, so a row is named by both. */
function lockKey(lock: ProviderLock): string {
  return `${lock.deployment.name}:${lock.id.toString()}`;
}

function totalNet(locks: readonly ProviderLock[]): Micro {
  return micro(locks.reduce((total, lock) => total + lock.net, 0n));
}

function lockColumns(desk: ProviderDesk, owned: boolean, withRuling = false): readonly Column<ProviderLock>[] {
  return [
    {
      key: 'job',
      header: 'Job',
      cell: (lock) => (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <LevelDot level={stageLevel(lock.stage)} label={stageLabel(lock.stage)} />
            {lock.id.toString()}
            <span className="font-normal text-[color:var(--color-muted)]">{stageLabel(lock.stage)}</span>
            {!lock.deployment.current && (
              <span className="font-normal text-note text-[color:var(--color-muted)]">{deploymentLabel(lock.deployment)}</span>
            )}
          </div>
          <p className="max-w-prose text-detail text-[color:var(--color-muted)]">
            {stageDetail(lock, desk.terms, desk.chainTime, owned ? 'payee' : 'public')}
          </p>
          {withRuling && lock.dispute !== undefined && lock.releasedAt === null && (
            <div className="pt-2">
              <RulingNote disputeId={lock.dispute.id} registry={lock.deployment.current ? undefined : lock.deployment.oracleRegistry} />
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'payer',
      header: 'Payer',
      secondary: true,
      cell: (lock) => <AddressView value={lock.payer} copy={false} />,
    },
    {
      key: 'amount',
      header: owned ? 'To you' : 'To the payee',
      align: 'right',
      cell: (lock) => <Payout lock={lock} owned={owned} />,
    },
  ];
}

/**
 * What the escrow moved, not what the job was worth.
 *
 * This column used to print the lock's amount less the settlement fee on every row, so five locks
 * returned to the payer and one refunded by a dispute all claimed a payout under a heading that
 * says received. A provider adding the column up was out by a factor of four. Each answer now says
 * which of the five things it is.
 */
function Payout({ lock, owned }: { readonly lock: ProviderLock; readonly owned: boolean }) {
  const payout = lock.payout;
  const whose = owned ? 'you' : 'the payee';

  if (payout.kind === 'unread') {
    return (
      <div className="space-y-0.5">
        <div className="tabular text-sm text-[color:var(--color-muted)]">Not read</div>
        <div className="text-note text-[color:var(--color-muted)]">what the escrow moved</div>
      </div>
    );
  }

  if (payout.kind === 'none') {
    return (
      <div className="space-y-0.5">
        <div className="tabular text-sm">{usd(0n as Micro)}</div>
        <div className="text-note text-[color:var(--color-muted)]">nothing reached {whose}</div>
      </div>
    );
  }

  const note =
    payout.kind === 'paid' ? 'received' : payout.kind === 'expected' ? 'if released' : 'held, the ruling decides';

  return (
    <div className="space-y-0.5">
      {/* Exact, because these are payouts and two decimal places round a cent job to nothing. */}
      <div className="tabular text-sm">{usdExact(payout.amount)}</div>
      <div className="text-note text-[color:var(--color-muted)]">{note}</div>
      <div className="tabular text-note text-[color:var(--color-muted)]">{usdExact(payout.fee)} fee</div>
    </div>
  );
}
