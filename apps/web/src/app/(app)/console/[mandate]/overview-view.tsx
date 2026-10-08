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
import { OwedPanel } from './owed-panel';
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
        description="Every payment from this agent has to clear these five conditions."
      >
        <Card>
          <StatusList system={system} detailed />
        </Card>
        {system.snapshot && (
          <p className="text-note text-[color:var(--color-muted)]">
            Updated <Instant at={system.snapshot.readAt} relative />.
          </p>
        )}
      </Section>

      <SpendPanel />
      <ProposedPayment />
      <FundingPanel />
      <OwedPanel />
      <StockPanel />
      <ParkPanel />
      <CollateralPanel />
      <GatesPanel />
      <ControlPanel />

      <Section
        title="Recent activity"
        description="The latest payments and changes on this mandate."
        actions={
          <Link href={`/console/${address}/settlements`} className="text-detail underline underline-offset-2">
            All settlements
          </Link>
        }
      >
        <Card>
          {ledger.timelineError ? (
            <ErrorSurface error={ledger.timelineError} action="Reading the history" onRetry={ledger.refresh} />
          ) : (
            <ActivityList events={ledger.events} limit={8} />
          )}
        </Card>
      </Section>

      <Section title="Addresses" description="The accounts this mandate works with.">
        <Card>
          <FieldGrid columns={2}>
            <Field label="Owner" hint="Sets the limits and can withdraw at any time.">
              {account ? <AddressView value={account.principal} /> : 'Reading'}
            </Field>
            <Field label="Escrow" hint="Holds each payment until the provider delivers or the deadline passes.">
              {account ? <AddressView value={account.escrow} /> : 'Reading'}
            </Field>
            <Field
              label="Settlement asset"
              hint="Providers are paid in this. Network fees are paid in ETH."
            >
              {account ? <AddressView value={account.settlementAsset} /> : 'Reading'}
            </Field>
            <Field label="Mandate document" hint="A fingerprint of the written terms, for your records.">
              {account && account.documentHash !== '0x' && !/^0x0+$/.test(account.documentHash) ? (
                <span className="tabular break-all text-detail">{account.documentHash}</span>
              ) : (
                'None'
              )}
            </Field>
          </FieldGrid>
        </Card>
      </Section>
    </div>
  );
}
