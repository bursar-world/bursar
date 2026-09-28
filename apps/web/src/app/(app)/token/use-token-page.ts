'use client';

import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';

import type { TokenSnapshot } from '@/chain';
import { useTokenState } from '@/state';
import { useWalletAccount } from '@/wallet/account';

import { readTokenExtras } from './read';
import type { TokenExtras } from './read';

export type TokenPageData = {
  readonly account: Address | undefined;
  readonly token: TokenSnapshot | undefined;
  readonly extras: TokenExtras | undefined;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: unknown;
  readonly refresh: () => void;
};

const REFETCH_MS = 20_000;

/**
 * Two batched requests, twenty seconds apart: supply and the staking position from the shared
 * token reader, and everything else this page asks for from its own batch. Both are re-read
 * together so no section on the page is a block behind its neighbour for long.
 */
export function useTokenPage(): TokenPageData {
  const { address } = useWalletAccount();
  const token = useTokenState(address);

  const extras = useQuery({
    queryKey: ['bursar', 'token-page', address ?? 'anonymous'],
    queryFn: () => readTokenExtras(address),
    refetchInterval: REFETCH_MS,
  });

  return {
    account: address,
    token: token.data,
    extras: extras.data,
    isLoading: token.isLoading || extras.isLoading,
    isFetching: token.isFetching || extras.isFetching,
    error: token.error ?? extras.error ?? null,
    refresh: () => {
      token.refresh();
      void extras.refetch();
    },
  };
}
