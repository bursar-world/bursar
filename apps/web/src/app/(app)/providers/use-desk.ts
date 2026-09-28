'use client';

import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';

import { readProviderDesk, readRegistryTerms } from './desk';
import type { ProviderDesk, RegistryTerms } from './desk';
import { registryTermLines } from './registry';
import type { RegistryTermLines } from './registry';

export type DeskState = {
  readonly desk: ProviderDesk | undefined;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: unknown;
  readonly refresh: () => void;
};

/**
 * Slower than the fifteen seconds the console reads at. A payee's desk changes when a payer locks
 * or a deadline passes, and the extra requests would come out of the same rate budget the wallet
 * writes go through.
 */
const REFETCH_MS = 20_000;

/** The registry's own parameters move on a governance delay, so they are read once and left. */
const TERMS_STALE_MS = 300_000;

export function useProviderDesk(payee: Address | undefined): DeskState {
  const query = useQuery({
    queryKey: ['bursar', 'provider-desk', payee],
    queryFn: () => readProviderDesk(payee as Address),
    enabled: payee !== undefined,
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: true,
  });

  return {
    desk: query.data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refresh: () => void query.refetch(),
  };
}

export type RegistryTermsState = {
  readonly terms: RegistryTerms | undefined;
  readonly lines: RegistryTermLines;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: unknown;
  readonly refresh: () => void;
};

export function useRegistryTerms(): RegistryTermsState {
  const query = useQuery({
    queryKey: ['bursar', 'registry-terms'],
    queryFn: () => readRegistryTerms(),
    staleTime: TERMS_STALE_MS,
    refetchOnWindowFocus: false,
  });

  return {
    terms: query.data,
    lines: registryTermLines(query.data),
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refresh: () => void query.refetch(),
  };
}
