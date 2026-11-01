import type { Metadata } from 'next';

import { BursarTokenView } from './bursar-token';

export const metadata: Metadata = {
  title: 'Token · Bursar',
  description: '$BURSAR on Robinhood Chain: the contract address and where to trade it.',
};

export default function TokenPage() {
  return <BursarTokenView />;
}
