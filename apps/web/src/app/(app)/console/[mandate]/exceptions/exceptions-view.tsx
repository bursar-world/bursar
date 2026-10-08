'use client';

import { isTotalBudgetWindow, mulBps } from '@bursar/core';
import type { ContractSet } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { LockStatus, isSealedURI } from '@bursar/sdk';
import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';

import { escrowAbi, mandateAccountAbi, oracleRegistryAbi } from '@/chain/abi';
import { rhcClient } from '@/chain/client';
import { readableDeployments } from '@/chain/deployments';
import { ADDRESSES, shortAddress } from '@/chain/rhc';
import { Address as AddressView, TxHash } from '@/components/address';
import { LevelDot, levelWord } from '@/components/badge';
import { Card, EmptyState, Section } from '@/components/layout';
import { Countdown, Instant } from '@/components/instant';
import { ErrorSurface } from '@/components/error-surface';
import { Table } from '@/components/table';
import { TxButton } from '@/components/tx-button';
import { usd, usdExact } from '@/money';
import type { AnyState, StateKey } from '@/state';
import { useCapabilityLabels } from '../../lib/capability-labels';
import { OVERDUE_DETAIL, OVERDUE_WORD, contestable, lockDetail, lockWord, returnable } from '../../lib/format';
import { useRefusals } from '../../lib/use-ledger';
import type { Refusal } from '../../lib/use-ledger';
import { refusalOf, weaker } from '../../lib/reading';
import { transferGates } from '../../lib/write-gates';
import { useMandateScope } from '../mandate-scope';
import { useWriteContract } from '@/wallet/write';
import { ShareWithResolver } from '../../lib/share-with-resolver';
import { RulingNote } from '../../../resolvers/ruling-note';

/**
 * Everything that did not go through, with the reason attached.
 *
 * A refusal that says only "declined" sends a treasurer looking in the wrong place, so every one
 * here names which of the five conditions caused it, and says so explicitly when the answer is
 * none of them. A delivery that never arrived is the second kind of exception and has a different
 * owner: the provider, not the mandate.
 */
