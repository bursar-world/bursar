'use client';

import { useCallback } from 'react';
import { useWriteContract as useWagmiWriteContract } from 'wagmi';

import { CHAIN_ID } from '../chain/rhc';

/**
 * A write's parameters, pinned to the chain this build is deployed on.
 *
 * Without a chain id wagmi sends on whatever network the wallet happens to be on. The contracts on
 * another network are not ours even at the same address, so a call signed there is a call to
 * somebody else's code. With it, wagmi and viem both compare the wallet's network before the
 * wallet opens and refuse the call instead of asking anyone to sign it.
 */
export function pinChain<T extends object>(variables: T): T & { readonly chainId: typeof CHAIN_ID } {
  return { ...variables, chainId: CHAIN_ID };
}

/**
 * wagmi's `useWriteContract`, with every call pinned to the deployment chain.
 *
 * Every write in this app goes through here rather than through wagmi directly, so the pin is one
 * rule in one place and not a property fifty call sites each have to remember.
 */
export function useWriteContract(): ReturnType<typeof useWagmiWriteContract> {
  const write = useWagmiWriteContract();
  const { writeContractAsync: unpinned } = write;

  // The cast keeps wagmi's own signature, which is what infers each call's function name and
  // arguments from its ABI. The body only adds a field that signature already accepts.
  const writeContractAsync = useCallback(
    ((variables, options) => unpinned(pinChain(variables), options)) as typeof unpinned,
    [unpinned],
  );

  return { ...write, writeContractAsync };
}

/** The connection as the chain guard needs it. */
export type ChainReading = { readonly isConnected: boolean; readonly chainId: number | undefined };

/**
 * Whether a connected wallet is on a network other than the deployment's.
 *
 * A wallet that is not connected is not on the wrong network: it has no network, and the button it
 * would press asks it to connect first. A connected wallet whose network is not known yet is
 * treated as wrong, because a guess in that direction costs a click and a guess the other way
 * costs a signature on the wrong chain.
 */
export function onWrongChain(account: ChainReading): boolean {
  return account.isConnected && account.chainId !== CHAIN_ID;
}
