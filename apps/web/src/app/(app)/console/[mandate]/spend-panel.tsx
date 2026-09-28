'use client';

import { useRef, useState } from 'react';
import type { SpendWindow } from '@bursar/sdk';

import { mandateAccountAbi } from '@/chain/abi';
import { toLimitsTuple } from '@/chain/limits';
import { Button } from '@/components/button';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { Countdown, Instant } from '@/components/instant';
import { LimitBar, Stat, StatGrid } from '@/components/stat';
import { TxButton } from '@/components/tx-button';
import { usd } from '@/money';
import { fromUnix } from '@/lib/time';
import { describeApproval, windowWord } from '../lib/format';
import { callGates } from '../lib/write-gates';
import { LimitsFields, draftFromLimits, readDraft } from '../limits-form';
import { isTotalBudgetWindow } from '@bursar/core';
import type { LimitsDraft } from '../limits-form';
import { useMandateScope } from './mandate-scope';
import { useWriteContract } from '@/wallet/write';

/**
 * What the mandate has left, read from `remaining()` on the account and never from a copy.
 *
 * The caps are what was granted. The remainder is what an agent can spend in this moment,
 * after the windows have rolled forward, and it is the only figure a decision is ever made against.
 */
export function SpendPanel() {
  const { address, account, isOwner, system, writeContext, refresh } = useMandateScope();
  const { writeContractAsync } = useWriteContract();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<LimitsDraft | undefined>(undefined);
  // The version the account was on when the last limit change was sent. It is what turns the
  // counter into a read-back: the new set is on chain only once the account reports a higher one.
  const [rewroteFrom, setRewroteFrom] = useState<bigint | undefined>(undefined);
  // The version at the moment the wallet was asked. It becomes `rewroteFrom` only on a receipt: a
  // signature the reader declined, or a call that reverted, rewrote nothing and must not say so if a
  // later poll happens to see the version move for some other reason.
  const sentFrom = useRef<bigint | undefined>(undefined);

  if (!account) return null;

  const reading = draft ? readDraft(draft) : undefined;
  const validUntil = fromUnix(account.limits.validUntil);
  const validFrom = fromUnix(account.limits.validFrom);
  const landed = rewroteFrom !== undefined && account.version > rewroteFrom;

  const startEditing = () => {
    setDraft(draftFromLimits(account.limits));
    setRewroteFrom(undefined);
    setEditing(true);
  };

  return (
    <Section
      title="What is left"
      description={
        isTotalBudgetWindow(account.monthly.duration)
          ? 'The period cap refills each period. The total budget never refills, so it bounds the whole mandate.'
          : 'Both windows bind at once, so the tighter of the two is what the agent feels right now.'
      }
      actions={
        isOwner && !editing ? (
          <Button size="sm" onClick={startEditing}>
            Change the limits
          </Button>
        ) : undefined
      }
    >
      <Card>
        <div className="space-y-6">
          <StatGrid columns={3}>
            <Stat
              label="Most per payment"
              value={usd(account.limits.perCallCap)}
              hint={`A single payment above this is refused. ${usd(account.remaining.perCall)} is the ceiling in force now.`}
            />
            <WindowStat window={account.daily} label="Period cap" />
            {isTotalBudgetWindow(account.monthly.duration) ? (
              <TotalStat window={account.monthly} />
            ) : (
              <WindowStat window={account.monthly} label="Second cap" />
            )}
          </StatGrid>

          <FieldGrid columns={3}>
            <Field label="Approvals" hint="Set by the threshold written into the limits.">
              {describeApproval(account.limits.approvalThreshold, account.limits.perCallCap)}
            </Field>
            <Field label="Valid" hint={validFrom ? 'Opens on the date shown.' : 'Open since the account was created.'}>
              {validUntil ? (
                <>
                  until <Instant at={validUntil} />
                </>
              ) : (
                'No expiry'
              )}
            </Field>
            <Field label="Limit version" hint="Rises by one every time the limits are rewritten.">
              <span className="tabular">{account.version.toString()}</span>
              {landed && rewroteFrom !== undefined && (
                <span className="block text-note" style={{ color: 'var(--color-state-ok)' }}>
                  Rewritten. The account was on {rewroteFrom.toString()} before this change.
                </span>
              )}
            </Field>
          </FieldGrid>

          {editing && draft && (
            <div className="space-y-4 rounded-md border border-[color:var(--color-line)] p-4">
              <div>
                <h3 className="text-sm font-semibold">Change the limits</h3>
                <p className="mt-0.5 text-detail text-[color:var(--color-muted)]">
                  The whole set is written at once. The period and the total are re-anchored to the moment this lands
                  and what has already been spent stays counted, so a change cannot hand back an allowance that was used.
                </p>
              </div>

              <LimitsFields draft={draft} onChange={setDraft} problems={reading?.problems ?? []} />

              <div className="flex flex-wrap items-center gap-2">
                <TxButton
                  label="Write the new limits"
                  disabled={reading?.limits === undefined}
                  blockedBy={callGates(system)}
                  context={writeContext}
                  send={() => {
                    sentFrom.current = account.version;
                    return writeContractAsync({
                      address,
                      abi: mandateAccountAbi,
                      functionName: 'setLimits',
                      args: [toLimitsTuple(reading!.limits!)],
                    });
                  }}
                  onConfirmed={() => setRewroteFrom(sentFrom.current)}
                  onContinue={() => {
                    setEditing(false);
                    refresh();
                  }}
                />
                <Button tone="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>

              {reading && reading.problems.length > 0 && (
                <ul className="space-y-1 text-detail" style={{ color: 'var(--color-state-blocked)' }}>
                  {reading.problems.map((problem) => (
                    <li key={`${problem.field}:${problem.problem}`}>{problem.problem}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </Card>
    </Section>
  );
}

/** The second window when it is the total budget: it never resets, so it shows no countdown. */
function TotalStat({ window: spendWindow }: { readonly window: SpendWindow }) {
  const cap = Number(spendWindow.cap);
  const spent = Number(spendWindow.spent);
  const exhausted = spendWindow.remaining === 0n;
  const level = exhausted ? 'blocked' : spent > cap * 0.8 ? 'attention' : 'ok';

  return (
    <div className="space-y-2">
      <Stat
        label="Total budget"
        value={usd(spendWindow.remaining)}
        level={level}
        hint={`${usd(spendWindow.spent)} of ${usd(spendWindow.cap)} spent. It never refills; the owner can raise it.`}
      />
      <LimitBar used={spent} total={cap} level={level} />
    </div>
  );
}

function WindowStat({ window: spendWindow, label }: { readonly window: SpendWindow; readonly label: string }) {
  const cap = Number(spendWindow.cap);
  const spent = Number(spendWindow.spent);
  const exhausted = spendWindow.remaining === 0n;

  return (
    <div className="space-y-2">
      <Stat
        label={`${label} · every ${windowWord(spendWindow.duration)}`}
        value={usd(spendWindow.remaining)}
        level={exhausted ? 'blocked' : spent > cap * 0.8 ? 'attention' : 'ok'}
        hint={
          <>
            {usd(spendWindow.spent)} of {usd(spendWindow.cap)} spent. Resets <Countdown to={spendWindow.resetsAt} />.
          </>
        }
      />
      <LimitBar used={spent} total={cap} level={exhausted ? 'blocked' : spent > cap * 0.8 ? 'attention' : 'ok'} />
    </div>
  );
}
