'use client';

import type { Address } from 'viem';

import { oracleRegistryAbi } from '@/chain';
import { Address as AddressLine } from '@/components/address';
import { Card, Field, FieldGrid } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { bps, usdExact } from '@/money';
import type { AnyState } from '@/state';

import type { ResolverDesk } from './desk';
import { resolverFailure } from './refusal';
import { useWriteContract } from '@/wallet/write';

/**
 * A cent. Splitting a fee three ways leaves a millionth of a dollar behind on most rulings, and a
 * sweep costs more gas than that. Below this the remainder is left to collect, not put in front of
 * every resolver as a task.
 */
const SWEEP_FLOOR = 10_000n;

/**
 * What ruling has paid, and the two calls that move it.
 *
 * Rewards arrive in the settlement asset because they are a cut of a settlement denominated in it.
 * Bonds are BRSR and the two balances never touch, so nothing here can reach a bond and nothing a
 * bond does can reach this. Payment is pulled, never pushed: a resolver that cannot receive tokens
 * must not be able to hold up the settlement of a dispute it voted in.
 */
export function RewardsPanel({
  desk,
  account,
  blockedBy,
  onDone,
}: {
  readonly desk: ResolverDesk | undefined;
  readonly account: Address | undefined;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const standing = desk?.standing;
  const registry = desk?.registry;
  const unread = desk === undefined ? 'Reading' : 'Not read';

  const claimable = standing?.rewards;
  const unallocated = desk?.unallocatedRewards;

  return (
    <Card
      title="What ruling pays"
      description="The resolver fee on each ruling, split between the scores that held."
    >
      <div className="space-y-4">
        <FieldGrid columns={3}>
          <Field label="Yours to claim" hint="Earned on settled disputes, paid in USDG.">
            <span className="tabular">{claimable === undefined ? (account === undefined ? 'No wallet' : unread) : usdExact(claimable)}</span>
          </Field>
          <Field label="The resolver fee" hint="Taken from each settlement the panel rules on.">
            <span className="tabular">{desk?.resolverFeeBps === undefined ? unread : bps(desk.resolverFeeBps)}</span>
          </Field>
          <Field label="Reward asset" hint="The same USDG the settlement was paid in.">
            {desk?.rewardAsset === undefined ? unread : <AddressLine value={desk.rewardAsset} label="USDG" />}
          </Field>
        </FieldGrid>

        <p className="text-sm">
          When a dispute is ruled on, the resolver fee is split evenly between the resolvers whose revealed scores
          held. Unrevealed and outlying scores earn nothing, the same test that decides slashing. A dispute closed
          without a ruling pays no one. There is no fixed rate. What you receive depends on how many disputes are
          opened and ruled on.
        </p>

        {account !== undefined && registry !== undefined && (
          <TxButton
            label="Claim"
            disabled={claimable === undefined || claimable === 0n}
            blockedBy={blockedBy}
            send={() =>
              writeContractAsync({
                address: registry,
                abi: oracleRegistryAbi,
                functionName: 'claimRewards',
              }).catch((caught: unknown) => {
                throw resolverFailure(caught, { action: 'Claim rewards' });
              })
            }
            onConfirmed={onDone}
          />
        )}

        {account !== undefined && claimable === 0n && (
          <p className="text-detail text-[color:var(--color-muted)]">
            Nothing to claim yet. Rewards arrive when a dispute you ruled on settles, and stay claimable after you leave
            the bench.
          </p>
        )}

        {unallocated !== undefined && unallocated >= SWEEP_FLOOR && registry !== undefined && (
          <div className="space-y-2 border-t border-[color:var(--color-line)] pt-4">
            <p className="text-sm">
              {usdExact(unallocated)} in resolver fees went to no resolver. That happens when a dispute closes without a
              ruling, or when a fee is too small to divide between the resolvers. It belongs to the slash sink
              {desk?.slashSink === undefined ? '' : ' at the address below'}, and anyone can send it there.
            </p>
            {desk?.slashSink !== undefined && (
              <div className="text-detail">
                <AddressLine value={desk.slashSink} />
              </div>
            )}
            <TxButton
              label="Send it to the sink"
              tone="secondary"
              blockedBy={blockedBy}
              send={() =>
                writeContractAsync({
                  address: registry,
                  abi: oracleRegistryAbi,
                  functionName: 'sweepUnallocated',
                }).catch((caught: unknown) => {
                  throw resolverFailure(caught, { action: 'Send unallocated fees to the sink' });
                })
              }
              onContinue={onDone}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
