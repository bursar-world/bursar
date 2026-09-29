'use client';

import Link from 'next/link';

import { Address as AddressView } from '@/components/address';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { ErrorSurface } from '@/components/error-surface';
import { Instant } from '@/components/instant';
import { StatusList } from '@/components/status';
import { ActivityList } from './activity-list';
import { CollateralPanel } from './collateral-panel';
import { ControlPanel } from './control-panel';
import { FundingPanel } from './funding-panel';
import { GatesPanel } from './gates-panel';
import { ParkPanel } from './park-panel';
import { ProposedPayment } from './proposed-payment';
import { SpendPanel } from './spend-panel';
import { StockPanel } from './stock-panel';
import { useMandateScope } from './mandate-scope';

/** The mandate at a glance: what stands in the way, what is left, what it holds, and who it pays. */
export function OverviewView() {
  const { address, account, system, ledger } = useMandateScope();

  return (
    <div className="space-y-10">
      <Section
        title="Current conditions"
        description="Five conditions stand between this agent and a settled payment. Each has a different owner, so each is reported on its own."
      >
        <Card>
          <StatusList system={system} detailed />
        </Card>
        {system.snapshot && (
          <p className="text-note text-[color:var(--color-muted)]">
            Read <Instant at={system.snapshot.readAt} relative /> at block{' '}
            {system.snapshot.blockNumber.toString()}, in{' '}
            {system.snapshot.calls} contract reads and one request.
          </p>
        )}
      </Section>

      <SpendPanel />
      <ProposedPayment />
      <FundingPanel />
      <StockPanel />
      <ParkPanel />
      <CollateralPanel />
      <GatesPanel />
      <ControlPanel />

      <Section
        title="Recent activity"
        description="Written by the account itself."
        actions={
          <Link href={`/console/${address}/settlements`} className="text-detail underline underline-offset-2">
            All settlements
          </Link>
        }
      >
        <Card>
          {ledger.timelineError ? (
            <ErrorSurface error={ledger.timelineError} action="Reading the history" onRetry={ledger.refresh}>
              <p className="mt-1 text-detail text-[color:var(--color-muted)]">
                Everything above still comes from the contracts and is current. Only the timeline is missing.
              </p>
            </ErrorSurface>
          ) : (
            <ActivityList events={ledger.events} limit={8} />
          )}
        </Card>
      </Section>

      <Section title="Wiring" description="Every address below comes out of the account's own storage.">
        <Card>
          <FieldGrid columns={2}>
            <Field label="Owner" hint="Writes the limits and can take the funds back at any time.">
              {account ? <AddressView value={account.principal} /> : 'Reading'}
            </Field>
            <Field label="Escrow" hint="Holds each payment until the provider delivers or the deadline passes.">
              {account ? <AddressView value={account.escrow} /> : 'Reading'}
            </Field>
            <Field
              label="Settlement asset"
              hint="What providers are paid in. Transaction fees are a different asset and are paid in ETH."
            >
              {account ? <AddressView value={account.settlementAsset} /> : 'Reading'}
            </Field>
            <Field label="Mandate document" hint="The hash of the terms this account enforces. The contract never reads it; an auditor does.">
              {account && account.documentHash !== '0x' && !/^0x0+$/.test(account.documentHash) ? (
                <span className="tabular break-all text-detail">{account.documentHash}</span>
              ) : (
                'Not anchored'
              )}
            </Field>
          </FieldGrid>
        </Card>
      </Section>
    </div>
  );
}
