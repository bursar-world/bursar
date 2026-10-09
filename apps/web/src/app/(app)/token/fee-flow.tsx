'use client';

import type { Address as AddressValue } from 'viem';

import { ADDRESSES, TOKEN_ADDRESSES, buybackAbi, isZeroAddress, sameAddress } from '@/chain';
import { collateralLane } from '@/chain/collateral';
import type { EscrowRead } from '@/chain';
import { Address } from '@/components/address';
import { Countdown, Instant } from '@/components/instant';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { spellDuration } from '@/lib';
import { bps, usdExact } from '@/money';
import type { AnyState } from '@/state';

import { tokenFailure } from './refusal';
import { buybackTrigger, ceilingStaleAt } from './state';
import type { TokenPageData } from './use-token-page';
import { useWriteContract } from '@/wallet/write';

/**
 * The path a fee takes from a settled call to a staker, with the state of each leg beside it.
 *
 * Two lines of revenue and two destinations. The buyback raises what a share is worth in BRSR;
 * the spread on collateral-backed credit arrives as USDG a staker claims, once Staking names the credit pool. Describing them as one number
 * would be describing a yield.
 */
export function FeeFlowSection({
  data,
  escrow,
  blockedBy,
}: {
  readonly data: TokenPageData;
  readonly escrow: EscrowRead | undefined;
  readonly blockedBy: readonly AnyState[];
}) {
  const buyback = data.token?.buyback;
  const { writeContractAsync } = useWriteContract();
  const unread = data.token === undefined ? 'Reading' : 'Not read';
  const lane = collateralLane();
  const manager = data.extras?.creditManager;
  const spreadNamed = manager !== undefined && !isZeroAddress(manager) && lane !== undefined && sameAddress(manager, lane.CreditPool);
  const spreadState =
    manager === undefined
      ? 'Reading whether the spread is paid to stakers.'
      : spreadNamed
      ? 'Spread swept from the credit pool is paid to stakers today.'
      : 'Spread collects in the credit pool and is not paid out until governance names the pool on the staking contract. That proposal is on the governance page.';

  // A control that is off says why it is off, and an unread contract is not the same answer as an
  // empty one. Nothing is claimed until the reading has landed.
  const now = Date.now();
  const { isKeeper, canTrigger, hold: holdReason } = buybackTrigger(buyback, data.account, data.token === undefined, now);
  const staleAt = ceilingStaleAt(buyback);
  const stale = staleAt !== undefined && staleAt.getTime() < now;
  const keeper = buyback?.keeper;
  const keeperNamed = keeper !== undefined && !isZeroAddress(keeper);

  return (
    <Section title="Where the revenue comes from and where it goes" description="Two charges, both in USDG and both live today.">
      <Card title="The two lines">
        <FieldGrid columns={2}>
          <Field
            label="Settlement fee"
            hint="Paid by the payee on each settlement, never less than about 0.0019 USDG, the network cost of settling."
          >
            {escrow === undefined ? (
              'Reading'
            ) : escrow.feeBps === undefined ? (
              'Not read'
            ) : (
              <span className="tabular">{bps(escrow.feeBps)} of the amount</span>
            )}
          </Field>
          <Field
            label="Spread on collateral-backed credit"
            hint="Charged only when an agent spends against posted collateral."
          >
            A yearly rate on what is borrowed, rising with how much of the credit pool is lent out
          </Field>
        </FieldGrid>
        <p className="mt-4 max-w-3xl text-sm">
          Settlement fees collect in USDG in the treasury at <Address value={ADDRESSES.treasury} />. The spread
          collects in USDG in the credit pool
          {lane && (
            <>
              {' '}at <Address value={lane.CreditPool} />
            </>
          )}
          , then a sweep sends it to the staking contract. {spreadState}
        </p>
      </Card>

      <Card title="The path to a staker" description="Settlement fees reach stakers as BRSR through the buyback, and the credit spread reaches them in USDG.">
        <ol className="space-y-4 text-sm">
          <li>
            <span className="font-medium">Settlement fee to the buyback.</span> Governance transfers USDG from the
            treasury into the buyback contract. The buyback holds only what it is sent and has no access to the treasury.
          </li>
          <li>
            <span className="font-medium">Buyback to the pool.</span> The contract buys BRSR on the BRSR/USDG pool,
            within a size per call, a cap per window and a price ceiling set by governance. Only the keeper governance
            names can trigger a buy, and the keeper chooses no amount, price, deadline or recipient. If the ceiling is not
            renewed in time, buying stops until governance sets it again.
          </li>
          <li>
            <span className="font-medium">Pool to the staking contract.</span> What it buys is added to the staking
            pool without minting new shares, so each earning share holds more BRSR. Stake waiting to exit does not share
            in it.
          </li>
          <li>
            <span className="font-medium">Credit spread to the staking contract.</span> The spread is paid in USDG,
            the currency borrowers pay in, and claimed per share.
          </li>
        </ol>
      </Card>

      <Card
        title="The buyback right now"
        description="Live from the buyback contract."
        actions={
          isKeeper ? (
            <TxButton
              label="Trigger a buy"
              tone="secondary"
              disabled={!canTrigger}
              blockedBy={blockedBy}
              send={() =>
                writeContractAsync({ address: TOKEN_ADDRESSES.Buyback, abi: buybackAbi, functionName: 'buyback' }).catch(
                  (caught: unknown) => {
                    throw tokenFailure(caught, { action: 'Trigger a buy', contract: 'buyback' });
                  },
                )
              }
              onConfirmed={data.refresh}
            />
          ) : undefined
        }
      >
        <FieldGrid columns={3}>
          <Field
            label="Available to spend"
            hint="What the next buy would spend. Zero when a buy would be refused."
          >
            <span className="tabular">{buyback?.available === undefined ? unread : usdExact(buyback.available)}</span>
          </Field>
          <Field label="Price ceiling" hint="The most a buy pays for one whole BRSR. Zero refuses every buy.">
            <span className="tabular">
              {buyback === undefined ? unread : buyback.ceiling === 0n ? 'Unset' : `${usdExact(buyback.ceiling)} per BRSR`}
            </span>
          </Field>
          <Field label="Ceiling set" hint="Any change to the buyback's limits resets the ceiling's age.">
            {buyback?.ceilingSetAt === undefined ? unread : <Instant at={buyback.ceilingSetAt} />}
          </Field>
          <Field
            label={stale ? 'Stale since' : 'Usable until'}
            hint={
              buyback?.maxCeilingAge === undefined
                ? 'After this every buy is refused until governance sets the ceiling again.'
                : `A ceiling stays usable for ${spellDuration(Number(buyback.maxCeilingAge))} after it is set.`
            }
          >
            {staleAt === undefined ? unread : stale ? <Instant at={staleAt} /> : <Countdown to={staleAt} />}
          </Field>
          <Field label="Keeper" hint="The only address that can trigger a buy.">
            {keeper === undefined ? unread : keeperNamed ? <KeeperLabel keeper={keeper} you={isKeeper} /> : 'None named'}
          </Field>
          <Field label="Size per call" hint="The most one buy may spend.">
            <span className="tabular">{buyback === undefined ? unread : usdExact(buyback.spendPerCall)}</span>
          </Field>
          <Field label="Window cap" hint="The most that can be spent in one window.">
            <span className="tabular">{buyback === undefined ? unread : usdExact(buyback.maxSpendPerWindow)}</span>
          </Field>
          <Field label="Spent this window">
            <span className="tabular">{buyback?.spentThisWindow === undefined ? unread : usdExact(buyback.spentThisWindow)}</span>
          </Field>
          <Field label="Window opened">
            {buyback === undefined ? unread : <Instant at={buyback.windowStartsAt} />}
          </Field>
          <Field label="Earliest next buy" hint="A minimum gap between buys spreads each window's budget out.">
            {buyback === undefined ? unread : buyback.nextBuybackAt ? <Instant at={buyback.nextBuybackAt} /> : 'No buys yet'}
          </Field>
          <Field label="Buyback contract">
            <Address value={TOKEN_ADDRESSES.Buyback} />
          </Field>
          <Field label="Pool manager" hint="Uniswap v4. The venue is fixed, and governance cannot change it.">
            <Address value={TOKEN_ADDRESSES.PoolManager} />
          </Field>
          <Field label="Brake" hint="The guardian can pause it at once. Restarting it takes a governance proposal.">
            {buyback?.paused === undefined ? unread : buyback.paused ? 'Paused' : 'Running'}
          </Field>
        </FieldGrid>

        {holdReason && <p className="mt-4 max-w-3xl text-detail text-[color:var(--color-muted)]">{holdReason}</p>}

        <p className="mt-4 max-w-3xl text-sm">
          Governance sets the ceiling directly, so a price pushed up just before a buy cannot raise it. If it is not set
          again within the age above, the contract refuses every buy.
        </p>
      </Card>
    </Section>
  );
}

function KeeperLabel({ keeper, you }: { readonly keeper: AddressValue; readonly you: boolean }) {
  return (
    <>
      <Address value={keeper} />
      {you && <span className="ml-2 text-detail text-[color:var(--color-muted)]">This wallet</span>}
    </>
  );
}

