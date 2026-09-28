'use client';

import { isTotalBudgetWindow, mulBps } from '@bursar/core';
import type { ContractSet } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { LockStatus } from '@bursar/sdk';

import { escrowAbi, mandateAccountAbi } from '@/chain/abi';
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
  // Only a v1 total budget comes back as MonthlyCapExceeded. A v2 total has its own error.
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

  const open = locks.filter((lock) => contestable(lock, disputeWindow)).sort((a, b) => Number(b.id - a.id));

  // The index says which payments exist and the escrow says what became of each, so both lists
  // below are as read as the weaker of the two and neither is empty until both have answered.
  const outcomes = weaker(ledger.timeline, ledger.chain);

  return (
    <div className="space-y-10">
      <Section
        title="Refusals"
        description="The contract turned these payments down. The fee for sending them was still paid, which is why they are in the record at all."
      >
        <Card>
          {feed.reading.state === 'unreadable' || feed.reading.state === 'refused' ? (
            <ErrorSurface error={feed.reading.error} action="Reading the refusals" onRetry={feed.refresh}>
              <p className="mt-1 text-detail text-[color:var(--color-muted)]">
                The contracts keep no record of a refusal; only the network index does. So this list is the part that
                goes missing when the index will not hand it over.
              </p>
            </ErrorSurface>
          ) : feed.reading.state === 'loading' ? (
            <p className="text-detail text-[color:var(--color-muted)]">Reading the refusals on this mandate.</p>
          ) : feed.refusals.length === 0 ? (
            <EmptyState title="Nothing has been refused.">
              Every payment this mandate was asked for went through. A refusal appears here with the condition that
              caused it, the moment it happens.
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
              Older refusals exist beyond the most recent ones read here.
            </p>
          )}
        </Card>
      </Section>

      <Section
        title="Deliveries that did not complete"
        description="None of these is one of the five conditions. The mandate allowed the payment and the work did not arrive."
      >
        <Card>
          {outcomes.state === 'loading' ? (
            <p className="text-detail text-[color:var(--color-muted)]">
              Reading what became of the payments this mandate made.
            </p>
          ) : outcomes.state === 'unreadable' ? (
            <p className="text-detail text-[color:var(--color-muted)]">
              What became of these payments could not be read. The escrow still holds the record; the request for it
              did not come back. Check again at the top of the page.
            </p>
          ) : outcomes.state === 'refused' ? (
            <p className="text-detail text-[color:var(--color-muted)]">
              {refusalLine(outcomes.error)} The escrow still holds the record of every one of them.
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
                    <span className="text-detail">
                      <span className="font-medium">{returnable(lock, chainTime) ? OVERDUE_WORD : lockWord(lock.status)}. </span>
                      <span className="text-[color:var(--color-muted)]">
                        {returnable(lock, chainTime) ? OVERDUE_DETAIL : lockDetail(lock.status)}
                      </span>
                    </span>
                  ),
                },
                {
                  key: 'owner',
                  header: 'Whose move',
                  secondary: true,
                  cell: (lock) => (
                    <span className="text-detail text-[color:var(--color-muted)]">
                      {returnable(lock, chainTime) ? 'Yours' : lock.status === LockStatus.Disputed ? 'The resolver' : 'The provider'}
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
                    ) : null,
                },
              ]}
            />
          )}

          {overdue.length > 0 && (
            <p className="mt-4 max-w-3xl text-detail text-[color:var(--color-muted)]">
              Returning a payment sends the full amount back to this mandate and credits the day and the month it was
              taken from. It also records a delivery the provider never made, which lowers the largest single job any
              payer may lock against that address. The escrow takes this call from anybody once the deadline has gone,
              so the money is not lost while it waits{isOwner ? '' : ', and the owner of this mandate can make it'}.
            </p>
          )}

          {clockUnread && (
            <p className="mt-4 max-w-3xl text-detail text-[color:var(--color-muted)]">
              The escrow is still holding {held.length === 1 ? 'one payment' : `${held.length} payments`} from this
              mandate, and the chain&rsquo;s own clock did not come back, so whether{' '}
              {held.length === 1 ? 'it has' : 'any of them has'} passed its deadline is unknown. Nothing here says none
              has. Check again at the top of the page.
            </p>
          )}
        </Card>
      </Section>

      {isOwner && account && (
        <Section
          title="Payments you can still contest"
          description={
            bondBps === undefined
              ? 'Contesting a payment sends it to a bonded resolver.'
              : `Contesting a payment the provider has not claimed posts a bond of ${bondBps / 100}% of the amount from this mandate. It comes back only if the ruling lands on your side.`
          }
        >
          <Card>
            <p className="mb-4 max-w-3xl text-detail text-[color:var(--color-muted)]">
              {resolverFeeBps === undefined
                ? 'What the resolver panel charges could not be read. The escrow takes its cut of a contested payment before any refund is worked out, so the most a ruling can return is the payment less that cut.'
                : `Two things come out of a contested payment. The bond above is one. The other is the resolver fee of ${
                    resolverFeeBps / 100
                  }%, which the escrow takes off the payment before it works out any refund, so even a ruling in your favour returns the payment less that fee. It is charged the same way when the panel never reaches a quorum and no resolver is paid out of it, and nothing returns it to this mandate. The escrow credits the day and the month it was taken from with what comes back, not with what was booked.`}
            </p>
            {outcomes.state === 'loading' ? (
              <p className="text-detail text-[color:var(--color-muted)]">
                Reading which payments are still open to a complaint.
              </p>
            ) : outcomes.state === 'unreadable' ? (
              <p className="text-detail text-[color:var(--color-muted)]">
                Whether anything is open to contest could not be read either. A payment does not stop being
                contestable because a reading failed.
              </p>
            ) : outcomes.state === 'refused' ? (
              <p className="text-detail text-[color:var(--color-muted)]">
                {refusalLine(outcomes.error)} A payment does not stop being contestable because a read was turned
                down, and the escrow will still take the call.
              </p>
            ) : open.length === 0 ? (
              <p className="text-detail text-[color:var(--color-muted)]">
                Nothing is open to contest right now. A payment can be contested while the escrow still holds it, and a
                settled one for as long as the dispute window is open.
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
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium">
                          Payment #{lock.id.toString()} · {usd(lock.amount)} to {shortAddress(lock.payee)}
                        </p>
                        <p className="text-detail text-[color:var(--color-muted)]">
                          {returnable(lock, chainTime) ? (
                            <>
                              The escrow still holds it and the deadline has gone. Returning it above sends the whole
                              amount back and posts nothing. Contesting instead posts a bond of{' '}
                              {bond === undefined ? 'the escrow’s rate' : usdExact(bond)} from this mandate and asks a
                              resolver to split the payment.
                            </>
                          ) : lock.status === LockStatus.Locked ? (
                            <>
                              The escrow still holds it. The provider has until <Countdown to={lock.deadline} /> to
                              deliver, and a bond of {bond === undefined ? 'the escrow’s rate' : usdExact(bond)} is posted
                              from this mandate when you contest. {feeWarning(lock.amount, resolverFeeBps, account.contractSet)}
                            </>
                          ) : (
                            <>
                              The provider was paid <Instant at={lock.releasedAt} relative />. The money has already
                              moved, so a complaint now goes on their settlement history and nobody rules on it.
                            </>
                          )}
                        </p>
                        {short && bond !== undefined && (
                          <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
                            This mandate holds {usd(account.balance)} in USDG and the bond is {usdExact(bond)}. Fund the
                            account with USDG before contesting. Transaction fees are paid in ETH and are a different
                            asset; they are not what is short here.
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
                            ? `A bond is posted from this mandate and a resolver decides how the locked amount is split. ${feeWarning(
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
    ? 'The network index turned this read down.'
    : `${refusal.condition} ${refusal.nextAction}`;
}

/**
 * What contesting costs on top of the bond.
 *
 * `Escrow._split` takes the resolver fee off the lock before it applies the refund, so the best
 * outcome a payer can get out of a dispute is the payment less that fee. On v1, `failDispute`
 * charges it on a panel that never reached a quorum as well, where it reaches no resolver at all
 * and ends up in `unallocatedRewards` with nothing that returns it here. On v2 a panel that does
 * not rule takes no fee: the payment goes back into escrow and the bond comes back.
 */
function feeWarning(amount: Micro, resolverFeeBps: number | undefined, contractSet: ContractSet): string {
  if (contractSet === 'v2') {
    const fee =
      resolverFeeBps === undefined
        ? 'a resolver fee'
        : `a ${resolverFeeBps / 100}% resolver fee, ${usdExact(mulBps(amount, resolverFeeBps))},`;
    return `When the panel rules, the escrow takes ${fee} off the payment before it works out any refund. If no ruling is reached, the payment goes back into escrow with a new deadline, no fee is taken and the bond is returned. A payment can be contested once.`;
  }

  if (resolverFeeBps === undefined) {
    return 'The escrow also takes a resolver fee off the payment before it works out any refund, which is charged even where no resolver rules. What that fee is could not be read.';
  }

  return `The escrow also takes a ${resolverFeeBps / 100}% resolver fee, ${usdExact(
    mulBps(amount, resolverFeeBps),
  )}, off the payment before it works out any refund. A dispute no resolver can rule still costs it, and nothing returns it to this mandate.`;
}

function Condition({ state, system }: { readonly state: StateKey | null; readonly system: readonly AnyState[] }) {
  if (state === null) {
    return (
      <span className="text-detail">
        <span className="font-medium">None of the five. </span>
        <span className="text-[color:var(--color-muted)]">The escrow&rsquo;s own rules stopped this one.</span>
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
    return <span className="text-detail text-[color:var(--color-muted)]">A call this console cannot name</span>;
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

