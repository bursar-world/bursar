'use client';

import { collateralDeployment, creditPoolAbi, micro } from '@bursar/core';
import { useQuery } from '@tanstack/react-query';
import { readContract } from 'viem/actions';
import type { Abi } from 'viem';

import { rhcClient } from '@/chain/client';
import { FUNDING_LANES, LANE_NAME, laneAvailable } from '@/chain/mandates';
import type { FundingLane } from '@/chain/mandates';
import { CHAIN_ID } from '@/chain/rhc';
import { usd } from '@/money';
import { Choice } from '../limits-form';

/** What the create screen sends after the account exists, per lane. Named before the first prompt. */
export { LANE_NAME };

export const LANE_FOLLOW_UPS: Readonly<Record<FundingLane, readonly string[]>> = {
  prefund: [],
  treasury: ['name the treasury park as where the mandate unparks'],
  collateral: ['open the collateral line', 'name the collateral vault as where the mandate borrows'],
};

/** The most one mandate may owe the credit pool, read from the pool. */
function usePerMandateCap(enabled: boolean) {
  const lane = collateralDeployment(CHAIN_ID);
  return useQuery({
    queryKey: ['console', 'credit-per-mandate-cap', lane?.CreditPool],
    queryFn: async () =>
      (await readContract(rhcClient(), {
        address: lane!.CreditPool,
        abi: creditPoolAbi as Abi,
        functionName: 'perMandateCap',
      })) as bigint,
    enabled: enabled && lane !== undefined,
    staleTime: 5 * 60_000,
  });
}

export function LaneFields({
  lane,
  onChange,
  disabled = false,
}: {
  readonly lane: FundingLane;
  readonly onChange: (next: FundingLane) => void;
  readonly disabled?: boolean;
}) {
  const cap = usePerMandateCap(lane === 'collateral');
  const capText = cap.data === undefined ? 'a per-mandate limit set by governance' : `${usd(micro(cap.data))} per mandate`;

  const detail: Record<FundingLane, string> = {
    prefund: 'The mandate holds USDG and pays from it. What you put in is the most it can spend.',
    treasury:
      'Idle budget can sit in a treasury token. A payment that needs more USDG than the mandate holds sells enough of it back in the same transaction.',
    collateral: `You post stock or treasury tokens to the collateral vault. A payment the mandate cannot cover borrows the shortfall against them, up to the headroom their haircuts leave, and you repay it. Borrowing is capped at ${capText}.`,
  };

  return (
    <div className="space-y-2">
      {FUNDING_LANES.filter(laneAvailable).map((entry) => (
        <Choice
          key={entry}
          name="funding-lane"
          checked={lane === entry}
          disabled={disabled}
          onSelect={() => onChange(entry)}
          label={LANE_NAME[entry]}
          detail={detail[entry]}
        />
      ))}
    </div>
  );
}
