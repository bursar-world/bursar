'use client';

import Link from 'next/link';

import { RHC } from '@/chain';
import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { Instant } from '@/components/instant';
import { Card, Section } from '@/components/layout';
import { StatusStrip, Unread } from '@/components/status';
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
        description="The bond a resolver posts to rule on a dispute, and the stake that covers first losses on collateral-backed credit and earns its spread and the BRSR the buyback buys."
        actions={
          <Button size="sm" onClick={data.refresh} disabled={data.isFetching}>
            {data.isFetching ? 'Reading' : 'Read again'}
          </Button>
        }
      >
        <Card>
          <StatusStrip system={system} />
          <p className="mt-4 max-w-3xl text-sm">
            BRSR is not a claim on Robinhood, on Robinhood Chain, on Paxos or on USDG, and none of them endorses this. It is not a deposit and it is
            not a share. Debt in this system exists only in collateral-backed credit, so nothing here
            lends, borrows or pays interest outside it.
          </p>
          {data.extras && (
            <p className="mt-3 text-note text-[color:var(--color-muted)]">
              Read <Instant at={data.extras.readAt} relative />
              {data.extras.blockNumber !== undefined && <> at block {data.extras.blockNumber.toString()}</>} on{' '}
              {RHC.name}.
            </p>
          )}
        </Card>
        {partial && (
          <Unread onRetry={data.refresh}>
            Some of these contracts did not answer this reading. Anything below that shows as not read is unknown, and
            unknown is not zero. Nothing has changed on chain; only the reading failed.
          </Unread>
        )}
        <ErrorSurface error={data.error} action="reading the token contracts" onRetry={data.refresh} />
      </Section>

      <SupplySection data={data} blockedBy={blockedBy} />
      <FeeFlowSection data={data} escrow={system.snapshot?.escrow} blockedBy={blockedBy} />
      <StakingSection data={data} blockedBy={blockedBy} />
      <BondingSection data={data} />

      <Section title="Governance" description="Every token parameter named on this page is behind a two-of-three signature and a governance delay.">
        <Card>
          <p className="max-w-3xl text-sm">
            The tier table, the bond floor, the buyback&rsquo;s limits, its keeper and how long its ceiling stays usable,
            and the staking contract&rsquo;s credit manager, slasher, slash cap and exit windows are all set by proposal.
            Pending proposals, who has approved them, each delay and when each proposal becomes executable are on the
            governance page.
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

