import type { Metadata } from 'next';

import { SettlementsView } from './settlements-view';

export const metadata: Metadata = {
  title: 'Settlements · BURSAR',
  description: 'What this mandate paid, to whom, for what capability, and what became of each payment.',
};

export default function SettlementsPage() {
  return <SettlementsView />;
}
