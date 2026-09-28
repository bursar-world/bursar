'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Address } from 'viem';

import { AddressInput, readAddress } from '@/components/address-input';
import { Button } from '@/components/button';

export function deskPath(payee: Address): string {
  return `/providers/${payee}`;
}

/**
 * The way into a desk for a reader with no wallet.
 *
 * Escrow locks, the settlement record and the ceiling it earns are all public, and a payee
 * deciding whether to take work through BURSAR should be able to read another address's history
 * before they connect anything. The console answers the same question for a mandate; this is the
 * same door on the other side of the trade.
 */
export function OpenDesk({ label = 'Payee address' }: { readonly label?: string }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const payee = readAddress(text).value;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (payee !== undefined) router.push(deskPath(payee));
      }}
    >
      <AddressInput
        label={label}
        value={text}
        onChange={setText}
        hint="The address the escrow pays. Reading it signs nothing and needs no wallet."
        action={
          <Button type="submit" tone="primary" disabled={payee === undefined}>
            Open the desk
          </Button>
        }
      />
    </form>
  );
}
