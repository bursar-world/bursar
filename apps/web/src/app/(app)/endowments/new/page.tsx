import type { Metadata } from 'next';

import { CreateEndowment } from './create-view';

export const metadata: Metadata = {
  title: 'Endow an agent · Bursar',
  description: 'Fund an AI agent once. The principal stays invested in US stocks on Robinhood Chain, and the agent spends a yearly draw from it.',
};

export default async function NewEndowmentPage({ searchParams }: { readonly searchParams: Promise<{ readonly agent?: string }> }) {
  const { agent } = await searchParams;
  return <CreateEndowment initialAgent={agent} />;
}
