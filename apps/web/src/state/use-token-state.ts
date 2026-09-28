'use client';

import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';

import { readToken } from '../chain/token';
import type { TokenSnapshot } from '../chain/token';
import { useWalletAccount } from '../wallet/account';

export type TokenState = {
  readonly data: TokenSnapshot | undefined;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: unknown;
  readonly refresh: () => void;
};

/** Supply, the staking pool, a grant and the buyback, in one batched read. */
export function useTokenState(account?: Address): TokenState {
  const connected = useWalletAccount();
  const subject = account ?? connected.address;

  const query = useQuery({
    queryKey: ['bursar', 'token', subject ?? 'anonymous'],
    queryFn: () => readToken(subject),
    refetchInterval: 20_000,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error ?? null,
    refresh: () => {
      void query.refetch();
    },
  };
}
