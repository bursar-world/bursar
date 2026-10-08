import type { Metadata } from 'next';

import { OverviewView } from './overview-view';

export const metadata: Metadata = {
  title: 'Mandate · Bursar',
  description: 'See what this mandate can spend and manage how it pays.',
};

export default function MandatePage() {
  return <OverviewView />;
}
