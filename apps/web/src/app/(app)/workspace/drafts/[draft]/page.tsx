import type { Metadata } from 'next';

import { DraftView } from './draft-view';

export const metadata: Metadata = {
  title: 'Draft · Workspace · BURSAR',
  description: 'Edit a mandate draft and check a spend against its rules before activation.',
};

export default async function DraftPage({ params }: { readonly params: Promise<{ readonly draft: string }> }) {
  const { draft } = await params;
  return <DraftView draftId={draft} />;
}
