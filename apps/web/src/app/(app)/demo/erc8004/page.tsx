import type { Metadata } from 'next';

import { DemoView } from './demo-view';

export const metadata: Metadata = {
  title: 'ERC-8004 identities · Bursar',
  description: 'Every Bursar provider and mandate agent can carry an ERC-8004 identity on Robinhood Chain, listed on 8004scan and OpenSea.',
};

export default function Erc8004DemoPage() {
  return <DemoView />;
}
