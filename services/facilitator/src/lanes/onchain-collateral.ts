import { NO_DEBT_HEALTH, collateralDeployment, collateralVaultAbi, healthRatio, toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { Address } from 'viem';

/**
 * A mandate's position in the on-chain collateral lane, as `CollateralVault.account` reports it.
 *
 * When the facilitator knows the mandate behind an account, these figures replace the ones the
 * ledger would compute from its own collateral rows. The vault holds the collateral and the pool
 * holds the debt, so the chain is the only place either is true; the ledger keeps its rows as the
 * log of holds and reservations it made against them.
 */
export type OnchainCollateral = {
  readonly mandate: Address;
  readonly valueMicro: Micro;
  /** Value after each asset's current haircut. */
  readonly effectiveCollateralMicro: Micro;
  readonly outstandingMicro: Micro;
  /** What the vault would lend now, already capped by the pool's limits and cash. */
  readonly headroomMicro: Micro;
  /** 1e18 = 1.0. `NO_DEBT_HEALTH` when nothing is owed. */
  readonly healthE18: bigint;
  /** Null when nothing is owed. */
  readonly healthFactor: number | null;
};

export interface OnchainCollateralReader {
  read(mandate: Address): Promise<OnchainCollateral>;
}

type ReadClient = {
  readContract(args: {
    address: Address;
    abi: typeof collateralVaultAbi;
    functionName: 'account';
    args: readonly [Address];
  }): Promise<readonly [bigint, bigint, bigint, bigint, bigint]>;
};

export function fromAccountTuple(
  mandate: Address,
  [value, adjusted, debt, headroom, health]: readonly [bigint, bigint, bigint, bigint, bigint],
): OnchainCollateral {
  return {
    mandate,
    valueMicro: toMicro(value),
    effectiveCollateralMicro: toMicro(adjusted),
    outstandingMicro: toMicro(debt),
    headroomMicro: toMicro(headroom),
    healthE18: health,
    healthFactor: health === NO_DEBT_HEALTH ? null : healthRatio(health),
  };
}

/** Reads the vault named in the deployment record for `chainId`. Null where no lane is deployed. */
export function createOnchainCollateralReader(client: ReadClient, chainId: number): OnchainCollateralReader | null {
  const lane = collateralDeployment(chainId);
  if (lane === undefined) return null;
  return {
    async read(mandate) {
      const tuple = await client.readContract({
        address: lane.CollateralVault,
        abi: collateralVaultAbi,
        functionName: 'account',
        args: [mandate],
      });
      return fromAccountTuple(mandate, tuple);
    },
  };
}
