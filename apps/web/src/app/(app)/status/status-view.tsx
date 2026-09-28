'use client';

import { micro, mulBps } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { useMemo, useState } from 'react';
import { isAddress } from 'viem';
import type { Address as EvmAddress } from 'viem';

import { ADDRESSES, RHC } from '@/chain';
import { Address } from '@/components/address';
import { LevelDot } from '@/components/badge';
import { Button } from '@/components/button';
import { Instant } from '@/components/instant';
import { ErrorSurface } from '@/components/error-surface';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { StatusList } from '@/components/status';
import { Table } from '@/components/table';
import { formatDuration } from '@/lib';
import { bps, formatEth, usd } from '@/money';
import { DEPLOY_FEE, DEPLOY_GAS, ROUND_TRIP_FEE, ROUND_TRIP_GAS, useSystemState } from '@/state';

type ContractRow = { readonly name: string; readonly address: EvmAddress; readonly role: string };

const CONTRACTS: readonly ContractRow[] = [
  { name: 'Mandate accounts', address: ADDRESSES.mandateAccountFactory, role: 'Creates an account at an address the owner can compute first.' },
  { name: 'Escrow', address: ADDRESSES.escrow, role: 'Holds a payment until the provider delivers or the deadline passes.' },
  { name: 'Provider registry', address: ADDRESSES.agentRegistry, role: 'Who may be paid, and the stake behind them.' },
  { name: 'Reputation', address: ADDRESSES.reputation, role: 'Settled work raises how much one job may carry.' },
  { name: 'Disputes', address: ADDRESSES.oracleRegistry, role: 'Bonded resolvers rule on a contested delivery.' },
  { name: 'Governance delay', address: ADDRESSES.adminTimelock, role: 'Parameter changes wait out a fixed delay before they take effect.' },
  { name: 'USDG', address: ADDRESSES.usdg, role: 'The asset payments settle in. Transaction fees are paid in ETH, which is a different asset.' },
  { name: 'Fee account', address: ADDRESSES.treasury, role: 'Receives the settlement fee the escrow collects.' },
];

/** One hundred USDG, as the worked example the settlement fee is easiest to read against. */
const EXAMPLE_PAYMENT: Micro = micro(100_000_000n);

/**
 * The reference reading of the five states.
 *
 * Nothing on this page reduces them to one indicator. Each is reported on its own line with its
 * own explanation, because each has a different owner and a different fix.
 */
