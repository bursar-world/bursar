import type { Metadata } from 'next';

import { readFundingLane } from '@/chain/mandates';
import { CreateMandateView } from './create-view';

export const metadata: Metadata = {
  title: 'Create a mandate · Bursar',
  description: "Set your agent's limits and payees, and see the mandate's address before it exists.",
};

export default async function NewMandatePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { draft, lane } = await searchParams;
  const funding = readFundingLane(lane);
  return (
    <CreateMandateView
      {...(typeof draft === 'string' && draft !== '' ? { draftId: draft } : {})}
      {...(funding !== undefined ? { lane: funding } : {})}
    />
  );
}
