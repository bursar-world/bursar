'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { CHAIN_ID } from '../chain/rhc';
import { probeProviders } from '../chain/client';
import { readSystem } from '../chain/reader';
import type { ReadScope } from '../chain/reader';
import { evaluateAsset, evaluateConnectivity, evaluateFunding, evaluateMandate, evaluatePermission } from './evaluate';
import type { Micro } from '@bursar/core';
import type { AnyState, SystemState } from './types';
import { useWalletAccount } from '../wallet/account';

export type SystemScope = ReadScope & {
  /** How often to re-read the chain. One batched request, so this is one request per interval. */
  readonly refetchMs?: number;
  /** How often each endpoint is asked directly, which is the only way a failover stays visible. */
  readonly providerRefetchMs?: number;
  /** Past this age a reading is labelled stale on every surface that shows it. */
  readonly staleAfterMs?: number;
  readonly enabled?: boolean;
  /**
   * USDG a payment from this mandate can draw inside the same transaction, from parked value or a
   * credit line, on an account built to do so. Undefined where it cannot or it is not known.
   */
  readonly drawable?: Micro;
};

const DEFAULT_REFETCH_MS = 12_000;
const DEFAULT_PROVIDER_REFETCH_MS = 30_000;
const DEFAULT_STALE_AFTER_MS = 60_000;

/**
 * The five states, read together and reported apart.
 *
 * One batched request covers the asset, the mandate, its permissions and its funding, so every
 * number on the screen comes from the same block. Connectivity is read separately and outside the
 * pool: asking through the failover would answer "the chain is reachable", which
 * is exactly what a spent redundancy looks like from the outside.
 *
 * Nothing here returns a combined verdict. `blockers` filters the five; it does not merge them.
 */
export function useSystemState(scope: SystemScope = {}): SystemState {
  const { address } = useWalletAccount();
  const gasPayer = scope.gasPayer ?? address;
  const enabled = scope.enabled ?? true;
  const staleAfterMs = scope.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  const read: ReadScope = useMemo(
    () => ({
      ...(scope.mandate === undefined ? {} : { mandate: scope.mandate }),
      ...(scope.principal === undefined ? {} : { principal: scope.principal }),
      ...(scope.agent === undefined ? {} : { agent: scope.agent }),
      ...(scope.merchant === undefined ? {} : { merchant: scope.merchant }),
      ...(scope.capability === undefined ? {} : { capability: scope.capability }),
      ...(scope.amount === undefined ? {} : { amount: scope.amount }),
      ...(gasPayer === undefined ? {} : { gasPayer }),
    }),
    [scope.mandate, scope.principal, scope.agent, scope.merchant, scope.capability, scope.amount, gasPayer],
  );

  const system = useQuery({
    queryKey: ['bursar', 'system', keyOf(read)],
    queryFn: () => readSystem(read),
    refetchInterval: scope.refetchMs ?? DEFAULT_REFETCH_MS,
    refetchOnWindowFocus: true,
    // Naming a payee changes the key, and without this the screen would empty itself on the way to
    // the answer: every panel, every input and the reading a person is comparing against. The last
    // reading stays up, `isFetching` says a newer one is on its way, and the timestamp under it
    // says how old what they are looking at is.
    placeholderData: keepPreviousData,
    enabled,
  });

  const providers = useQuery({
    queryKey: ['bursar', 'providers'],
    queryFn: () => probeProviders(),
    refetchInterval: scope.providerRefetchMs ?? DEFAULT_PROVIDER_REFETCH_MS,
    enabled,
  });

  // Every screen that takes this hands the result down, so a fresh object here re-renders the lot
  // of them on every keystroke anywhere in the tree. React Query rebuilds its result object each
  // render, which is why the dependencies below are the parts of it that hold still between renders.
  const { data: snapshot, dataUpdatedAt, error: systemError, isLoading, isFetching: systemFetching, refetch: refetchSystem } = system;
  const {
    data: providerHealth,
    dataUpdatedAt: providerUpdatedAt,
    error: providerError,
    isFetching: providersFetching,
    refetch: refetchProviders,
  } = providers;

  return useMemo(() => {
    const checkedAt = dataUpdatedAt === 0 ? null : new Date(dataUpdatedAt);
    const stale = checkedAt !== null && Date.now() - checkedAt.getTime() > staleAfterMs;
    const providerCheckedAt = providerUpdatedAt === 0 ? null : new Date(providerUpdatedAt);
    const providerStale = providerCheckedAt !== null && Date.now() - providerCheckedAt.getTime() > staleAfterMs * 2;

    const asset = evaluateAsset(snapshot, checkedAt, stale);
    const mandate = evaluateMandate(snapshot, checkedAt, stale, read.mandate);
    const permission = evaluatePermission(snapshot, checkedAt, stale);
    const funding = evaluateFunding(snapshot, checkedAt, stale, scope.drawable);
    const connectivity = evaluateConnectivity(providerHealth, CHAIN_ID, snapshot?.blockNumber, providerCheckedAt, providerStale);

    const all: readonly AnyState[] = [connectivity, asset, mandate, permission, funding];

    return {
      asset,
      mandate,
      permission,
      funding,
      connectivity,
      all,
      blockers: all.filter((state) => state.level === 'blocked'),
      snapshot,
      assetRead: snapshot?.asset,
      isLoading,
      isFetching: systemFetching || providersFetching,
      error: systemError ?? providerError ?? null,
      refresh: () => {
        void refetchSystem();
        void refetchProviders();
      },
    };
  }, [
    snapshot,
    dataUpdatedAt,
    systemError,
    isLoading,
    systemFetching,
    refetchSystem,
    providerHealth,
    providerUpdatedAt,
    providerError,
    providersFetching,
    refetchProviders,
    read.mandate,
    staleAfterMs,
    scope.drawable,
  ]);
}

/** bigint does not survive React Query's default key hashing, so amounts go in as strings. */
function keyOf(scope: ReadScope): Record<string, string | undefined> {
  return {
    mandate: scope.mandate,
    principal: scope.principal,
    agent: scope.agent,
    merchant: scope.merchant,
    capability: scope.capability,
    amount: scope.amount?.toString(),
    gasPayer: scope.gasPayer,
  };
}
