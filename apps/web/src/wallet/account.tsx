'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Address } from 'viem';
import { useAccount } from 'wagmi';
import type { Connector, State } from 'wagmi';

/**
 * The connected account, answered the same way on both sides of hydration.
 *
 * A wallet that has already granted this site reconnects as soon as the page's JavaScript runs,
 * and that reconnection can land between the document hydrating and a page's own subtree
 * hydrating. The subtree then hydrates against a store that changed underneath it: React throws
 * the server's markup away, regenerates it, and reports a hydration error on a page that was right
 * before and right after. Three ordinary readers take that path, because a wallet's permission
 * outlives the cookie that tells the server about it: a Safe app, which connects on its own with
 * no cookie at all; a private window; and anybody whose cookies were cleared while the wallet kept
 * the site.
 *
 * So until a surface has mounted, it answers with the connection the server rendered from, which
 * is the one carried in the cookie. Both sides then agree by construction, whatever the wallet
 * does in between. Afterwards it answers with the live account, and the cookie's answer is held
 * only while wagmi is still reconnecting, so a reader who was already connected never watches the
 * header flash "Connect wallet" and a reader who disconnects is not shown an address they dropped.
 */

export type WalletAccount = {
  readonly address: Address | undefined;
  readonly isConnected: boolean;
  readonly connector: Connector | undefined;
  /** The chain the connection is on. The server knows it from the cookie and from nothing else. */
  readonly chainId: number | undefined;
};

type ServerAccount = { readonly address: Address | undefined; readonly chainId: number | undefined };

const ServerAccountContext = createContext<ServerAccount>({ address: undefined, chainId: undefined });

/** What the server rendered from, handed to the tree so the first client render can match it. */
export function ServerAccountProvider({ state, children }: { readonly state: State | undefined; readonly children: ReactNode }) {
  return <ServerAccountContext.Provider value={accountFrom(state)}>{children}</ServerAccountContext.Provider>;
}

export function useWalletAccount(): WalletAccount {
  const live = useAccount();
  const server = useContext(ServerAccountContext);
  const mounted = useMounted();

  // `connecting` and `reconnecting` are wagmi still deciding. Answering with the cookie through
  // both of them is what keeps the first paint still.
  const settled = mounted && (live.status === 'connected' || live.status === 'disconnected');
  if (!settled) {
    return {
      address: server.address,
      isConnected: server.address !== undefined,
      connector: undefined,
      chainId: server.chainId,
    };
  }

  return { address: live.address, isConnected: live.isConnected, connector: live.connector, chainId: live.chainId };
}

function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * The account inside a wagmi state, which is what `cookieToInitialState` produces from the request.
 * A cookie carrying no current connection is a reader who is not connected.
 */
function accountFrom(state: State | undefined): ServerAccount {
  const current = state?.current;
  if (!state || !current) return { address: undefined, chainId: state?.chainId };

  const connection = state.connections.get(current);
  return { address: connection?.accounts[0], chainId: connection?.chainId ?? state.chainId };
}