export function ExceptionsView() {
  const { address, account, system, ledger, isOwner, writeContext, refresh } = useMandateScope();
  const { labelFor } = useCapabilityLabels();
  const { writeContractAsync } = useWriteContract();
  // Only a v1 total budget comes back as MonthlyCapExceeded. A native total has its own error.
  const feed = useRefusals(address, {
    totalBudget: account !== undefined && account.contractSet === 'v1' && isTotalBudgetWindow(account.monthly.duration),
  });

  const disputeWindow = system.snapshot?.escrow.disputeWindow;
  const bondBps = system.snapshot?.escrow.disputeBondBps;
  // Taken off the payment before any refund is worked out, and taken whether or not the panel
  // ever rules. A payer who reads "contesting costs a bond" and nothing else is being quoted
  // half the price.
  const resolverFeeBps = system.snapshot?.escrow.resolverFeeBps;

  const locks = [...ledger.locks.values()].filter((lock) => lock.payer.toLowerCase() === address.toLowerCase());
  // A payment the escrow is still holding past its deadline belongs in this list. It is the one
  // entry here that is waiting on the payer rather than on somebody else, and the control that
  // ends it is beside it.
  const chainTime = ledger.chainTime;
  const overdue = locks.filter((lock) => returnable(lock, chainTime));
  const incomplete = locks
    .filter(
      (lock) =>
        lock.status === LockStatus.TimedOut ||
        lock.status === LockStatus.Cancelled ||
        lock.status === LockStatus.Disputed ||
        lock.status === LockStatus.Resolved ||
        returnable(lock, chainTime),
    )
    .sort((a, b) => Number(b.id - a.id));

  // The escrow's clock is what decides a deadline, so a clock that did not come back is its own
  // answer. Nothing is offered on it, and the page says why rather than reading as "none".
  const held = locks.filter((lock) => lock.status === LockStatus.Locked);
  const clockUnread = chainTime === undefined && held.length > 0;

  const open = locks
    .filter((lock) => contestable(lock, disputeWindow, chainTime, account?.contractSet))
    .sort((a, b) => Number(b.id - a.id));

  // The index says which payments exist and the escrow says what became of each, so both lists
  // below are as read as the weaker of the two and neither is empty until both have answered.
  const outcomes = weaker(ledger.timeline, ledger.chain);

  return (
    <div className="space-y-10">
      <Section
        title="Refusals"
        description="Payments this mandate refused, and the condition that stopped each one."
      >
        <Card>
          {feed.reading.state === 'unreadable' || feed.reading.state === 'refused' ? (
            <ErrorSurface error={feed.reading.error} action="Reading the refusals" onRetry={feed.refresh} />
          ) : feed.reading.state === 'loading' ? (
            <p className="text-detail text-[color:var(--color-muted)]">Loading refusals.</p>
          ) : feed.refusals.length === 0 ? (
            <EmptyState title="Nothing has been refused.">
              Every payment this mandate was asked for went through.
            </EmptyState>
          ) : (
            <Table
              rows={feed.refusals}
              rowKey={(row) => row.transaction.hash}
              caption="Payments the contract refused"
              columns={[
                {
                  key: 'when',
                  header: 'When',
                  cell: (row) => (
                    <span className="text-detail">
                      <Instant at={row.transaction.at} relative />
                    </span>
                  ),
                },
                {
                  key: 'attempt',
                  header: 'What was attempted',
                  cell: (row) => <Attempted refusal={row} labelFor={labelFor} />,
                },
                {
                  key: 'condition',
                  header: 'Which condition',
                  cell: (row) => <Condition state={row.cause.state} system={system.all} />,
                },
                {
                  key: 'reason',
                  header: 'Why',
                  cell: (row) => (
                    <span className="text-detail">
                      <span className="font-medium">{row.cause.headline}. </span>
                      <span className="text-[color:var(--color-muted)]">{row.cause.detail}</span>
                      {row.cause.errorName && (
                        <span className="tabular block text-note text-[color:var(--color-muted)]">{row.cause.errorName}</span>
                      )}
                    </span>
                  ),
                },
                {
                  key: 'transaction',
                  header: 'On chain',
                  align: 'right',
                  secondary: true,
                  cell: (row) => <TxHash hash={row.transaction.hash} />,
                },
              ]}
            />
          )}
          {feed.truncated && (
            <p className="mt-3 text-detail text-[color:var(--color-muted)]">
              Showing the most recent refusals.
            </p>
          )}
        </Card>
      </Section>

      <Section
        title="Deliveries that did not complete"
        description="Payments the mandate allowed where the work did not arrive."
      >
        <Card>
          {outcomes.state === 'loading' ? (
            <p className="text-detail text-[color:var(--color-muted)]">
              Loading payments.
            </p>
          ) : outcomes.state === 'unreadable' ? (
            <p className="text-detail text-[color:var(--color-muted)]">
              These payments could not be loaded. Use Check again at the top of the page.
            </p>
          ) : outcomes.state === 'refused' ? (
            <p className="text-detail text-[color:var(--color-muted)]">
              {refusalLine(outcomes.error)}
            </p>
          ) : incomplete.length === 0 ? (
            <p className="text-detail text-[color:var(--color-muted)]">
              Every payment this mandate made was delivered and settled.
            </p>
          ) : (
            <Table
              rows={incomplete}
              rowKey={(lock) => lock.id.toString()}
              caption="Payments that did not end in a delivery"
              columns={[
                { key: 'id', header: 'Payment', cell: (lock) => <span className="tabular text-detail">#{lock.id.toString()}</span> },
                { key: 'payee', header: 'Provider', cell: (lock) => <AddressView value={lock.payee} /> },
                { key: 'amount', header: 'Amount', align: 'right', cell: (lock) => <span className="tabular">{usd(lock.amount)}</span> },
                {
                  key: 'outcome',
                  header: 'What happened',
                  cell: (lock) => (
                    <div className="space-y-2">
                      <span className="text-detail">
                        <span className="font-medium">{returnable(lock, chainTime) ? OVERDUE_WORD : lockWord(lock.status)}. </span>
                        <span className="text-[color:var(--color-muted)]">
                          {returnable(lock, chainTime)
                            ? OVERDUE_DETAIL
                            : rulingDetail(ledger.lockEvents.get(lock.id.toString())?.resolved) ?? lockDetail(lock.status)}
                        </span>
                      </span>
                      {(lock.status === LockStatus.Disputed || lock.status === LockStatus.Resolved) && (
                        <LockRuling escrow={account?.escrow ?? ADDRESSES.escrow} lockId={lock.id} />
                      )}
                    </div>
                  ),
                },
                {
                  key: 'owner',
                  header: 'Whose move',
                  secondary: true,
                  cell: (lock) => (
                    <span className="text-detail text-[color:var(--color-muted)]">
                      {whoseMove(lock.status, returnable(lock, chainTime))}
                    </span>
                  ),
                },
                {
                  key: 'return',
                  header: '',
                  align: 'right',
                  cell: (lock) =>
                    isOwner && returnable(lock, chainTime) ? (
                      <TxButton
                        label="Return the money"
                        tone="secondary"
                        blockedBy={transferGates(system)}
                        context={{ ...writeContext, merchant: lock.payee, amount: lock.amount }}
                        send={() =>
                          writeContractAsync({
                            // The mandate's own escrow: a v1 mandate's payments sit in the v1 one.
                            address: account?.escrow ?? ADDRESSES.escrow,
                            abi: escrowAbi,
                            functionName: 'timeout',
                            args: [lock.id],
                          })
                        }
                        onContinue={refresh}
                      />
                    ) : isOwner && lock.status === LockStatus.Disputed && isSealedURI(lock.inputURI) ? (
                      <ShareWithResolver
                        escrow={account?.escrow ?? ADDRESSES.escrow}
                        lockId={lock.id}
                        inputURI={lock.inputURI}
                        payee={lock.payee}
                      />
                    ) : null,
                },
              ]}
            />
          )}

          {overdue.length > 0 && (
            <p className="mt-4 max-w-3xl text-detail text-[color:var(--color-muted)]">
              Returning a payment sends the full amount back to this mandate and restores its budget. The missed
              delivery counts against the provider&rsquo;s record.{isOwner ? '' : ' The owner of this mandate can return it.'}
            </p>
          )}

          {clockUnread && (
            <p className="mt-4 max-w-3xl text-detail text-[color:var(--color-muted)]">
              {held.length === 1 ? 'One payment is' : `${held.length} payments are`} still held in escrow, and their
              deadlines could not be checked. Use Check again at the top of the page.
            </p>
          )}
        </Card>
      </Section>

      {isOwner && account && (
        <Section
          title="Payments you can still contest"
          description={
            bondBps === undefined
              ? 'Contesting a payment sends it to the resolvers.'
              : `Contesting a payment the escrow still holds posts a ${bondBps / 100}% bond from this mandate. You get it back if the ruling goes your way.`
          }
        >
          <Card>
            <p className="mb-4 max-w-3xl text-detail text-[color:var(--color-muted)]">
              {resolverFeeBps === undefined
                ? 'When the resolvers rule, a resolver fee comes off the payment before any refund.'
                : `When the resolvers rule, a ${
                    resolverFeeBps / 100
                  }% resolver fee comes off the payment before any refund, so a ruling in your favour returns the payment less that fee.`}
            </p>
            {outcomes.state === 'loading' ? (
              <p className="text-detail text-[color:var(--color-muted)]">
                Loading payments you can contest.
              </p>
            ) : outcomes.state === 'unreadable' ? (
              <p className="text-detail text-[color:var(--color-muted)]">
                These payments could not be loaded. Use Check again at the top of the page.
              </p>
            ) : outcomes.state === 'refused' ? (
              <p className="text-detail text-[color:var(--color-muted)]">
                {refusalLine(outcomes.error)}
              </p>
            ) : open.length === 0 ? (
              <p className="text-detail text-[color:var(--color-muted)]">
                Nothing to contest right now. A payment can be contested while it is held in escrow, and for a short
                window after it settles.
              </p>
            ) : (
              <div className="space-y-4">
                {open.map((lock) => {
                  // The escrow takes the bond out of this account in the same transaction, so a
                  // mandate that cannot cover it has nothing to contest with. A released lock
                  // carries no bond: the payee already has the money and there is no ruling to
                  // back. Offering the button either way would put the fee on the owner for a
                  // transfer the token is about to refuse.
                  const bond = lock.status === LockStatus.Locked && bondBps !== undefined ? mulBps(lock.amount, bondBps) : undefined;
                  const short = bond !== undefined && account.balance < bond;

                  return (
                    <div key={lock.id.toString()} className="flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--color-line)] pb-4 last:border-0 last:pb-0">
                      {/* A zero basis keeps the text from pushing the button onto a line of its own. */}
                      <div className="min-w-0 flex-1 basis-0 space-y-1">
                        <p className="text-sm font-medium">
                          Payment #{lock.id.toString()} · {usd(lock.amount)} to {shortAddress(lock.payee)}
                        </p>
                        <p className="text-detail text-[color:var(--color-muted)]">
                          {returnable(lock, chainTime) ? (
                            <>
                              Past its deadline. Returning it above sends the full amount back at no cost. Contesting
                              instead posts a bond of {bond === undefined ? 'the escrow’s rate' : usdExact(bond)} and asks
                              the resolvers to split it.
                            </>
                          ) : lock.status === LockStatus.Locked ? (
                            <>
                              Held in escrow. The provider has to deliver <Countdown to={lock.deadline} />. Contesting
                              posts a bond of {bond === undefined ? 'the escrow’s rate' : usdExact(bond)} from this
                              mandate.
                            </>
                          ) : (
                            <>
                              Paid to the provider <Instant at={lock.releasedAt} relative />. A complaint now goes on
                              their record; the payment is not reversed.
                            </>
                          )}
                        </p>
                        {short && bond !== undefined && (
                          <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
                            The bond is {usdExact(bond)} and this mandate holds {usd(account.balance)} in USDG. Add
                            USDG before contesting.
                          </p>
                        )}
                      </div>
                      <TxButton
                        label="Contest"
                        tone="secondary"
                        disabled={short}
                        blockedBy={transferGates(system)}
                        context={{ ...writeContext, merchant: lock.payee, amount: lock.amount }}
                        confirmPhrase="CONTEST"
                        confirmTitle={`Contest payment #${lock.id.toString()}`}
                        confirmDescription={
                          lock.status === LockStatus.Locked
                            ? `${bond === undefined ? 'A bond is' : `A bond of ${usdExact(bond)} is`} posted from this mandate and the resolvers decide how the amount is split. ${feeWarning(
                                lock.amount,
                                resolverFeeBps,
                                account.contractSet,
                              )}`
                            : 'The complaint is recorded against the provider. The payment itself is not reversed.'
                        }
                        send={() =>
                          writeContractAsync({
                            address,
                            abi: mandateAccountAbi,
                            functionName: 'disputeSpend',
                            args: [lock.id],
                          })
                        }
                        onContinue={refresh}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </Section>
      )}
    </div>
  );
}

/**
 * A refused read in the index's own words.
 *
 * Kept as one sentence builder because three surfaces on this page reach it, and a 402 described
 * three different ways is three different problems to whoever reads them.
 */
function refusalLine(error: unknown): string {
  const refusal = refusalOf(error);
  return refusal === undefined
    ? 'The history for this list could not be loaded.'
    : `${refusal.condition} ${refusal.nextAction}`;
}

/**
 * What contesting costs on top of the bond.
 *
 * `Escrow._split` takes the resolver fee off the lock before it applies the refund, so the best
 * outcome a payer can get out of a dispute is the payment less that fee. On v1, `failDispute`
 * charges it on a panel that never reached a quorum as well, where it reaches no resolver at all
 * and ends up in `unallocatedRewards` with nothing that returns it here. From v2 on a panel that
 * does not rule takes no fee: the payment goes back into escrow and the bond comes back.
 */
function feeWarning(amount: Micro, resolverFeeBps: number | undefined, contractSet: ContractSet): string {
  if (contractSet !== 'v1') {
    const fee =
      resolverFeeBps === undefined
        ? 'a resolver fee'
        : `a ${resolverFeeBps / 100}% resolver fee (${usdExact(mulBps(amount, resolverFeeBps))})`;
    return `If the resolvers rule, ${fee} comes off the payment before any refund. If they cannot rule, the payment goes back into escrow with a new deadline and the bond is returned. Each payment can be contested once.`;
  }

  if (resolverFeeBps === undefined) {
    return 'A resolver fee also comes off the payment before any refund, even when the resolvers cannot rule.';
  }

  return `A ${resolverFeeBps / 100}% resolver fee (${usdExact(
    mulBps(amount, resolverFeeBps),
  )}) also comes off the payment before any refund, even when the resolvers cannot rule.`;
}

function Condition({ state, system }: { readonly state: StateKey | null; readonly system: readonly AnyState[] }) {
  if (state === null) {
    return (
      <span className="text-detail">
        <span className="font-medium">None of the five. </span>
        <span className="text-[color:var(--color-muted)]">The escrow&rsquo;s rules stopped this one.</span>
      </span>
    );
  }

  const report = system.find((entry) => entry.key === state);
  if (!report) return <span className="text-detail">{state}</span>;

  return (
    <span className="inline-flex items-center gap-1.5 text-detail">
      <LevelDot level={report.level} label={`${report.label}: ${levelWord(report.level)}`} />
      <span>
        <span className="font-medium">{report.label}</span>
        <span className="block text-note text-[color:var(--color-muted)]">{levelWord(report.level)} now</span>
      </span>
    </span>
  );
}

function Attempted({ refusal, labelFor }: { readonly refusal: Refusal; readonly labelFor: (id: `0x${string}`) => string | undefined }) {
  const attempt = refusal.attempt;
  if (!attempt) {
    return <span className="text-detail text-[color:var(--color-muted)]">An action this console does not recognise</span>;
  }

  return (
    <span className="text-detail">
      <span className="font-medium">{attempt.action}</span>
      {attempt.amount !== undefined && <span className="tabular block">{usd(attempt.amount)}</span>}
      {attempt.merchant !== undefined && (
        <span className="block text-note text-[color:var(--color-muted)]">
          to {shortAddress(attempt.merchant)}
          {attempt.capabilityId !== undefined && <> for {labelFor(attempt.capabilityId) ?? shortAddress(attempt.capabilityId, 8, 6)}</>}
        </span>
      )}
    </span>
  );
}


/** Where a ruling sent the money, from the escrow's own record of it. */
function rulingDetail(resolved: { readonly refunded: Micro; readonly paid: Micro } | undefined): string | undefined {
  if (resolved === undefined) return undefined;
  if (resolved.paid === 0n) return `The resolvers returned ${usdExact(resolved.refunded)} to this mandate and the provider was paid nothing.`;
  if (resolved.refunded === 0n) return `The resolvers ruled for the provider, who was paid ${usdExact(resolved.paid)}. Nothing came back to this mandate.`;
  return `The resolvers returned ${usdExact(resolved.refunded)} to this mandate and paid the provider ${usdExact(resolved.paid)}.`;
}

/** Who has to act next on a payment that did not end in a delivery. */
export function whoseMove(status: LockStatus, overdue: boolean): string {
  if (overdue) return 'Yours';
  if (status === LockStatus.Disputed) return 'The resolvers';
  return 'Nobody. It is closed.';
}

/**
 * The published ruling behind a contested payment, found through the dispute registry that serves
 * the mandate's escrow. The note says itself when nothing has been published yet.
 */
function LockRuling({ escrow, lockId }: { readonly escrow: Address; readonly lockId: bigint }) {
  const tag = readableDeployments().find((entry) => entry.escrow.toLowerCase() === escrow.toLowerCase());
  const dispute = useQuery({
    queryKey: ['console', 'dispute-of-lock', escrow, lockId.toString()],
    queryFn: async () =>
      (await rhcClient().readContract({
        address: tag!.oracleRegistry,
        abi: oracleRegistryAbi,
        functionName: 'disputeIdOf',
        args: [lockId],
      })) as bigint,
    enabled: tag !== undefined,
    staleTime: 60_000,
  });
  if (tag === undefined || dispute.data === undefined || dispute.data === 0n) return null;
  return <RulingNote disputeId={dispute.data} {...(tag.current ? {} : { registry: tag.oracleRegistry })} />;
}
