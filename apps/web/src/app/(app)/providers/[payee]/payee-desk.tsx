'use client';

import Link from 'next/link';
import type { Address } from 'viem';

import { sameAddress } from '@/chain';
import { useWalletAccount } from '@/wallet/account';

import { DeskView } from '../desk-view';

/**
 * A desk opened by address.
 *
 * The reading is the same either way. What a connected wallet adds is the controls, and only when
 * it is the address on screen: a payee who arrived here from a link still gets their own stake and
 * availability panels instead of being sent back to /providers to find them.
 */
export function PayeeDesk({ payee }: { readonly payee: Address }) {
  const { address, isConnected } = useWalletAccount();
  const owned = isConnected && sameAddress(address, payee);

  return (
    <div className="space-y-6">
      <p className="text-detail text-[color:var(--color-muted)]">
        <Link href="/providers" className="underline underline-offset-2">
          Providers
        </Link>{' '}
        / this desk
      </p>
      <DeskView payee={payee} owned={owned} />
    </div>
  );
}
