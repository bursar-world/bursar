import { useQuery } from '@tanstack/react-query';
import { collateralVaultAbi, creditPoolAbi, mandateAccountAbi, priceGuardAbi } from '@bursar/core';
import { decodeErrorResult } from 'viem';
import type { Abi, Address } from 'viem';

import { collateralLane, readCollateralAccount } from '@/chain/collateral';
import { rhcClient } from '@/chain/client';

export function useCollateral(mandate: Address, wallet: Address | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['console', 'collateral', mandate.toLowerCase(), wallet?.toLowerCase() ?? ''],
    queryFn: () => readCollateralAccount(mandate, wallet),
    enabled: enabled && collateralLane() !== undefined,
    refetchInterval: 30_000,
  });
}

/** Plain language for every refusal on the collateral and credit paths. */
export const COLLATERAL_REFUSALS: Readonly<Record<string, string>> = {
  NotPrincipal: 'Only the owner of this mandate can do this.',
  NotCollateralLane: 'This mandate is prefunded, so it cannot borrow.',
  NotFactoryAccount: 'Borrowing against collateral is available on new mandates.',
  NoLine: 'Open the line for this mandate first.',
  NotCollateral: 'This asset is not accepted as collateral.',
  NotEligible: 'This asset is not eligible right now.',
  HealthTooLow:
    'This would leave health below the borrowing floor. A position counts only while its price is current, its pool trades in line with it, and the pool price was checked recently.',
  Healthy: 'The position is healthy, so nothing can be sold.',
  PositionEmpty: 'The position holds less than that.',
  ZeroAmount: 'Enter an amount above zero.',
  NoDebt: 'This mandate owes nothing.',
  MandateCapExceeded: 'This would take the mandate past its credit limit.',
  TotalCapExceeded: 'The credit pool has reached its credit limit across all mandates.',
  InsufficientCash: 'The credit pool does not hold enough USDG for this draw right now.',
  StalePrice: 'The price for this asset is too old, so the sale waits for a fresh one.',
  OraclePaused: 'The price feed for this asset is paused, so the sale waits.',
  TokenPaused: 'Transfers of this asset are paused by its issuer, so the sale waits.',
  AccessPaused: 'Trading in these assets is paused by the issuer, so the sale waits.',
  BadPrice: 'The price feed returned no usable price, so the sale waits.',
  PoolPriceDeviation: 'The pool price for this asset is too far from the feed, so the sale waits until they agree again.',
  Blocked: 'The issuer blocks this account from trading these assets.',
  NothingToSell: 'Nothing in this position can be sold.',
  NothingSeized: 'Nothing has been seized in this asset, so there is nothing to claim.',
  ObservationTooSoon: 'The pool price was checked too recently. Try again shortly.',
  ERC20InsufficientBalance: 'The wallet holds less than the amount.',
  ERC20InsufficientAllowance: 'Approve the amount first.',
};

const ERRORS = [...(collateralVaultAbi as Abi), ...(creditPoolAbi as Abi), ...(mandateAccountAbi as Abi), ...(priceGuardAbi as Abi)].filter(
  (entry) => entry.type === 'error',
) as Abi;

export function collateralRefusal(message: string): string | undefined {
  for (const name of Object.keys(COLLATERAL_REFUSALS)) {
    if (new RegExp(`\\b${name}\\b`).test(message)) return COLLATERAL_REFUSALS[name];
  }
  return undefined;
}

/** Runs the call against the chain first, so a refusal is named before the wallet opens. */
export async function checkFirst(request: {
  readonly account: Address;
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args: readonly unknown[];
}): Promise<void> {
  try {
    await rhcClient().simulateContract({ ...request, abi: [...request.abi, ...ERRORS] } as never);
  } catch (error) {
    const reason = refusalOf(error);
    if (reason !== undefined) throw new Error(reason);
    throw error;
  }
}

function refusalOf(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let node: unknown = error;
  while (typeof node === 'object' && node !== null && !seen.has(node)) {
    seen.add(node);
    const shaped = node as { data?: unknown; cause?: unknown; errorName?: unknown; message?: unknown };
    if (typeof shaped.errorName === 'string' && COLLATERAL_REFUSALS[shaped.errorName]) return COLLATERAL_REFUSALS[shaped.errorName];
    const data = shaped.data;
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
      try {
        return COLLATERAL_REFUSALS[decodeErrorResult({ abi: ERRORS, data: data as `0x${string}` }).errorName];
      } catch {
        // not one of ours
      }
    }
    if (typeof shaped.message === 'string') {
      const named = collateralRefusal(shaped.message);
      if (named !== undefined) return named;
    }
    node = shaped.cause;
  }
  return undefined;
}
