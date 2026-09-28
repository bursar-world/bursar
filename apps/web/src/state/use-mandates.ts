'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Address } from 'viem';

import { readMandateSummaries } from '../chain/mandates';
import type { MandateSummary } from '../chain/mandates';
import { useWalletAccount } from '../wallet/account';

export type MandateList = {
  readonly mandates: readonly MandateSummary[];
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: unknown;
  readonly refresh: () => void;
};

/** Every mandate an owner holds, with enough of each to list it. Two requests, whatever the count. */
export function useMandates(principal?: Address): MandateList {
  const connected = useWalletAccount();
  const owner = principal ?? connected.address;

  const query = useQuery({
    queryKey: ['bursar', 'mandates', owner ?? 'anonymous'],
    queryFn: () => (owner ? readMandateSummaries(owner) : Promise.resolve([])),
    enabled: owner !== undefined,
    refetchInterval: 20_000,
  });

  // A fresh object each render pushes every list below this through a re-render it has no reason
  // to do, so the result is keyed on the parts of the query that hold their identity.
  const { data, isLoading, isFetching, error, refetch } = query;

  return useMemo<MandateList>(
    () => ({
      mandates: data ?? EMPTY,
      isLoading,
      isFetching,
      error: error ?? null,
      refresh: () => {
        void refetch();
      },
    }),
    [data, isLoading, isFetching, error, refetch],
  );
}

const EMPTY: readonly MandateSummary[] = [];
