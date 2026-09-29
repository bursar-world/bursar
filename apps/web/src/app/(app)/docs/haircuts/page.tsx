import type { Micro } from '@bursar/core';
import type { Metadata } from 'next';
import Link from 'next/link';

import { formatRatio, readHaircutSchedule } from '@/chain/collateral';
import type { HaircutSchedule, HaircutTier } from '@/chain/collateral';
import { Address } from '@/components/address';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { bps, usd } from '@/money';

export const metadata: Metadata = {
  title: 'Collateral haircuts · BURSAR',
  description: 'The haircut tiers, borrowing floor and liquidation terms of the collateral lane, read from Robinhood Chain.',
};

/** Read from chain on the server, then kept for five minutes. */
export const revalidate = 300;

export default async function HaircutsPage() {
  let schedule: HaircutSchedule | undefined;
  let problem: string | undefined;
  try {
    schedule = await readHaircutSchedule();
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className="space-y-10">
      <Section
        title="Collateral haircuts"
        description="A mandate in the collateral lane can borrow USDG against stock and treasury tokens it has posted. Each token counts at its market price less a haircut, and the haircut is wider outside market hours. Every figure on this page is read from the contracts."
      >
        {schedule === undefined ? (
          <Card>
            <p className="text-sm">
              {problem === undefined
                ? 'The collateral lane is not deployed on this network.'
                : 'The contracts could not be read just now. The page tries again within five minutes.'}
            </p>
          </Card>
        ) : (
          <Tiers schedule={schedule} />
        )}
      </Section>

      {schedule !== undefined && <Terms schedule={schedule} />}
    </div>
  );
}

