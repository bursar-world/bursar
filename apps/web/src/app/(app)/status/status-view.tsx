'use client';

import { deploymentsForChain, micro, mulBps } from '@bursar/core';
import type { Deployment, Micro } from '@bursar/core';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { isAddress } from 'viem';
import type { Address as EvmAddress } from 'viem';

import { ADDRESSES, CHAIN_ID, RHC, TOKEN_ADDRESSES, TOKEN_ROLES } from '@/chain';
import { exampleMandate } from '@/chain/mandates';
import { deployment, sameAddress } from '@/chain/rhc';
import { Address } from '@/components/address';
import { LevelDot } from '@/components/badge';
import { Button } from '@/components/button';
import { Instant } from '@/components/instant';
import { ErrorSurface } from '@/components/error-surface';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { NETWORK_CONDITIONS, StatusList } from '@/components/status';
import { Table } from '@/components/table';
import { spellDuration } from '@/lib';
import { bps, formatEthApprox, usd, usdExact } from '@/money';
import { DEPLOY_FEE, DEPLOY_GAS, ROUND_TRIP_FEE, ROUND_TRIP_GAS, useSystemState } from '@/state';

type ContractRow = { readonly name: string; readonly address: EvmAddress; readonly role: string };
type ContractGroup = { readonly title: string; readonly rows: readonly ContractRow[] };
type EarlierRow = { readonly name: string; readonly addresses: readonly EvmAddress[]; readonly role: string };

/**
 * Every contract a user can touch, from the deployment records, so a contract added to a record is
 * listed here without anyone remembering to add it.
 */
export function contractGroups(): readonly ContractGroup[] {
  const current = deployment();
  const rwa = current.rwa;
  const privacy = current.privacy;
  const shielded = privacy?.shielded;
  const collateral = rwa?.collateral;
  const groups: ContractGroup[] = [
    {
      title: 'Payments',
      rows: [
        { name: 'Mandate accounts', address: ADDRESSES.mandateAccountFactory, role: 'Creates an account at an address the owner can compute first.' },
        ...(rwa?.MandateAccountFactoryV21
          ? [{ name: 'Mandate accounts that park or borrow', address: rwa.MandateAccountFactoryV21, role: 'Creates accounts that can draw parked or borrowed USDG inside a payment.' }]
          : []),
        { name: 'Escrow', address: ADDRESSES.escrow, role: 'Holds a payment until the provider delivers or the deadline passes.' },
        { name: 'Provider registry', address: ADDRESSES.agentRegistry, role: 'Who may be paid, and the stake behind them.' },
        { name: 'Reputation', address: ADDRESSES.reputation, role: 'Settled work raises how much one job may carry.' },
        { name: 'Disputes', address: ADDRESSES.oracleRegistry, role: 'Bonded resolvers rule on a contested delivery.' },
        { name: 'Governance delay', address: ADDRESSES.adminTimelock, role: 'Changes to the payment, dispute and credit contracts wait out a fixed delay.' },
        { name: 'USDG', address: ADDRESSES.usdg, role: 'The asset payments settle in. Transaction fees are paid in ETH, which is a different asset.' },
        { name: 'Fee account', address: ADDRESSES.treasury, role: 'Receives the settlement fee the escrow collects.' },
      ],
    },
  ];

  if (rwa) {
    groups.push({
      title: 'Stocks and treasury funds',
      rows: [
        { name: 'Asset registry', address: rwa.AssetRegistry, role: 'Which stock and treasury tokens a mandate may hold, and their price feeds.' },
        { name: 'Price guard', address: rwa.PriceGuard, role: 'Refuses a trade on a stale, paused or out-of-band price.' },
        { name: 'Stock purchases', address: rwa.StockSpendRouter, role: 'Buys an eligible stock token from a mandate within its slippage limit.' },
        { name: 'Treasury parking', address: rwa.TreasuryPark, role: 'Holds the idle part of a budget in a treasury fund and unparks it for payments.' },
        ...rwa.assets.map((asset) => ({ name: asset.symbol, address: asset.address, role: `${asset.kind === 'treasury' ? 'Treasury fund' : 'Stock'} token.` })),
      ],
    });
  }

  if (collateral) {
    groups.push({
      title: 'Collateral-backed credit',
      rows: [
        { name: 'Collateral vault', address: collateral.CollateralVault, role: 'Holds posted stock and treasury tokens and checks health before a draw.' },
        { name: 'Credit pool', address: collateral.CreditPool, role: 'Lends USDG against posted collateral. Bad debt is written off here.' },
      ],
    });
  }

  if (privacy) {
    groups.push({
      title: 'Private mandates',
      rows: [
        { name: 'Private mandate accounts', address: privacy.CommittedMandateFactory, role: 'Creates mandates whose terms are committed on chain and readable only with the owner’s key.' },
        ...(privacy.CommittedMandateFactoryV1Escrow
          ? [{ name: 'Private mandate accounts, first escrow', address: privacy.CommittedMandateFactoryV1Escrow, role: 'Creates private mandates that settle through the first escrow.' }]
          : []),
        { name: 'Payment proof verifier', address: privacy.WithinMandateVerifier, role: 'Checks that a private payment stays inside its committed terms.' },
        { name: 'Disclosure registry', address: privacy.DisclosureRegistry, role: 'Records what an owner has chosen to show a resolver.' },
        { name: 'Solvency log', address: privacy.SolvencyLog, role: 'Publishes proofs that private mandates hold what they owe.' },
      ],
    });
  }

  if (shielded) {
    groups.push({
      title: 'Shielded pool',
      rows: [
        { name: 'Shielded pool entry', address: shielded.Entrypoint, role: 'Takes deposits into the pool and approves withdrawals.' },
        { name: 'Shielded pool', address: shielded.ShieldedPool, role: 'Holds deposited USDG.' },
        { name: 'Shielded relay', address: shielded.ShieldedRelay, role: 'Pays a withdrawal to a mandate or a provider.' },
      ],
    });
  }

  groups.push({
    title: 'Token',
    rows: [
      { name: 'BRSR', address: TOKEN_ADDRESSES.BRSR, role: 'The token resolvers bond and stakers hold.' },
      { name: 'Staking', address: TOKEN_ADDRESSES.Staking, role: 'Holds staked BRSR and pays out the buyback and the spread on collateral-backed credit.' },
      { name: 'Vesting', address: TOKEN_ADDRESSES.Vesting, role: 'Holds the team grant for its term.' },
      { name: 'Buyback', address: TOKEN_ADDRESSES.Buyback, role: 'Turns fee revenue into BRSR for the staking pool.' },
      ...(sameAddress(TOKEN_ROLES.adminTimelock, ADDRESSES.adminTimelock)
        ? []
        : [{ name: 'Token governance delay', address: TOKEN_ROLES.adminTimelock, role: 'Changes to the token and staking wait out its delay.' }]),
    ],
  });

  return groups;
}

