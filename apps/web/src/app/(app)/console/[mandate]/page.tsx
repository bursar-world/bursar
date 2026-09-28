import type { Metadata } from 'next';

import { OverviewView } from './overview-view';

export const metadata: Metadata = {
  title: 'Mandate · BURSAR',
  description: 'What this mandate has left, what it holds, who it may pay, and how to stop it.',
};

export default function MandatePage() {
  return <OverviewView />;
}