function Tiers({ schedule }: { readonly schedule: HaircutSchedule }) {
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Haircut tiers</caption>
          <thead>
            <tr className="border-b border-[color:var(--color-line-strong)] text-left">
              <th scope="col" className="py-2 pr-4">Tier</th>
              <th scope="col" className="py-2 pr-4 text-right">Market hours</th>
              <th scope="col" className="py-2 pr-4 text-right">After hours</th>
              <th scope="col" className="py-2">Assets</th>
            </tr>
          </thead>
          <tbody>
            {schedule.tiers.map((tier) => (
              <TierRow key={tier.index} tier={tier} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-note text-[color:var(--color-muted)]">
        Contracts: vault <Address value={schedule.lane.CollateralVault} />, lending pool <Address value={schedule.lane.CreditPool} />.
        {schedule.chainTime !== undefined && ` Read at ${schedule.chainTime.toISOString().replace('T', ' ').slice(0, 16)} UTC.`}
      </p>
    </Card>
  );
}

function TierRow({ tier }: { readonly tier: HaircutTier }) {
  return (
    <tr className="border-b border-[color:var(--color-line)] align-top">
      <td className="py-3 pr-4 font-medium">
        {tier.index}. {tier.name}
      </td>
      <td className="tabular py-3 pr-4 text-right">{bps(tier.sessionHaircutBps)}</td>
      <td className="tabular py-3 pr-4 text-right">{bps(tier.afterHoursHaircutBps)}</td>
      <td className="py-3">
        {tier.assets.length === 0 ? (
          <span className="text-[color:var(--color-muted)]">None</span>
        ) : (
          <ul className="space-y-1">
            {tier.assets.map((asset) => (
              <li key={asset.address}>
                <span className="font-medium">{asset.symbol}</span> <Address value={asset.address} />
                {asset.haircutBps !== undefined && (
                  <span className="text-note text-[color:var(--color-muted)]">
                    {' '}
                    now {bps(asset.haircutBps)}
                    {asset.afterHours ? ', after hours' : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

function Terms({ schedule }: { readonly schedule: HaircutSchedule }) {
  const { terms, pool } = schedule;
  const sessionHours = hoursOf(schedule.tiers[0]?.sessionStaleness);
  const valuationHours = hoursOf(schedule.tiers[0]?.valuationStaleness);

  return (
    <Section title="How a position is valued and protected" description="The rules the vault applies to every position, in the order they matter.">
      <Card>
        <ul className="max-w-3xl list-disc space-y-3 pl-5 text-sm">
          <li>Each token counts at its amount times its Chainlink price. The price already includes the token&rsquo;s distributions, so nothing is added on top.</li>
          <li>
            A price older than {valuationHours ?? 'the valuation bound'} or a paused price feed counts the position as zero. Borrowing against it
            stops, and any sale of it waits for a fresh price.
          </li>
          <li>
            After hours means outside the US equities 24/5 session (Monday 01:00 UTC to Saturday 00:00 UTC), or any time a price has not
            updated for {sessionHours ?? 'a day'}, which covers exchange holidays. The after-hours haircut then applies and health drops.
          </li>
          {terms !== undefined && (
            <>
              <li>
                Health is collateral value after haircuts divided by debt. A payment can borrow only while health stays at or above{' '}
                {formatRatio(terms.minBorrowHealth)}, and collateral can be withdrawn on the same condition.
              </li>
              <li>
                Below 1.00, anyone can sell part of one asset through its pinned Uniswap pool to repay the debt. The sale stops at the slice that
                brings health back to {formatRatio(terms.liquidationTarget)}, and the seller keeps {bps(terms.bountyBps)} of the proceeds.
              </li>
            </>
          )}
          <li>Only a mandate in the collateral lane can borrow. A prefunded mandate spends the USDG it holds and nothing more.</li>
        </ul>
      </Card>

      <Card>
        <FieldGrid columns={3}>
          <Field label="Credit limit, all mandates" hint="Most the lane lends in total.">
            <span className="tabular">{pool.totalDebtCap === undefined ? 'Unread' : usd(pool.totalDebtCap as Micro)}</span>
          </Field>
          <Field label="Credit limit, one mandate" hint="Most any single mandate can owe.">
            <span className="tabular">{pool.perMandateCap === undefined ? 'Unread' : usd(pool.perMandateCap as Micro)}</span>
          </Field>
          <Field label="Borrowed now" hint="Across every mandate, spread included.">
            <span className="tabular">{pool.totalDebt === undefined ? 'Unread' : usd(pool.totalDebt as Micro)}</span>
          </Field>
          <Field label="Available to lend" hint="USDG in the pool that is not owed to stakers.">
            <span className="tabular">{pool.cash === undefined ? 'Unread' : usd(pool.cash as Micro)}</span>
          </Field>
          <Field label="Spread" hint="A year's rate on borrowed USDG. It rises as more of the pool is lent out.">
            <span className="tabular">
              {pool.rateBps === undefined ? 'Unread' : `${bps(Number(pool.rateBps))} a year`}
              {pool.utilisationBps !== undefined && (
                <span className="block text-note text-[color:var(--color-muted)]">{bps(Number(pool.utilisationBps))} of the pool lent</span>
              )}
            </span>
          </Field>
          <Field label="Where the spread goes" hint="Paid to BRSR stakers as USDG.">
            {pool.spreadLive === undefined
              ? 'Unread'
              : pool.spreadLive
                ? `To stakers. ${pool.spreadPaid === undefined ? '' : `${usd(pool.spreadPaid as Micro)} paid so far.`}`
                : 'Held in the lending pool until the staking contract is set to accept it, then paid to stakers.'}
          </Field>
        </FieldGrid>
        <p className="mt-4 text-note text-[color:var(--color-muted)]">
          Collateral lending carries its own debt and liquidation risk. See the <Link href="/docs" className="underline underline-offset-2">developer docs</Link> for how a mandate borrows.
        </p>
      </Card>
    </Section>
  );
}

function hoursOf(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds === 0) return undefined;
  return `${Math.round(seconds / 3600)} hours`;
}
