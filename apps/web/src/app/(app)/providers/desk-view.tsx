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
import { ClaimOwedButton, owedExplanation } from '@/components/claim-owed';
import { ErrorSurface } from '@/components/error-surface';
import { Instant } from '@/components/instant';
import { Card, EmptyState, Field, FieldGrid, Section, Skeleton } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { Unread } from '@/components/status';
import { Table } from '@/components/table';
import type { Column } from '@/components/table';
import { spellDuration } from '@/lib';
import { bps, usd, usdExact } from '@/money';
import { useSystemState } from '@/state';
import type { AnyState } from '@/state';

import { RulingNote } from '../resolvers/ruling-note';
import { EvidenceForm } from './[payee]/evidence-form';
import type { ProviderDesk, ProviderLock } from './desk';
import { AddStakeCard, AvailabilityCard, RegisterCard, WithdrawalCard } from './onboarding';
import { RecordCard, TakePayment } from './record-card';
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
            ? 'For your connected wallet, the address the escrow pays.'
            : 'Public payments and record for this address. No wallet needed.'
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
                  Updated <Instant at={desk.readAt} relative />
                  {desk.blockNumber !== undefined && <> at block {desk.blockNumber.toString()}</>}.
                </>
              ) : (
                <Skeleton width={220} />
              )}
            </span>
          </div>
        </Card>
        <ErrorSurface error={error} action={owned ? 'Reading your payments' : 'Reading this desk'} onRetry={refresh} />
      </Section>

      {isLoading && !desk && (
        <Card>
          <Skeleton height={80} />
        </Card>
      )}

      {desk && !desk.complete && (
        <Unread onRetry={refresh}>
          Some payments could not be read right now, so the lists below may be incomplete.
        </Unread>
      )}

      {desk && (
        <>
          <DeskHeadline desk={desk} owned={owned} />

          {owned && <Onboarding desk={desk} blockedBy={writeBlockers} onDone={refresh} />}

          <Section
            title={owned ? 'Your record' : 'The record'}
            description="The score and the job ceiling it earns."
          >
            {owned ? (
              <RecordCard desk={desk} blockedBy={writeBlockers} onRecorded={refresh} />
            ) : (
              <UnrecordedNote desk={desk} />
            )}
            <ReputationPanel desk={desk} owned={owned} />
          </Section>

          <HeldForPayee desk={desk} owned={owned} blockedBy={writeBlockers} onClaimed={refresh} />
          <Work desk={desk} owned={owned} blockedBy={writeBlockers} onTaken={refresh} />
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
            : 'List this address to start taking jobs.'
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
      <Section title="Your listing" description="Whether payers can pay this address.">
        <Card>
          <p className="text-sm text-[color:var(--color-muted)]">
            Could not read whether this address is listed. Press Read again above.
          </p>
        </Card>
      </Section>
    );
  }

  return (
    <Section title="Your stake" description="The stake the registry holds for you.">
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
          hint={desk.complete ? openJobsHint(desk.working) : 'Not read'}
          level={desk.working.some((lock) => lock.stage === 'deadline-passed') ? 'blocked' : undefined}
        />
        <Stat
          label="Largest single job"
          value={desk.record.cap === undefined ? '—' : usd(desk.record.cap)}
          hint={`The largest job a payer can open with ${owned ? 'you' : 'this address'}`}
        />
        <Stat
          label="Paid, not yet recorded"
          value={unrecordedValue}
          hint={
            desk.complete
              ? `${desk.unrecorded.length} ${desk.unrecorded.length === 1 ? 'payment' : 'payments'} to record`
              : 'Not read'
          }
          level={desk.recordable.length > 0 ? 'attention' : undefined}
        />
        <Stat
          label="Stake posted"
          value={desk.standing.stake === undefined ? '—' : usd(desk.standing.stake)}
          hint={
            desk.standing.minStake === undefined
              ? 'What a ruling can take from'
              : `Minimum ${usd(desk.standing.minStake)}`
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

/**
 * A payout the escrow kept aside for this address.
 *
 * A settlement pays every party at once. When the token refuses the transfer to one of them,
 * usually because its issuer has frozen the address, the escrow books that leg as owed and pays the
 * rest, and it stays there until somebody claims it. The claim is open to anyone and
 * pays only the address it is owed to.
 */
export function HeldForPayee({
  desk,
  owned,
  blockedBy,
  onClaimed,
}: {
  readonly desk: ProviderDesk;
  readonly owned: boolean;
  readonly blockedBy: readonly AnyState[];
  readonly onClaimed: () => void;
}) {
  if (desk.owed === undefined || desk.owed === 0n) return null;

  return (
    <Section
      title={owned ? 'Held for you' : 'Held for this address'}
      description="A payout the escrow could not deliver when a payment settled."
    >
      <Card>
        <div className="space-y-4">
          <p className="max-w-3xl text-sm">
            The escrow is holding <span className="tabular font-medium">{usdExact(desk.owed)}</span> for{' '}
            {owned ? 'you' : 'this address'}. {owedExplanation(owned ? 'you' : 'this address')}
          </p>
          {owned && (
            <ClaimOwedButton escrow={ADDRESSES.escrow} party={desk.payee} label="Claim it" blockedBy={blockedBy} onClaimed={onClaimed} />
          )}
        </div>
      </Card>
    </Section>
  );
}

/** The public reading of the same gap the record card closes for the payee. */
function UnrecordedNote({ desk }: { readonly desk: ProviderDesk }) {
  if (desk.unrecorded.length === 0) return null;

  return (
    <Card title="Paid work not yet recorded">
      <p className="text-sm">
        {desk.unrecorded.length} paid {desk.unrecorded.length === 1 ? 'job has' : 'jobs have'} not been recorded yet, so
        the score below does not count {desk.unrecorded.length === 1 ? 'it' : 'them'}. Anyone can record a job once the
        payer&rsquo;s contest window closes.
      </p>
    </Card>
  );
}

function Work({
  desk,
  owned,
  blockedBy,
  onTaken,
}: {
  readonly desk: ProviderDesk;
  readonly owned: boolean;
  readonly blockedBy: readonly AnyState[];
  readonly onTaken: () => void;
}) {
  const columns = owned
    ? [
        ...lockColumns(desk, owned),
        {
          key: 'take',
          header: '',
          align: 'right' as const,
          cell: (lock: ProviderLock) => <TakePayment lock={lock} blockedBy={blockedBy} onTaken={onTaken} />,
        },
      ]
    : lockColumns(desk, owned);
  return (
    <Section
      title="Open jobs"
      description="Payments locked in escrow, waiting on delivery."
    >
      <Card>
        <Table
          caption="Open locks"
          rows={desk.working}
          rowKey={lockKey}
          columns={columns}
          empty={
            desk.complete ? (
              <EmptyState title="No open jobs right now.">
                A job appears here as soon as a payer locks a payment.
              </EmptyState>
            ) : (
              <EmptyState title="Open jobs could not be read.">Read the desk again.</EmptyState>
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
      title="Disputes"
      description="Jobs a payer contested, and where each ruling stands."
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
          ? 'Past jobs could not be read right now.'
          : desk.scanned.truncated
            ? `The latest ${(desk.scanned.to - desk.scanned.from + 1n).toString()} jobs, up to job ${desk.scanned.to.toString()}.`
            : owned
              ? 'Every job you have taken.'
              : 'Every job this address has taken.'
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
              <EmptyState title="No settled jobs yet.">A job moves here once it settles.</EmptyState>
            ) : (
              <EmptyState title="Past jobs could not be read.">Read the desk again.</EmptyState>
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
      description="All three must hold for a payment to land."
    >
      <Card>
        <div className="space-y-4">
          <FieldGrid columns={3}>
            <Field label="Listed" hint={standing.registeredAt ? <>Since <Instant at={standing.registeredAt} /></> : undefined}>
              <Condition
                level={standing.registered === undefined ? 'unknown' : standing.registered ? 'ok' : 'blocked'}
                text={
                  standing.registered === undefined
                    ? 'Could not read the registry.'
                    : standing.registered
                      ? standing.name
                        ? `Listed as ${standing.name}.`
                        : 'Listed.'
                      : 'Not listed. Payers cannot pay an unlisted address.'
                }
              />
            </Field>

            <Field
              label="Taking work"
              hint={
                standing.stake === undefined
                  ? undefined
                  : `Stake ${usd(standing.stake)}${standing.minStake === undefined ? '' : `, minimum ${usd(standing.minStake)}`}`
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
                    ? 'Barred by the registry. Payers cannot pay this address.'
                    : standing.active === undefined
                      ? 'Could not read the registry.'
                      : standing.active
                        ? short
                          ? `Taking work, but the stake is below the minimum.${owned ? ' Top it up to keep taking jobs.' : ''}`
                          : 'Taking work.'
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
                    ? 'USDG is paused by its issuer. No payment settles until it resumes.'
                    : desk.blocked
                      ? 'The USDG issuer has blocked this address, so payouts to it fail.'
                      : desk.blocked === undefined
                        ? 'Could not read the USDG blocklist.'
                        : desk.tokenPaused === undefined
                          ? 'Could not read whether USDG is paused.'
                          : 'Payouts can land here.'
                }
              />
            </Field>
          </FieldGrid>

          <p className="text-detail text-[color:var(--color-muted)]">
            The registry holds {whose === 'you' ? 'your' : 'this'} stake in USDG at {shortAddress(ADDRESSES.agentRegistry)}.
            It comes back through a withdrawal after a waiting period.
            {standing.slashBps !== undefined &&
              ` One ruling can take up to ${bps(standing.slashBps)} of it${standing.maxSlash === undefined ? '' : `, ${usd(standing.maxSlash)} at today's stake`}.`}
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
    <Section title="What a settlement costs" description={`From the escrow at ${shortAddress(ADDRESSES.escrow)} on ${RHC.name}.`}>
      <Card>
        <FieldGrid columns={3}>
          <Field
            label="Settlement fee"
            hint={examplePayout === undefined ? undefined : `A ${usd(EXAMPLE_JOB)} job pays the payee ${usd(examplePayout)}.`}
          >
            {terms.feeBps === undefined ? 'Reading' : `${bps(terms.feeBps)}, paid by the payee`}
          </Field>
          <Field label="Delivery window" hint="The deadlines a payer can choose from.">
            {ttlRange(terms) ?? 'Reading'}
          </Field>
          <Field label="Time to contest" hint="After payment, before the job can be recorded.">
            {terms.disputeWindow === undefined ? 'Reading' : spellDuration(Number(terms.disputeWindow))}
          </Field>
          <Field
            label="Cost of contesting"
            hint="A bond from whoever contests, returned if the ruling goes their way."
          >
            {terms.disputeBondBps === undefined ? 'Reading' : `${bps(terms.disputeBondBps)} of the locked amount`}
          </Field>
          <Field
            label="If the vote falls short"
            hint="Anyone can close a vote once its reveal window ends."
          >
            The payment goes back on hold with a new deadline, and the bond is returned
          </Field>
          {terms.minLock !== undefined && (
            <Field label="Smallest payment" hint="The escrow refuses payments below this.">
              <span className="tabular">{usdExact(terms.minLock)}</span>
            </Field>
          )}
          <Field label="Transaction fees" hint="Paid in ETH by the wallet that signs, never from the payout.">
            Paid by the payee for each release and record it sends
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
  if (desk.earlier.length === 0) return '';
  return desk.earlier.every((entry) => entry.complete)
    ? ' Jobs on earlier contracts are included and marked.'
    : ' Jobs on earlier contracts are included and marked where they could be read.';
}

/** How many jobs are open, and how many of those a payer can already take back. */
function openJobsHint(working: readonly ProviderLock[]): string {
  const jobs = `${working.length} open ${working.length === 1 ? 'job' : 'jobs'}`;
  const late = working.filter((lock) => lock.stage === 'deadline-passed').length;
  return late === 0 ? jobs : `${jobs}, ${late === working.length ? (late === 1 ? 'past its' : 'all past their') : `${late} past their`} deadline`;
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
            {stageDetail(lock, desk.chainTime, owned ? 'payee' : 'public')}
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
        <div className="text-note text-[color:var(--color-muted)]">payout</div>
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
    payout.kind === 'paid' ? 'received' : payout.kind === 'expected' ? 'if released' : 'held until the ruling';

  return (
    <div className="space-y-0.5">
      {/* Exact, because these are payouts and two decimal places round a cent job to nothing. */}
      <div className="tabular text-sm">{usdExact(payout.amount)}</div>
      <div className="text-note text-[color:var(--color-muted)]">{note}</div>
      <div className="tabular text-note text-[color:var(--color-muted)]">{usdExact(payout.fee)} fee</div>
    </div>
  );
}
