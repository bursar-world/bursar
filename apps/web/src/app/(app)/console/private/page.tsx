import type { Metadata } from 'next';

import { PrivateOwnersView } from './private-owners-view';

export const metadata: Metadata = {
  title: 'Private mandates · BURSAR',
  description: 'Mandates owned by stealth addresses drawn from your wallet, found again from one signature.',
};

export default function PrivateOwnersPage() {
  return <PrivateOwnersView />;
}
