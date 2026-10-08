'use client';

import Link from 'next/link';

import { RHC } from '@/chain';
import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { Instant } from '@/components/instant';
import { Card, Section } from '@/components/layout';
import { NETWORK_CONDITIONS, StatusStrip, Unread } from '@/components/status';
import { useSystemState } from '@/state';

import { BondingSection } from './bonding';
import { FeeFlowSection } from './fee-flow';
import { StakingSection } from './staking';
import { SupplySection } from './supply';
import { useTokenPage } from './use-token-page';

/**
 * The token surface.
 *
 * Every write on this page moves value, and the asset it moves can be paused or an address blocked
 * out of it by its issuer. So the five conditions are read alongside the token state and handed to
 * each transaction control. A staking button here names the asset as the problem before the wallet
 * ever opens.
 */
export function TokenView() {
  const data = useTokenPage();
  const system = useSystemState();
  const blockedBy = [system.connectivity, system.asset];
  const partial = (data.token !== undefined && !data.token.complete) || (data.extras !== undefined && !data.extras.complete);

  return (
    <div className="space-y-10">
      <Section
        title="$BRSR"
        description="Resolvers bond BRSR to rule on disputes, and stakers put it behind collateral-backed credit."
        actions={
          <Button size="sm" onClick={data.refresh} disabled={data.isFetching}>
            {data.isFetching ? 'Reading' : 'Read again'}
          </Button>
        }
      >
        <Card>
          <StatusStrip system={system} only={NETWORK_CONDITIONS} />
          <p className="mt-4 max-w-3xl text-sm">
            BRSR is not a deposit, a share, or a claim on Robinhood, Robinhood Chain, Paxos or USDG, and none of them
            endorses it. Outside collateral-backed credit, nothing here lends, borrows or pays interest.
          </p>
          {data.extras && (
            <p className="mt-3 text-note text-[color:var(--color-muted)]">
              Updated <Instant at={data.extras.readAt} relative />
              {data.extras.blockNumber !== undefined && <> at block {data.extras.blockNumber.toString()}</>} on{' '}
              {RHC.name}.
            </p>
          )}
        </Card>
        {partial && (
          <Unread onRetry={data.refresh}>
            Part of this page could not be read right now. A figure marked Not read is unknown, not zero.
          </Unread>
        )}
        <ErrorSurface error={data.error} action="Reading the token" onRetry={data.refresh} />
      </Section>

      <SupplySection data={data} blockedBy={blockedBy} />
      <FeeFlowSection data={data} escrow={system.snapshot?.escrow} blockedBy={blockedBy} />
      <StakingSection data={data} blockedBy={blockedBy} />
      <BondingSection data={data} />

      <Section title="Governance" description="Every token setting on this page changes only by governance proposal: two of three signatures, then a delay.">
        <Card>
          <p className="max-w-3xl text-sm">
            Proposals set the rebate tiers, the bond floor, the buyback&rsquo;s limits, keeper and ceiling age, and the
            staking contract&rsquo;s credit manager, slasher, slash cap and exit windows. The governance page shows
            pending proposals, who has approved them, and when each can run.
          </p>
          <div className="mt-4">
            <Link href="/governance" className="text-sm font-medium underline underline-offset-4">
              Open governance
            </Link>
          </div>
        </Card>
      </Section>
    </div>
  );
}

