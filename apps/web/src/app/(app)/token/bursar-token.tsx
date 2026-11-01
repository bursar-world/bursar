import { RHC } from '@/chain';
import { Address } from '@/components/address';
import { Chevron } from '@/components/button';
import { Card, Section } from '@/components/layout';
import { BURSAR_TOKEN } from '@/site';

/**
 * The token surface: $BURSAR, where it lives and where it trades.
 *
 * The staking, fee-flow and bonding sections beside this file read the earlier BRSR contracts. They
 * stay off the page until those contracts take $BURSAR.
 */
export function BursarTokenView() {
  return (
    <div className="space-y-10">
      <Section title={`$${BURSAR_TOKEN.symbol}`} description="Bursar’s token, live on Robinhood Chain.">
        <Card>
          <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-[9rem_1fr]">
            <dt className="text-[color:var(--color-muted)]">Contract</dt>
            <dd className="min-w-0">
              <Address value={BURSAR_TOKEN.address} full />
            </dd>
            <dt className="text-[color:var(--color-muted)]">Network</dt>
            <dd>
              {RHC.name}, chain {RHC.chainId}
            </dd>
            <dt className="text-[color:var(--color-muted)]">Supply</dt>
            <dd>
              {BURSAR_TOKEN.supply} {BURSAR_TOKEN.symbol}. The contract has no mint.
            </dd>
          </dl>
          <div className="mt-6">
            <a href={BURSAR_TOKEN.tradeHref} target="_blank" rel="noreferrer" data-tone="primary" className="action inline-flex min-h-11 text-note">
              <span className="action-label px-5 py-2">
                <span>Trade on Pons</span>
              </span>
              <span className="action-square w-11">
                <Chevron size={17} />
              </span>
            </a>
          </div>
          <p className="mt-6 max-w-3xl text-sm text-[color:var(--color-muted)]">
            $BURSAR is not a deposit, a share, or a claim on Robinhood, Robinhood Chain, Paxos or USDG, and none of them
            endorses it.
          </p>
        </Card>
      </Section>
    </div>
  );
}
