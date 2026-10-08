'use client';

import { useState } from 'react';
import type { Address } from 'viem';

import { TOKEN_ADDRESSES, brsrAbi, oracleRegistryAbi } from '@/chain';
import { Address as AddressLine } from '@/components/address';
import { AmountInput } from '@/components/amount-input';
import { Card, Field, FieldGrid } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { TxButton } from '@/components/tx-button';
import { formatBrsr } from '@/money';
import type { Brsr } from '@/money';
import type { AnyState } from '@/state';

import type { ResolverDesk } from './desk';
import { ResolverStatus } from './phases';
import { resolverFailure } from './refusal';
import { useWriteContract } from '@/wallet/write';

/** `register` and `increaseBond` both take a uint128. Anything larger cannot be encoded at all. */
const UINT128_MAX = 2n ** 128n - 1n;

/**
 * The bond, and the floor it has to clear.
 *
 * The floor is read from the staking pool on every pass rather than written here, because
 * governance can raise it for everyone or for one address, and `commitVote` reads it live. A
 * resolver benched by a raise is benched from the next block, and the only thing that tells them
 * why is this number next to their own.
 */
export function BondPanel({
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
  const standing = desk?.standing;
  const unread = desk === undefined ? 'Reading' : 'Not read';

  // Without a wallet the global floor is the only answer available: an address-specific floor needs an
  // address. Both come from the same pool, and the copy says which one is on screen.
  const floor = standing?.floor ?? desk?.minBond;
  const active = standing?.status === ResolverStatus.Active;
  const unbonding = standing?.status === ResolverStatus.Unbonding;

  return (
    <Card
      title="Your bond"
      description="The BRSR you post to vote on disputes. A vote that goes wrong costs part of it, and nothing else is at risk."
    >
      <StatGrid columns={4}>
        <Stat
          label="Bonded"
          value={standing?.bond === undefined ? unread : `${formatBrsr(standing.bond)} BRSR`}
          hint={account === undefined ? 'Connect a wallet to see your bond' : statusWord(standing?.status)}
          level={levelFor(standing?.bond, floor, standing?.barred)}
        />
        <Stat
          label={account === undefined ? 'Floor for a new resolver' : 'Your floor'}
          value={floor === undefined ? unread : `${formatBrsr(floor)} BRSR`}
          hint={
            standing?.floor !== undefined && desk?.minBond !== undefined && standing.floor > desk.minBond
              ? `Raised above the global floor of ${formatBrsr(desk.minBond)} BRSR for this address`
              : 'The smallest bond that can vote, set by the staking pool'
          }
        />
        <Stat
          label="In your wallet"
          value={standing?.balance === undefined ? (account === undefined ? 'No wallet' : unread) : `${formatBrsr(standing.balance)} BRSR`}
          hint="BRSR the connected wallet holds"
        />
        <Stat
          label="Disputes ruled"
          value={standing?.finalized === undefined ? (account === undefined ? 'No wallet' : unread) : standing.finalized.toString()}
          hint={standing?.slashes === undefined ? 'Votes that reached a ruling' : `${standing.slashes} slashed`}
        />
      </StatGrid>

      <div className="mt-5 space-y-4">
        {standing?.barred === true && (
          <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
            Governance has barred this address from bonding, so it cannot post any amount. Only governance can lift the
            bar.
          </p>
        )}

        {desk !== undefined && desk.bondAsset !== undefined && desk.bondPool !== undefined && (
          <FieldGrid columns={3}>
            <Field label="Bond asset" hint="Bonds are in BRSR. Rewards are paid in USDG.">
              <AddressLine value={desk.bondAsset} label="BRSR" />
            </Field>
            <Field label="Floor held by" hint="The staking pool sets the floor and any bar for each address.">
              <AddressLine value={desk.bondPool} />
            </Field>
            <Field label="Bonded across the bench" hint={`${desk.resolverCount ?? 0} resolvers registered`}>
              <span className="tabular">{desk.totalBonded === undefined ? unread : `${formatBrsr(desk.totalBonded)} BRSR`}</span>
            </Field>
          </FieldGrid>
        )}

        {account !== undefined && (
          <BondForm
            desk={desk}
            blockedBy={blockedBy}
            onDone={onDone}
            mode={active ? 'increase' : 'register'}
            disabledReason={
              unbonding
                ? 'This address is unbonding, so it cannot add to the bond. Cancel the exit first to put the bond back to work.'
                : undefined
            }
          />
        )}
      </div>
    </Card>
  );
}

function BondForm({
  desk,
  blockedBy,
  onDone,
  mode,
  disabledReason,
}: {
  readonly desk: ResolverDesk | undefined;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
  readonly mode: 'register' | 'increase';
  readonly disabledReason: string | undefined;
}) {
  const [text, setText] = useState('');
  const [atomic, setAtomic] = useState<bigint | undefined>(undefined);
  const { writeContractAsync } = useWriteContract();

  const standing = desk?.standing;
  const registry = desk?.registry;
  const balance = standing?.balance;
  const allowance = standing?.allowance;
  const floor = standing?.floor;
  const bond = standing?.bond;

  const amount = atomic ?? 0n;
  const overBalance = balance !== undefined && amount > balance;
  const overWord = amount > UINT128_MAX;
  // Checked against the total the contract will hold, not against the increment, because that is
  // what `_requireBondable` reads. A top-up that lands short would be refused after it was signed.
  const total = mode === 'register' ? amount : (bond ?? 0n) + amount;
  const underFloor = floor !== undefined && total < floor;

  // An unread allowance is not a zero allowance. Sending the bond on that assumption is how a
  // wallet signs a transaction that reverts inside `transferFrom`.
  const allowanceKnown = allowance !== undefined;
  const needsAllowance = allowanceKnown && amount > allowance;

  const unreadReason =
    desk === undefined
      ? undefined
      : balance === undefined
        ? 'the BRSR balance in this wallet'
        : !allowanceKnown
          ? 'what the registry may already move from this wallet'
          : floor === undefined
            ? 'the floor for this address'
            : undefined;

  const ready =
    registry !== undefined &&
    amount > 0n &&
    !overBalance &&
    !overWord &&
    !underFloor &&
    allowanceKnown &&
    balance !== undefined &&
    standing?.barred !== true &&
    disabledReason === undefined;

  const short = floor !== undefined && bond !== undefined && floor > bond ? floor - bond : 0n;

  return (
    <div className="border-t border-[color:var(--color-line)] pt-4">
      <div className="max-w-md">
        <AmountInput
          label={mode === 'register' ? 'Bond to post' : 'Add to the bond'}
          asset="BRSR"
          value={text}
          onChange={(next, value) => {
            setText(next);
            setAtomic(value);
          }}
          max={
            balance === undefined
              ? undefined
              : short > 0n && short <= balance
                ? { atomic: short, label: 'Reach the floor' }
                : { atomic: balance, label: 'All of it' }
          }
          problem={
            overBalance
              ? 'More than this wallet holds.'
              : overWord
                ? 'Larger than the registry can hold.'
                : underFloor && amount > 0n
                  ? floorProblem(mode, total, floor)
                  : undefined
          }
          hint={
            mode === 'register'
              ? 'Posting a bond commits you to nothing. Only a vote puts it at risk.'
              : 'The bond after the top-up has to reach the floor.'
          }
          disabled={disabledReason !== undefined}
        />
      </div>

      <div className="mt-4">
        {registry === undefined ? (
          <p className="text-detail text-[color:var(--color-muted)]">
            The registry could not be found, so bonding is unavailable.
          </p>
        ) : needsAllowance ? (
          <TxButton
            key="approve"
            label={`Allow ${formatBrsr(amount as Brsr)} BRSR`}
            tone="secondary"
            disabled={!ready}
            blockedBy={blockedBy}
            send={() =>
              writeContractAsync({
                address: bondTokenOr(desk),
                abi: brsrAbi,
                functionName: 'approve',
                args: [registry, amount],
              }).catch((caught: unknown) => {
                throw resolverFailure(caught, { action: 'Allow the registry to move BRSR' });
              })
            }
            onContinue={onDone}
          />
        ) : (
          <TxButton
            key="bond"
            label={mode === 'register' ? 'Post the bond' : 'Add to the bond'}
            disabled={!ready}
            blockedBy={blockedBy}
            send={() =>
              writeContractAsync({
                address: registry,
                abi: oracleRegistryAbi,
                functionName: mode === 'register' ? 'register' : 'increaseBond',
                args: [amount],
              }).catch((caught: unknown) => {
                throw resolverFailure(caught, { action: mode === 'register' ? 'Post the bond' : 'Add to the bond' });
              })
            }
            onConfirmed={() => {
              setText('');
              setAtomic(undefined);
              onDone();
            }}
          />
        )}
      </div>

      <div className="mt-3 space-y-2">
        {disabledReason !== undefined && <p className="text-detail text-[color:var(--color-muted)]">{disabledReason}</p>}
        {short > 0n && bond !== undefined && bond > 0n && (
          <p className="text-detail" style={{ color: 'var(--color-state-attention)' }}>
            This bond is {formatBrsr(short as Brsr)} BRSR below the floor, so it cannot vote. Add that much to vote again.
          </p>
        )}
        {needsAllowance && (
          <p className="text-detail text-[color:var(--color-muted)]">
            Two transactions: allow the registry to move the BRSR, then post it. The first moves nothing.
          </p>
        )}
        {allowance !== undefined && allowance > 0n && !needsAllowance && (
          <p className="text-detail text-[color:var(--color-muted)]">
            The registry can already move {formatBrsr(allowance)} BRSR from this wallet.
          </p>
        )}
        {unreadReason !== undefined && (
          <p className="text-detail text-[color:var(--color-muted)]">
            Could not read {unreadReason}. Read again before bonding.
          </p>
        )}
        <p className="text-detail text-[color:var(--color-muted)]">
          Bonds are held in BRSR, so their value moves with the BRSR price.
        </p>
      </div>
    </div>
  );
}

function floorProblem(mode: 'register' | 'increase', total: bigint, floor: bigint | undefined): string {
  if (floor === undefined) return 'The floor could not be read.';
  return mode === 'register'
    ? `The floor is ${formatBrsr(floor as Brsr)} BRSR. This would post ${formatBrsr(total as Brsr)} BRSR.`
    : `This would bring the bond to ${formatBrsr(total as Brsr)} BRSR, below the ${formatBrsr(floor as Brsr)} BRSR floor.`;
}

function bondTokenOr(desk: ResolverDesk | undefined): Address {
  // The registry names its own bond asset, and approving anything else would authorise a token the
  // bond path never touches. Falling back to the generated address keeps the control usable while
  // that one call is unread; both resolve to BRSR in this deployment.
  return desk?.bondAsset ?? TOKEN_ADDRESSES.BRSR;
}

function statusWord(status: number | undefined): string {
  switch (status) {
    case ResolverStatus.Active:
      return 'Active and able to vote';
    case ResolverStatus.Unbonding:
      return 'Unbonding, so no new votes';
    case ResolverStatus.Exited:
      return 'Exited. The bond has been returned';
    case ResolverStatus.None:
      return 'Not on the bench';
    default:
      return 'Status not read';
  }
}

function levelFor(bond: bigint | undefined, floor: bigint | undefined, barred: boolean | undefined) {
  if (barred === true) return 'blocked' as const;
  if (bond === undefined || floor === undefined) return undefined;
  if (bond === 0n) return undefined;
  return bond < floor ? ('attention' as const) : ('ok' as const);
}
