'use client';

import type { Address as AddressValue } from 'viem';

import { ADDRESSES, TOKEN_ADDRESSES, buybackAbi, isZeroAddress, sameAddress } from '@/chain';
import { collateralLane } from '@/chain/collateral';
import type { EscrowRead } from '@/chain';
import { Address } from '@/components/address';
import { Countdown, Instant } from '@/components/instant';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { formatDuration } from '@/lib';
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
      ? 'Whether the spread reaches stakers yet is being read.'
      : spreadNamed
      ? 'Spread swept from the credit pool is paid to stakers today.'
      : 'Until governance names the credit pool on the staking contract, spread collects in the credit pool and nothing is paid out. The proposal that names it is on the governance page.';

  // A control that is off says why it is off, and an unread contract is not the same answer as an
  // empty one. Nothing is claimed until the reading has landed.
  const now = Date.now();
  const { isKeeper, canTrigger, hold: holdReason } = buybackTrigger(buyback, data.account, data.token === undefined, now);
  const staleAt = ceilingStaleAt(buyback);
  const stale = staleAt !== undefined && staleAt.getTime() < now;
  const keeper = buyback?.keeper;
  const keeperNamed = keeper !== undefined && !isZeroAddress(keeper);

  return (
    <Section title="Where the revenue comes from and where it goes" description="Two charges, both in USDG, and both made today.">
      <Card title="The two lines">
        <FieldGrid columns={2}>
          <Field
            label="Settlement fee"
            hint="Charged on the payee's side of a settlement, with a floor at the measured gas cost of a settled call on this network, about 0.0019 USDG. Below that floor the facilitator pays to be used."
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
            hint="Charged only where an agent spends against posted collateral. Nothing else here borrows, and nothing else pays this."
          >
            A yearly rate on what is borrowed, rising with how much of the credit pool is lent out
          </Field>
        </FieldGrid>
        <p className="mt-4 max-w-3xl text-sm">
          The settlement fee accrues in USDG to the treasury the escrow already pays, at{' '}
          <Address value={ADDRESSES.treasury} />. The spread accrues in USDG inside the credit pool
          {lane && (
            <>
              {' '}at <Address value={lane.CreditPool} />
            </>
          )}
          , and a sweep sends it to the staking contract. {spreadState}
        </p>
      </Card>

      <Card title="The path to a staker" description="Two legs, because the two lines arrive in different assets. The first one takes three steps: the fee has to become BRSR before it reaches a share.">
        <ol className="space-y-4 text-sm">
          <li>
            <span className="font-medium">Settlement fee to the buyback.</span> Governance moves USDG from the treasury
            into the buyback contract. It is a transfer in and never an allowance out, so if every guard inside it
            failed at once the loss would stop at its own balance. The treasury behind it stays out of reach.
          </li>
          <li>
            <span className="font-medium">Buyback to the pool.</span> The contract spends that USDG on the BRSR/USDG pool,
            under a per-call size, a window cap and a price ceiling governance sets. Only the keeper governance names can
            trigger it, which stops anyone from wrapping a buy inside a transaction of their own. The keeper picks no
            amount, no price, no deadline and no recipient. A ceiling nobody has restated within its set age stops every
            buy until governance sets it again.
          </li>
          <li>
            <span className="font-medium">Pool to the staking contract.</span> What it bought is compounded into the
            staking pool. No new shares are minted, so each earning share is worth more BRSR than it was. Stake behind an
            exit request does not share in it.
          </li>
          <li>
            <span className="font-medium">Credit spread to the staking contract.</span> The spread is
            distributed in USDG and claimed per share. It arrives as the settlement asset because borrowers pay in the
            settlement asset.
          </li>
        </ol>
      </Card>

      <Card
        title="The buyback right now"
        description="Read from the contract."
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
            hint="What the keeper's next call would spend. Zero whenever that call would be refused, whatever the balance."
          >
            <span className="tabular">{buyback?.available === undefined ? unread : usdExact(buyback.available)}</span>
          </Field>
          <Field label="Price ceiling" hint="The most a buy pays for one whole BRSR. Zero refuses every buy.">
            <span className="tabular">
              {buyback === undefined ? unread : buyback.ceiling === 0n ? 'Unset' : `${usdExact(buyback.ceiling)} per BRSR`}
            </span>
          </Field>
          <Field label="Ceiling set" hint="Every change to the buyback's limits restates the ceiling and restarts its age.">
            {buyback?.ceilingSetAt === undefined ? unread : <Instant at={buyback.ceilingSetAt} />}
          </Field>
          <Field
            label={stale ? 'Stale since' : 'Usable until'}
            hint={
              buyback?.maxCeilingAge === undefined
                ? 'After this every buy is refused until governance sets the ceiling again.'
                : `A ceiling stays usable for ${formatDuration(Number(buyback.maxCeilingAge))} after it is set.`
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
          <Field label="Window cap" hint="The most that may be spent across one window.">
            <span className="tabular">{buyback === undefined ? unread : usdExact(buyback.maxSpendPerWindow)}</span>
          </Field>
          <Field label="Spent this window">
            <span className="tabular">{buyback?.spentThisWindow === undefined ? unread : usdExact(buyback.spentThisWindow)}</span>
          </Field>
          <Field label="Window opened">
            {buyback === undefined ? unread : <Instant at={buyback.windowStartsAt} />}
          </Field>
          <Field label="Earliest next buy" hint="A minimum interval stops a window's budget going in consecutive blocks.">
            {buyback === undefined ? unread : buyback.nextBuybackAt ? <Instant at={buyback.nextBuybackAt} /> : 'No buy has been made yet'}
          </Field>
          <Field label="Buyback contract">
            <Address value={TOKEN_ADDRESSES.Buyback} />
          </Field>
          <Field label="Pool manager" hint="Uniswap v4. The venue is fixed at deployment and governance cannot move it.">
            <Address value={TOKEN_ADDRESSES.PoolManager} />
          </Field>
          <Field label="Brake" hint="The guardian can stop this contract in the same block. Restarting it is a proposal.">
            {buyback?.paused === undefined ? unread : buyback.paused ? 'Paused' : 'Running'}
          </Field>
        </FieldGrid>

        {holdReason && <p className="mt-4 max-w-3xl text-detail text-[color:var(--color-muted)]">{holdReason}</p>}

        <p className="mt-4 max-w-3xl text-sm">
          The ceiling is not read from the pool during a trade, so a price pushed up in front of a buy cannot drag it
          along. It is a number governance restates, and it ages: once it passes the age above without being set again,
          the contract treats it as no price at all and refuses every buy.
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

