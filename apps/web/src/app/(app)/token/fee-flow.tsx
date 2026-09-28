'use client';


import { ADDRESSES, TOKEN_ADDRESSES, buybackAbi } from '@/chain';
import type { EscrowRead } from '@/chain';
import { Address } from '@/components/address';
import { Instant } from '@/components/instant';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { bps, usdExact } from '@/money';
import type { AnyState } from '@/state';

import type { TokenPageData } from './use-token-page';
import { useWriteContract } from '@/wallet/write';

/**
 * The path a fee takes from a settled call to a staker, with the state of each leg beside it.
 *
 * Two lines of revenue and two destinations. The buyback raises what a share is worth in BRSR;
 * the credit-lane spread would arrive as USDG a staker claims. Describing them as one number
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

  const canTrigger =
    buyback !== undefined && buyback.paused === false && buyback.available !== undefined && buyback.available > 0n;

  // A control that is off says why it is off. Each of these is a different answer to that, and
  // an unread contract is not the same answer as an empty one. Nothing is claimed until the
  // reading has landed, so a page still loading does not accuse the contract of silence.
  const holdReason = canTrigger || data.token === undefined
    ? undefined
    : buyback === undefined
    ? 'The buyback contract did not answer this reading, so a buy cannot be triggered from here until it does.'
    : buyback.paused === undefined
    ? 'Whether the buyback is paused could not be read, and a buy is refused while it is.'
    : buyback.paused
    ? 'The buyback is paused, so it cannot spend.'
    : buyback.available === undefined
    ? 'What a buy could spend could not be read, so the trigger stays off until the next reading lands.'
    : 'There is nothing to spend right now, so a buy would do nothing.';

  return (
    <Section title="Where the revenue comes from and where it goes" description="Two charges, both in USDG. One is being made today; the other waits on a credit lane governance has not named.">
      <Card title="The two lines">
        <FieldGrid columns={2}>
          <Field
            label="Facilitator fee"
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
            label="Credit-lane spread"
            hint="Charged only where an agent spends against posted collateral. Nothing outside that lane borrows, and nothing outside it pays this."
          >
            Set per credit line
          </Field>
        </FieldGrid>
        <p className="mt-4 max-w-3xl text-sm">
          The facilitator fee accrues in USDG to the treasury the escrow already pays, at{' '}
          <Address value={ADDRESSES.treasury} />. The spread would land at the same address in the same asset. Neither
          is invented for this page: they are the two charges the payment path was built to make, and only the first
          one is being made.
        </p>
      </Card>

      <Card title="The path to a staker" description="Two legs, because the two lines arrive in different assets. The first one takes three steps: the fee has to become BRSR before it reaches a share.">
        <ol className="space-y-4 text-sm">
          <li>
            <span className="font-medium">Facilitator fee to the buyback.</span> Governance moves USDG from the treasury
            into the buyback contract. It is a transfer in and never an allowance out, so if every guard inside it
            failed at once the loss would stop at its own balance. The treasury behind it stays out of reach.
          </li>
          <li>
            <span className="font-medium">Buyback to the pool.</span> The contract spends that USDG on the BRSR/USDG pool, under a per-call size, a window cap and a price floor governance sets. Anyone may trigger it. The
            caller picks no amount, no price, no deadline and no recipient, so triggering one is worth nothing beyond
            the gas it costs.
          </li>
          <li>
            <span className="font-medium">Pool to the staking contract.</span> What it bought is compounded into the
            staking pool. No new shares are minted, so each share outstanding is worth more BRSR than it was.
          </li>
          <li>
            <span className="font-medium">Credit-lane spread to the staking contract.</span> Once a lane exists, its
            spread is distributed in USDG and claimed per share. It arrives as the settlement asset because borrowers
            pay in the settlement asset.
          </li>
        </ol>
      </Card>

      <Card
        title="The buyback right now"
        description="Read from the contract."
        actions={
          <TxButton
            label="Trigger a buy"
            tone="secondary"
            disabled={!canTrigger}
            blockedBy={blockedBy}
            send={() => writeContractAsync({ address: TOKEN_ADDRESSES.Buyback, abi: buybackAbi, functionName: 'buyback' })}
            onConfirmed={data.refresh}
          />
        }
      >
        <FieldGrid columns={3}>
          <Field label="Available to spend" hint="What a call right now would spend, after the interval and the window cap.">
            <span className="tabular">{buyback?.available === undefined ? unread : usdExact(buyback.available)}</span>
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
          The BRSR/USDG pool has not been initialised, so there is nothing for a buy to trade against. The
          price floor in the contract is set where it refuses every trade. Governance sets a real one before the pool
          is seeded.
        </p>
      </Card>
    </Section>
  );
}
