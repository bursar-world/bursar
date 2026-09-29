'use client';

import { collateralDeployment, collateralVaultAbi } from '@bursar/core';
import { useQuery } from '@tanstack/react-query';
import { readContract } from 'viem/actions';
import type { Abi, Address } from 'viem';
import { useWriteContract } from 'wagmi';

import { rhcClient } from '@/chain/client';
import { laneParkOf } from '@/chain/mandates';
import type { FundingLane } from '@/chain/mandates';
import { CHAIN_ID, sameAddress } from '@/chain/rhc';
import { TxButton } from '@/components/tx-button';
import type { TxContext } from '@/components/tx-button';
import type { AnyState } from '@/state';

const parkAbi = [
  { type: 'function', name: 'treasuryPark', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'setTreasuryPark',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'treasuryPark_', type: 'address' }],
    outputs: [],
  },
] as const satisfies Abi;

type LaneReading = { readonly park: Address; readonly line: boolean | undefined };

/**
 * The lane steps after a treasury or collateral mandate exists, read back off the chain the same
 * way the payee and capability rows are: the account's park, and the vault's line for it.
 */
export function LaneGates({
  mandate,
  lane,
  blockedBy,
  context,
}: {
  readonly mandate: Address;
  readonly lane: FundingLane;
  readonly blockedBy: readonly AnyState[];
  readonly context: TxContext;
}) {
  const { writeContractAsync } = useWriteContract();
  const park = laneParkOf(lane);
  const vault = collateralDeployment(CHAIN_ID)?.CollateralVault;

  const reading = useQuery({
    queryKey: ['console', 'new-lane', mandate, lane],
    queryFn: async (): Promise<LaneReading> => {
      const client = rhcClient();
      const [current, line] = await Promise.all([
        readContract(client, { address: mandate, abi: parkAbi, functionName: 'treasuryPark' }),
        lane === 'collateral' && vault !== undefined
          ? (readContract(client, { address: vault, abi: collateralVaultAbi as Abi, functionName: 'isLine', args: [mandate] }) as Promise<boolean>)
          : Promise.resolve(undefined),
      ]);
      return { park: current, line };
    },
    refetchInterval: 15_000,
  });
  const refresh = () => void reading.refetch();

  if (park === undefined) return null;

  const parkSet = reading.data === undefined ? undefined : sameAddress(reading.data.park, park);

  return (
    <>
      {lane === 'collateral' && vault !== undefined && (
        <Row
          title="Open the collateral line"
          detail="Registers this mandate with the collateral vault, so tokens can be posted to it. Needed once."
          done={reading.data?.line}
          send={() => writeContractAsync({ address: vault, abi: collateralVaultAbi as Abi, functionName: 'openLine', args: [mandate] })}
          onDone={refresh}
          blockedBy={blockedBy}
          context={context}
        />
      )}
      <Row
        title={lane === 'collateral' ? 'Borrow from the collateral vault when short' : 'Unpark from the treasury park when short'}
        detail={
          lane === 'collateral'
            ? 'A payment that needs more USDG than the mandate holds borrows the difference against your collateral.'
            : 'A payment that needs more USDG than the mandate holds sells enough of the parked treasury token back.'
        }
        done={parkSet}
        send={() => writeContractAsync({ address: mandate, abi: parkAbi, functionName: 'setTreasuryPark', args: [park] })}
        onDone={refresh}
        blockedBy={blockedBy}
        context={context}
      />
    </>
  );
}

function Row({
  title,
  detail,
  done,
  send,
  onDone,
  blockedBy,
  context,
}: {
  readonly title: string;
  readonly detail: string;
  readonly done: boolean | undefined;
  readonly send: () => Promise<`0x${string}`>;
  readonly onDone: () => void;
  readonly blockedBy: readonly AnyState[];
  readonly context: TxContext;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--color-line)] pb-4 last:border-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-detail text-[color:var(--color-muted)]">{detail}</p>
      </div>
      {done === true ? (
        <span className="text-detail" style={{ color: 'var(--color-state-ok)' }}>
          Done
        </span>
      ) : (
        <div className="space-y-1 text-right">
          <TxButton label="Send" tone="secondary" send={send} onContinue={onDone} blockedBy={blockedBy} context={context} />
          {done === undefined && <p className="text-note text-[color:var(--color-muted)]">Reading the account for this one.</p>}
        </div>
      )}
    </div>
  );
}
