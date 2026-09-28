'use client';

import { useQuery } from '@tanstack/react-query';

import { useWalletAccount } from '@/wallet/account';
import { readGovernance } from './read';
import type { Governance } from './read';
import { answerInList, answerIs } from './roles';
import type { Roles } from './roles';

export type GovernanceState = {
  readonly data: Governance | undefined;
  /**
   * What the connected wallet is. Three answers, never two: a signer set that did not come back
   * must not be rendered as a wallet that is not on it.
   */
  readonly roles: Roles;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: unknown;
  readonly refresh: () => void;
};

const REFETCH_MS = 15_000;

export function useGovernance(): GovernanceState {
  const { address } = useWalletAccount();

  const query = useQuery({
    queryKey: ['bursar', 'governance'],
    queryFn: readGovernance,
    refetchInterval: REFETCH_MS,
  });

  return {
    data: query.data,
    roles: {
      address,
      signer: answerInList(query.data?.signers, address),
      guardian: answerIs(query.data?.guardian, address),
      // The escrow treasury is not a governance role. The operator surface reads it separately.
      treasury: 'no',
    },
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error ?? null,
    refresh: () => {
      void query.refetch();
    },
  };
}
