import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getAddress, isAddress } from 'viem';

import { EndowmentPage } from './endowment-view';

export const metadata: Metadata = {
  title: 'Endowment · Bursar',
  description: 'An AI agent’s endowment on Robinhood Chain: the principal stays invested in US stocks, and the agent spends a yearly draw from it.',
};

export default async function Page({ params }: { readonly params: Promise<{ readonly address: string }> }) {
  const { address } = await params;
  if (!isAddress(address)) notFound();
  return <EndowmentPage address={getAddress(address)} />;
}