export function StatusView() {
  const [typed, setTyped] = useState('');
  const checked = useMemo(() => (isAddress(typed.trim()) ? (typed.trim() as EvmAddress) : undefined), [typed]);

  // Handing the address in as the principal is what puts it into the batched compliance read. That
  // narrows the asset state from the network at large down to one address.
  const system = useSystemState(checked ? { principal: checked } : {});
  const escrow = system.snapshot?.escrow;
  const asset = system.assetRead;
  const timelockPeriod = system.snapshot?.governance.period;
  const blocked = checked === undefined ? undefined : system.asset.facts.blocked[checked.toLowerCase()];

  return (
    <div className="space-y-10">
      <Section
        title="Conditions right now"
        description="Five conditions stand between an agent and a settled payment. Each is reported on its own, because each has a different owner and a different fix."
        actions={
          <Button size="sm" onClick={system.refresh} disabled={system.isFetching}>
            {system.isFetching ? 'Checking' : 'Check again'}
          </Button>
        }
      >
        <Card>
          <StatusList system={system} detailed />
        </Card>
        <ErrorSurface error={system.error} action="read the network" onRetry={system.refresh} />
        <p className="text-note text-[color:var(--color-muted)]">
          Connectivity and the asset apply to everyone on the network. The mandate, its permissions and its funding are
          answered per account, so they read as not in use until an account is named. Sign in to the console to see them
          for yours.
          {system.snapshot && (
            <>
              {' '}
              This reading was taken <Instant at={system.snapshot.readAt} relative /> at block{' '}
              {system.snapshot.blockNumber.toString()}, in{' '}
              {system.snapshot.calls} contract reads and one request.
            </>
          )}
        </p>
      </Section>

      <Section
        title="Two controls on the settlement asset, and neither is ours"
        description="Operating facts about USDG that a payment can fail on. Both are read live from the token."
      >
        <Card>
          <div className="space-y-3 text-sm">
            <p>
              Payments settle in USDG. Its issuer operates the two controls on it: a pause that stops the token, and a
              blocklist, which is the set of addresses the token refuses to move funds for.
            </p>
            <p>
              If USDG is paused, payments stop. Transaction fees are paid in ETH, so a pause, a revoke and a withdrawal
              still confirm while the token is frozen.
            </p>
            <p>
              A transfer also reverts when either address is on the blocklist, whatever the balance shows and whatever
              the mandate allows.
            </p>
            <p className="text-[color:var(--color-muted)]">
              Neither control belongs to BURSAR and neither can be worked around. Both are read from the token at{' '}
              <span className="tabular">{ADDRESSES.usdg}</span> on every refresh of this page and reported above as
              their own condition.
            </p>
          </div>
        </Card>
      </Section>

      <Section title="Check an address" description="Whether the asset issuer has blocked it. Reads the token directly and signs nothing.">
        <Card>
          <div className="space-y-3">
            <label className="block text-detail">
              <span className="text-label uppercase tracking-wide text-[color:var(--color-muted)]">
                Address
              </span>
              <input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="blocklist-answer"
                className="tabular mt-1 h-11 w-full max-w-xl border border-[color:var(--color-line)] bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
              />
            </label>

            <p id="blocklist-answer" className="flex items-start gap-2 text-detail">
              {typed.trim().length === 0 ? (
                <span className="text-[color:var(--color-muted)]">
                  Paste an address to check it. Any address can be checked. The token itself answers, so nothing here
                  is a stale copy of the list.
                </span>
              ) : checked === undefined ? (
                <span className="text-[color:var(--color-muted)]">That is not a valid address yet.</span>
              ) : (
                <>
                  <span className="pt-1">
                    <LevelDot level={blocked === undefined ? 'unknown' : blocked ? 'blocked' : 'ok'} />
                  </span>
                  <span>
                    {blocked === undefined
                      ? 'Reading the token.'
                      : blocked
                        ? 'Blocked. Transfers to and from this address revert on the token, and no mandate can change that.'
                        : 'Not blocked. The token will move funds to and from this address.'}
                  </span>
                </>
              )}
            </p>
          </div>
        </Card>
      </Section>

      <Section title="Contracts" description={`Deployed on ${RHC.name}, chain ${RHC.chainId}. Every address below is public and can be read by anyone.`}>
        <Card>
          <Table
            caption="Deployed contracts"
            rows={CONTRACTS}
            rowKey={(row) => row.name}
            columns={[
              { key: 'name', header: 'Contract', cell: (row) => <span className="font-medium">{row.name}</span> },
              { key: 'address', header: 'Address', cell: (row) => <Address value={row.address} /> },
              { key: 'role', header: 'What it does', secondary: true, cell: (row) => <span className="text-[color:var(--color-muted)]">{row.role}</span> },
            ]}
          />
        </Card>
      </Section>

      <Section title="Parameters" description="Read from the contracts on this page load, not from a configuration file.">
        <Card>
          <FieldGrid columns={3}>
            <Field label="Settlement fee" hint="Charged on the payee's side. A refund, a timeout and a cancellation return the payer's funds whole.">
              {escrow?.feeBps === undefined ? 'Reading' : bps(escrow.feeBps)}
            </Field>
            <Field label="Delivery window" hint="The range a payer may choose from when opening a payment.">
              {escrow?.minTtl === undefined || escrow.maxTtl === undefined
                ? 'Reading'
                : `${formatDuration(Number(escrow.minTtl))} to ${formatDuration(Number(escrow.maxTtl))}`}
            </Field>
            <Field label="Time to contest" hint="After a payment, how long the payer has to challenge it.">
              {escrow?.disputeWindow === undefined ? 'Reading' : formatDuration(Number(escrow.disputeWindow))}
            </Field>
            <Field label="Cost of contesting" hint="Posted as a bond by whoever opens a dispute, returned only if the ruling goes their way.">
              {escrow?.disputeBondBps === undefined ? 'Reading' : `${bps(escrow.disputeBondBps)} of the payment`}
            </Field>
            <Field label="Governance delay" hint="Every parameter change a key can make waits this out first.">
              {timelockPeriod === undefined ? 'Reading' : formatDuration(Number(timelockPeriod))}
            </Field>
            <Field label="Settlement asset" hint="Read from the token itself. Transaction fees are paid in ETH and are never added to this.">
              {asset?.symbol === undefined || asset.decimals === undefined
                ? 'Reading'
                : `${asset.symbol}, ${asset.decimals} decimals`}
            </Field>
          </FieldGrid>
        </Card>
      </Section>

      <Section title="What a transaction costs" description="Taken from real transactions on this network.">
        <Card>
          <StatGrid columns={3}>
            <Stat label="One payment" value={formatEth(ROUND_TRIP_FEE)} hint={`${ROUND_TRIP_GAS.toLocaleString('en-US')} gas, locked and released, at the observed price`} />
            <Stat label="One mandate account" value={formatEth(DEPLOY_FEE)} hint={`${DEPLOY_GAS.toLocaleString('en-US')} gas to deploy an account at its computed address`} />
            <Stat
              label={`Fee on a ${usd(EXAMPLE_PAYMENT)} payment`}
              value={escrow?.feeBps === undefined ? '—' : usd(mulBps(EXAMPLE_PAYMENT, escrow.feeBps))}
              hint="Taken from the payee's side at settlement"
            />
          </StatGrid>
          <p className="mt-4 text-detail text-[color:var(--color-muted)]">
            Transaction fees are paid in ETH by whichever wallet signs. Payments are made in USDG out of the mandate
            account. They are two assets and two balances, and funding one does nothing for the other.
          </p>
        </Card>
      </Section>

      <Section title="Who can change what" description="The controls that exist, and where they sit.">
        <Card>
          <div className="space-y-3 text-sm">
            <p>
              The escrow&rsquo;s fee and its windows were fixed when it was deployed. No key can raise the fee on a
              payment that is already open, and no key can shorten a window under a job in progress.
            </p>
            <p>
              The parameters that can move, the reputation curve and the dispute settings among them, wait{' '}
              {timelockPeriod === undefined ? 'a fixed period' : formatDuration(Number(timelockPeriod))} before a change
              takes effect. Each one is published when it is proposed, so anyone relying on the old value has that long
              to act.
            </p>
          </div>
        </Card>
      </Section>
    </div>
  );
}
