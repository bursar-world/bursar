'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';

import { useWalletAccount } from '@/wallet/account';
import { readResolverDesk } from './desk';
import type { ResolverDesk } from './desk';

export type ResolverDeskState = {
  readonly account: Address | undefined;
  readonly desk: ResolverDesk | undefined;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: unknown;
  readonly refresh: () => void;
};

/**
 * Faster than the provider desk, because what changes here is a clock.
 *
 * A commit window closes six hours after a dispute opens and a reveal window six hours after that.
 * A resolver reading a page fifteen seconds behind the chain is reading a countdown, not a balance,
 * and the cost of being wrong is a missed reveal. Three aggregated requests per pass, so fifteen
 * seconds is a handful of calls a minute against an endpoint that takes sixty a second.
 */
const REFETCH_MS = 15_000;

export function useResolverDesk(): ResolverDeskState {
  const { address } = useWalletAccount();

  const query = useQuery({
    queryKey: ['bursar', 'resolver-desk', address ?? 'anonymous'],
    queryFn: ({ signal }) => readResolverDesk(address, signal),
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: true,
    // Connecting a wallet changes the key. Without this the panel empties itself on the way to the
    // answer, and a countdown a resolver was reading disappears for as long as the next read takes.
    placeholderData: keepPreviousData,
  });

  return {
    account: address,
    desk: query.data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error ?? null,
    refresh: () => void query.refetch(),
  };
}
