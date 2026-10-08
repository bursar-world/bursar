import type { Metadata } from 'next';

import { PrivateOwnersView } from './private-owners-view';

export const metadata: Metadata = {
  title: 'Private mandates · BURSAR',
  description: 'Find and manage the private mandates your wallet owns.',
};

export default function PrivateOwnersPage() {
  return <PrivateOwnersView />;
}
