import type { Metadata } from 'next';

import { DraftView } from './draft-view';

export const metadata: Metadata = {
  title: 'Draft · Workspace · BURSAR',
  description: 'Edit a mandate draft and check a payment against it before you create the mandate.',
};

export default async function DraftPage({ params }: { readonly params: Promise<{ readonly draft: string }> }) {
  const { draft } = await params;
  return <DraftView draftId={draft} />;
}
