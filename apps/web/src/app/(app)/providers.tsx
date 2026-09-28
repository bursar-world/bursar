'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import type { State } from 'wagmi';

import { ServerAccountProvider } from '../../wallet/account';
import { wagmiConfig } from '../../wallet/config';
import { WorkspaceProvider } from '../../workspace/context';

/**
 * `initialState` comes from the request's own cookie, so a reader who was already connected does
 * not watch the header flash "Connect wallet" before hydration catches up.
 *
 * Retries are off. Every read in this app is already retried across two endpoints by the pool, and
 * a second retry layer on top of that turns one slow endpoint into four requests against a meter
 * that charges by the request.
 */
export function Providers({ children, initialState }: { readonly children: ReactNode; readonly initialState?: State }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: 5_000,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig()} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        {/*
          Every surface reads the account through this rather than through wagmi directly, so the
          first client render answers with whatever the server rendered from. A wallet that
          reconnects itself mid-hydration would otherwise leave a page hydrating against a store
          that had already moved.
        */}
        <ServerAccountProvider state={initialState}>
          <WorkspaceProvider>{children}</WorkspaceProvider>
        </ServerAccountProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
