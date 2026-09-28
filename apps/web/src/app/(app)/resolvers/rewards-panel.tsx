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
      description="A cut of every settlement a panel rules on, split between the scores that held."
    >
      <div className="space-y-4">
        <FieldGrid columns={3}>
          <Field label="Yours to claim" hint="Accrued across disputes that have settled. Paid in USDG.">
            <span className="tabular">{claimable === undefined ? (account === undefined ? 'No wallet' : unread) : usdExact(claimable)}</span>
          </Field>
          <Field label="The resolver fee" hint="Taken off a settlement the panel ruled on and returned to the registry.">
            <span className="tabular">{desk?.resolverFeeBps === undefined ? unread : bps(desk.resolverFeeBps)}</span>
          </Field>
          <Field label="Reward asset" hint="USDG, the asset the disputed settlement was denominated in.">
            {desk?.rewardAsset === undefined ? unread : <AddressLine value={desk.rewardAsset} label="USDG" />}
          </Field>
        </FieldGrid>

        <p className="text-sm">
          When a dispute is finalised the escrow deducts the resolver fee from the lock it settles and hands it back to
          the registry, where it is split evenly between the resolvers who revealed a score inside the deviation band.
          Silence and outlier scores earn nothing, which is the same test that decides slashing. A dispute that closes
          without a ruling pays nobody. Nothing here is a rate and nothing accrues over time: what arrives depends on
          how many disputes are opened and ruled on.
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
                throw resolverFailure(caught, { action: 'Claim what ruling has paid' });
              })
            }
            onConfirmed={onDone}
          />
        )}

        {account !== undefined && claimable === 0n && (
          <p className="text-detail text-[color:var(--color-muted)]">
            Nothing to claim. A reward lands on a resolver only when a dispute it ruled on settles. An address that has
            left the bench still collects what it earned while bonded.
          </p>
        )}

        {unallocated !== undefined && unallocated > 0n && registry !== undefined && (
          <div className="space-y-2 border-t border-[color:var(--color-line)] pt-4">
            <p className="text-sm">
              {usdExact(unallocated)} of resolver fees reached nobody. That happens when a dispute closes without a
              ruling, or when the fee is smaller than the number of resolvers it would divide between. It belongs to the
              slash sink{desk?.slashSink === undefined ? '' : ' at the address below'}, and sending it there is open to
              anyone because none of it is discretionary.
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
