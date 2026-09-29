import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ShieldedView } from './shielded-view';

export const metadata: Metadata = {
  title: 'Shielded funds · BURSAR',
  description: 'Fund mandates, hidden owners and providers from a USDG pool, with no on-chain link back to your wallet.',
};

export default function ShieldedPage() {
  return (
    <Suspense>
      <ShieldedView />
    </Suspense>
  );
}
