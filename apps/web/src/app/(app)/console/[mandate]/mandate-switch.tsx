'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Address } from 'viem';

import { privateContracts, readCommittedMandate } from '@/chain/private';
import { Skeleton } from '@/components/layout';
import { CommittedMandateView } from './committed-view';
import { MandateChrome } from './mandate-chrome';
import { MandateScopeProvider } from './mandate-scope';

/**
 * Private mandates are a different contract with a different set of readings, so the address is
 * asked first whether one of the private-mandate factories made it. Anything else goes on to the
 * standard mandate screens and their own provenance check.
 */
export function MandateSwitch({ address, children }: { readonly address: Address; readonly children: ReactNode }) {
  const enabled = privateContracts() !== undefined;
  const committed = useQuery({
    queryKey: ['console', 'committed', address],
    queryFn: async () => (await readCommittedMandate(address)) ?? null,
    enabled,
  });

  if (enabled && committed.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton height={18} />
        <Skeleton width="60%" height={18} />
      </div>
    );
  }

  if (committed.data) {
    return <CommittedMandateView mandate={committed.data} onRefresh={() => void committed.refetch()} />;
  }

  return (
    <MandateScopeProvider address={address}>
      <MandateChrome>{children}</MandateChrome>
    </MandateScopeProvider>
  );
}
