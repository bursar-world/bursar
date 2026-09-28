import type { Metadata } from 'next';

import { CreateMandateView } from './create-view';

export const metadata: Metadata = {
  title: 'Create a mandate · BURSAR',
  description: 'Set what an agent may spend, who it may pay and what it may buy, and read the account address before it exists.',
};

export default async function NewMandatePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { draft } = await searchParams;
  return <CreateMandateView {...(typeof draft === 'string' && draft !== '' ? { draftId: draft } : {})} />;
}
