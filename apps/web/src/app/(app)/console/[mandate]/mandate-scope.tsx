'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Address } from 'viem';
import type { Micro } from '@bursar/core';

import { mandateCodeVersion } from '@/chain/mandates';
import { sameAddress } from '@/chain/rhc';
import type { MandateRead } from '@/chain/reader';
import type { TxContext } from '@/components/tx-button';
import { useSystemState } from '@/state';
import type { SystemState } from '@/state';
import { useWalletAccount } from '@/wallet/account';
import { onWrongChain } from '@/wallet/write';
import { readDrawable } from '../lib/rwa';
import { useMandateLedger } from '../lib/use-ledger';
import type { MandateLedger } from '../lib/use-ledger';

/** A payment nobody has made, put to the contract to see what it would decide. */
export type Proposed = {
  readonly merchant?: Address;
  readonly capability?: string;
  readonly amount?: Micro;
};

/**
 * What stands at the address in the URL, decided before any screen under it renders a control.
 *
 * `foreign` is a contract that reads like a mandate and was not made by the factory. `absent` is an
 * address with no mandate account at all. `unread` is a reading that never landed, which says
 * nothing about the address either way.
 */
export type MandateStanding = 'checking' | 'mandate' | 'foreign' | 'absent' | 'unread';

export function mandateStanding(reading: {
  readonly address: Address;
  /** The system reading has landed at least once. */
  readonly read: boolean;
  readonly account: MandateRead | undefined;
  readonly failed: boolean;
  /** The factory's answer for this account and its principal, once it has given one. */
  readonly listed: boolean | undefined;
}): MandateStanding {
  if (!reading.read) return reading.failed ? 'unread' : 'checking';
  if (reading.account === undefined) return 'absent';
  // A reading held over from the previous address while this one loads is not about this one.
  if (!sameAddress(reading.account.address, reading.address)) return 'checking';
  if (reading.listed === undefined) return reading.failed ? 'unread' : 'checking';
  return reading.listed ? 'mandate' : 'foreign';
}

export type MandateScope = {
  readonly address: Address;
  readonly system: SystemState;
  /** Set only once the factory has vouched for the account. */
  readonly account: MandateRead | undefined;
  readonly standing: MandateStanding;
  /** Why the standing is `unread`, when it is. */
  readonly standingError: unknown;
  readonly ledger: MandateLedger;
  /** The connected wallet, which pays the fee on anything sent from these screens. */
  readonly connected: Address | undefined;
  /**
   * The connected wallet owns this mandate and is on this network, so the controls on these screens
   * will be accepted. An owner on another network sees no controls until it switches.
   */
  readonly isOwner: boolean;
  /** The owner is connected, on another network. */
  readonly ownerOffChain: boolean;
  /** The payment the permission and mandate readings above are currently answering about. */
  readonly proposed: Proposed;
  readonly propose: (next: Proposed) => void;
  /**
   * What every write on these screens hands the classifier when it fails. The account and the two
   * balances are the same for all of them; a panel spreads the amount and the payee on top.
   */
  readonly writeContext: TxContext;
  readonly refresh: () => void;
};

const Scope = createContext<MandateScope | null>(null);

/** The provider's context, for a test that renders a screen against a scope it wrote by hand. */
export const MandateScopeContext = Scope;

/**
 * One reading of one mandate, shared by every screen under it.
 *
 * The five states, the account itself, its history and its gates are read here and nowhere else in
 * this section. Each screen asking for its own copy would multiply one batched request by the
 * number of screens open, against a network that meters arrivals.
 */
export function MandateScopeProvider({ address, children }: { readonly address: Address; readonly children: ReactNode }) {
  const wallet = useWalletAccount();
  const connected = wallet.address;
  const offChain = onWrongChain(wallet);
  const [proposed, propose] = useState<Proposed>(EMPTY);
  const drawable = useQuery({
    queryKey: ['console', 'drawable', address],
    queryFn: () => readDrawable(address),
    refetchInterval: 60_000,
  });
  const system = useSystemState({
    mandate: address,
    ...proposed,
    ...(drawable.data === undefined ? {} : { drawable: drawable.data as Micro }),
  });
  const read = system.mandate.facts.account;
  const ledger = useMandateLedger(address, connected, read !== undefined && sameAddress(read.address, address) ? read.escrow : undefined);
  const principal = read !== undefined && sameAddress(read.address, address) ? read.principal : undefined;

  // Code at an address does not change, so one answer per address holds for the life of the page.
  // It waits for the account read so an address that is not a mandate at all takes the absent path.
  const provenance = useQuery({
    queryKey: ['console', 'provenance', address],
    queryFn: async () => (await mandateCodeVersion(address)) !== undefined,
    enabled: principal !== undefined,
    staleTime: Infinity,
  });

  const standing = mandateStanding({
    address,
    read: system.snapshot !== undefined,
    account: read,
    failed: system.snapshot === undefined ? Boolean(system.error) : provenance.error !== null,
    listed: provenance.data,
  });
  const account = standing === 'mandate' ? read : undefined;
  const standingError = system.snapshot === undefined ? system.error : provenance.error;
  const refetchProvenance = provenance.refetch;

  // Every panel under this provider reads the whole scope, so a new object here re-renders all of
  // them. The memo only pays off while its dependencies hold their identity between renders, which
  // is why the ledger is memoised at its source.
  const value = useMemo<MandateScope>(
    () => ({
      address,
      system,
      account,
      standing,
      standingError,
      ledger,
      connected,
      isOwner: !offChain && sameAddress(connected, account?.principal),
      ownerOffChain: offChain && sameAddress(connected, account?.principal),
      proposed,
      propose,
      writeContext: { mandate: address, facts: system.mandate.facts, funding: system.funding.facts },
      refresh: () => {
        system.refresh();
        ledger.refresh();
        if (standing === 'unread') void refetchProvenance();
      },
    }),
    [address, system, account, standing, standingError, refetchProvenance, ledger, connected, offChain, proposed],
  );

  return <Scope.Provider value={value}>{children}</Scope.Provider>;
}

export function useMandateScope(): MandateScope {
  const value = useContext(Scope);
  if (!value) throw new Error('useMandateScope was called outside the mandate section of the console.');
  return value;
}

const EMPTY: Proposed = {};
