'use client';

import { useQuery } from '@tanstack/react-query';

import { useWalletAccount } from '@/wallet/account';
import { answerInList, answerIs } from '../governance/roles';
import { readOps } from './read';
import type { OpsRead } from './read';
import type { OpsRoles } from './gate';

export type OpsState = {
  readonly data: OpsRead | undefined;
  readonly roles: OpsRoles;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: unknown;
  readonly refresh: () => void;
};

const REFETCH_MS = 20_000;

export function useOps(): OpsState {
  const { address } = useWalletAccount();

  const query = useQuery({
    queryKey: ['bursar', 'ops'],
    queryFn: readOps,
    refetchInterval: REFETCH_MS,
  });

  return {
    data: query.data,
    roles: {
      address,
      signer: answerInList(query.data?.signers, address),
      guardian: answerIs(query.data?.guardian, address),
      treasury: answerIs(query.data?.treasury.current, address),
      // The address step one named, which is the only one that can complete the rotation. A
      // rotation to a fresh multisig leaves it holding nothing else on this page.
      incomingTreasury: answerIs(query.data?.treasury.pending, address),
    },
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error ?? null,
    refresh: () => {
      void query.refetch();
    },
  };
}