/**
 * What earlier contracts still hold, one row per kind, newest address first.
 *
 * Later records carried most contracts over at the same address, so a contract the live groups
 * already list is left out here: listing the live escrow again under "earlier" would say it no
 * longer takes payments. What remains still holds money or open work and is only read.
 */
export function earlierContracts(): readonly EarlierRow[] {
  const current = deployment();
  const live = new Set(contractGroups().flatMap((group) => group.rows.map((row) => row.address.toLowerCase())));
  const older = deploymentsForChain(CHAIN_ID).filter((d) => d.network !== current.network);

  return EARLIER_KINDS.map((kind) => {
    const seen = new Set<string>();
    const addresses = older
      .flatMap((d) => kind.pick(d))
      .filter((address): address is EvmAddress => address !== undefined)
      .filter((address) => {
        const key = address.toLowerCase();
        if (live.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return { name: kind.name, role: kind.role, addresses };
  }).filter((row) => row.addresses.length > 0);
}

const EARLIER_KINDS: readonly {
  readonly name: string;
  readonly role: string;
  readonly pick: (d: Deployment) => readonly (EvmAddress | undefined)[];
}[] = [
  { name: 'Mandate accounts', role: 'Created mandates that still hold their funds and history.', pick: (d) => [d.contracts.MandateAccountFactory] },
  { name: 'Escrow', role: 'Payments opened here are settled here until they close.', pick: (d) => [d.contracts.Escrow] },
  { name: 'Provider registry', role: 'Providers registered here, and the stake they posted.', pick: (d) => [d.contracts.AgentRegistry] },
  { name: 'Reputation', role: 'Scores earned here.', pick: (d) => [d.contracts.Reputation] },
  { name: 'Disputes', role: 'Disputes opened here are ruled on here until they close.', pick: (d) => [d.contracts.OracleRegistry] },
  { name: 'Governance delay', role: 'Changes to these contracts wait out its delay.', pick: (d) => [d.contracts.AdminTimelock] },
  { name: 'Treasury parking', role: 'What was parked here stays until it is unparked.', pick: (d) => [d.rwa?.TreasuryPark] },
  { name: 'Collateral vault', role: 'Collateral posted here stays until it is withdrawn.', pick: (d) => [d.rwa?.collateral?.CollateralVault] },
  { name: 'Credit pool', role: 'Debt drawn here stays until it is repaid.', pick: (d) => [d.rwa?.collateral?.CreditPool] },
  { name: 'Private mandate accounts', role: 'Created private mandates that still hold their funds.', pick: (d) => [d.privacy?.CommittedMandateFactory] },
  { name: 'Shielded pool', role: 'Deposits made here stay until they are withdrawn.', pick: (d) => [d.privacy?.shielded?.ShieldedPool] },
];

/** The three conditions a status page cannot read without a mandate, said rather than shown empty. */
const PER_MANDATE: readonly { readonly label: string; readonly text: string }[] = [
  { label: 'Mandate', text: 'Whether it is running, and what it can still spend in each window.' },
  { label: 'Permission', text: 'Whether the payee and the kind of work are on its lists.' },
  { label: 'Funding', text: 'USDG in the mandate for the payment, and ETH in the signer’s wallet for the fee.' },
];

function addressHeader(rows: readonly EarlierRow[]): string {
  return rows.some((row) => row.addresses.length > 1) ? 'Addresses, newest first' : 'Address';
}

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
  const example = exampleMandate();
  const earlier = earlierContracts();

  return (
    <div className="space-y-10">
      <Section
        title="Conditions right now"
        description="Five conditions decide whether an agent’s payment settles. Two apply to everyone and are read here. The other three belong to each mandate."
        actions={
          <Button size="sm" onClick={system.refresh} disabled={system.isFetching}>
            {system.isFetching ? 'Checking' : 'Check again'}
          </Button>
        }
      >
        <Card>
          <StatusList system={system} only={NETWORK_CONDITIONS} detailed />
        </Card>
        <ErrorSurface error={system.error} action="Reading the network" onRetry={system.refresh} />
        <Card title="On each mandate" description="Read on the mandate's own page, for the payment in front of it.">
          <dl className="grid gap-4 text-detail sm:grid-cols-3">
            {PER_MANDATE.map((entry) => (
              <div key={entry.label}>
                <dt className="text-label uppercase tracking-wide text-[color:var(--color-muted)]">{entry.label}</dt>
                <dd className="mt-1">{entry.text}</dd>
              </div>
            ))}
          </dl>
          {example !== undefined && (
            <p className="mt-4 text-detail">
              <Link href={`/console/${example}`} className="underline underline-offset-2">
                See all five on the example mandate
              </Link>
            </p>
          )}
        </Card>
        {system.snapshot && (
          <p className="text-note text-[color:var(--color-muted)]">
            Updated <Instant at={system.snapshot.readAt} relative /> at block {system.snapshot.blockNumber.toString()}.
          </p>
        )}
      </Section>

      <Section
        title="The issuer’s controls on USDG"
        description="The USDG issuer can pause the token or block an address, and either stops a payment. Both are read live from the token."
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
              A transfer also fails when either address is on the blocklist, whatever the balance or the mandate allows.
            </p>
            <p className="text-[color:var(--color-muted)]">
              Bursar does not control either one, and neither can be worked around. Both are read from the token at{' '}
              <span className="tabular break-all">{ADDRESSES.usdg}</span> each time this page refreshes, and shown above as
              their own condition.
            </p>
          </div>
        </Card>
      </Section>

      <Section title="Check an address" description="See whether the USDG issuer has blocked an address. Nothing is signed.">
        <Card>
          <div className="space-y-3">
            <label className="block text-detail">
              <span className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
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
                  Paste any address to check it against the live blocklist.
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
                        ? 'Blocked. USDG cannot move to or from this address, and no mandate can change that.'
                        : 'Not blocked. USDG can move to and from this address.'}
                  </span>
                </>
              )}
            </p>
          </div>
        </Card>
      </Section>

      <Section title="Contracts" description={`On ${RHC.name}, chain ID ${RHC.chainId}. Every address below is public.`}>
        {contractGroups().map((group) => (
          <Card key={group.title} title={group.title}>
            <Table
              caption={group.title}
              rows={group.rows}
              rowKey={(row) => row.address}
              columns={[
                { key: 'name', header: 'Contract', cell: (row) => <span className="font-medium">{row.name}</span> },
                { key: 'address', header: 'Address', cell: (row) => <Address value={row.address} /> },
                { key: 'role', header: 'What it does', secondary: true, cell: (row) => <span className="text-[color:var(--color-muted)]">{row.role}</span> },
              ]}
            />
          </Card>
        ))}
        {earlier.length > 0 && (
          <Card
            title="Earlier contracts"
            description="Still settling what was opened on them, and read by the console. New mandates use the contracts above."
          >
            <Table
              caption="Earlier contracts"
              rows={earlier}
              rowKey={(row) => row.name}
              columns={[
                { key: 'name', header: 'Contract', cell: (row) => <span className="font-medium">{row.name}</span> },
                {
                  key: 'addresses',
                  header: addressHeader(earlier),
                  cell: (row) => (
                    <span className="flex flex-col items-start gap-0.5">
                      {row.addresses.map((value) => (
                        <Address key={value} value={value} />
                      ))}
                    </span>
                  ),
                },
                { key: 'role', header: 'What it still does', secondary: true, cell: (row) => <span className="text-[color:var(--color-muted)]">{row.role}</span> },
              ]}
            />
          </Card>
        )}
      </Section>

      <Section title="Parameters" description="Live from the contracts.">
        <Card>
          <FieldGrid columns={3}>
            <Field label="Settlement fee" hint="Paid by the payee. Refunds, timeouts and cancellations return the payer's funds in full.">
              {escrow?.feeBps === undefined ? 'Reading' : bps(escrow.feeBps)}
            </Field>
            <Field label="Delivery window" hint="The deadlines a payer can choose from.">
              {escrow?.minTtl === undefined || escrow.maxTtl === undefined
                ? 'Reading'
                : `${spellDuration(Number(escrow.minTtl))} to ${spellDuration(Number(escrow.maxTtl))}`}
            </Field>
            <Field label="Time to contest" hint="After a payment, how long the payer has to challenge it.">
              {escrow?.disputeWindow === undefined ? 'Reading' : spellDuration(Number(escrow.disputeWindow))}
            </Field>
            <Field label="Cost of contesting" hint="A bond from whoever contests, returned if the ruling goes their way.">
              {escrow?.disputeBondBps === undefined ? 'Reading' : `${bps(escrow.disputeBondBps)} of the payment`}
            </Field>
            {escrow?.minLock !== undefined && (
              <Field label="Smallest payment" hint="The escrow refuses payments below this.">
                {usdExact(escrow.minLock)}
              </Field>
            )}
            <Field label="Governance delay" hint="Every setting change waits this long first.">
              {timelockPeriod === undefined ? 'Reading' : spellDuration(Number(timelockPeriod))}
            </Field>
            <Field label="Settlement asset" hint="Transaction fees are paid separately, in ETH.">
              {asset?.symbol === undefined || asset.decimals === undefined
                ? 'Reading'
                : `${asset.symbol}, ${asset.decimals} decimals`}
            </Field>
          </FieldGrid>
        </Card>
      </Section>

      <Section title="What a transaction costs" description="Measured from real transactions on this network.">
        <Card>
          <StatGrid columns={3}>
            <Stat label="One payment" value={formatEthApprox(ROUND_TRIP_FEE)} hint={`${ROUND_TRIP_GAS.toLocaleString('en-US')} gas to lock and release, at the observed price`} />
            <Stat label="One mandate account" value={formatEthApprox(DEPLOY_FEE)} hint={`${DEPLOY_GAS.toLocaleString('en-US')} gas to create an account at its computed address`} />
            <Stat
              label={`Fee on a ${usd(EXAMPLE_PAYMENT)} payment`}
              value={escrow?.feeBps === undefined ? '—' : usd(mulBps(EXAMPLE_PAYMENT, escrow.feeBps))}
              hint="Paid by the payee at settlement"
            />
          </StatGrid>
          <p className="mt-4 text-detail text-[color:var(--color-muted)]">
            Transaction fees are paid in ETH by the wallet that signs. Payments are made in USDG from the mandate
            account. These are separate balances, and funding one does not fund the other.
          </p>
        </Card>
      </Section>

      <Section title="Who can change what" description="The controls that exist, and where they sit.">
        <Card>
          <div className="space-y-3 text-sm">
            <p>
              The escrow&rsquo;s fee and windows are fixed for its lifetime. No key can raise the fee on an open payment
              or shorten a window on a job in progress.
            </p>
            <p>
              Settings that can change, including the reputation curve and the dispute settings, wait{' '}
              {timelockPeriod === undefined ? 'a fixed period' : spellDuration(Number(timelockPeriod))} before a change
              takes effect. Each change is public from the moment it is proposed, so anyone relying on the old value has
              that long to act.
            </p>
          </div>
        </Card>
      </Section>
    </div>
  );
}
