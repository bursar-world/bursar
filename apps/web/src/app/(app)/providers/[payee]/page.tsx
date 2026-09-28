import type { Metadata } from 'next';
import { getAddress } from 'viem';

import { shortAddress } from '@/chain';
import { readsAsAddress } from '@/lib/path';

import { PayeeDesk } from './payee-desk';
import { UnreadablePayee } from './unreadable-payee';

type Params = { readonly params: Promise<{ readonly payee: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { payee } = await params;

  if (!readsAsAddress(payee)) {
    return { title: 'Not an address · BURSAR', description: 'This URL names something the escrow could never pay.' };
  }

  return {
    title: `Payee ${shortAddress(getAddress(payee))} · BURSAR`,
    description:
      'Locks held against this address, how they settled, the disputes against it, and the ceiling its record earns. Read from the chain without a wallet.',
  };
}

export default async function PayeePage({ params }: Params) {
  const { payee } = await params;

  // The escrow pays an address, so the address in the URL is checked before anything is read
  // against it. Checksum is not demanded of whoever typed it; it is applied here.
  if (!readsAsAddress(payee)) return <UnreadablePayee typed={payee} />;

  return <PayeeDesk payee={getAddress(payee)} />;
}
