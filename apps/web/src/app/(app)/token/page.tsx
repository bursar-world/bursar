import type { Metadata } from 'next';

import { TokenView } from './token-view';

export const metadata: Metadata = {
  title: 'Token · BURSAR',
  description:
    'BRSR supply and holders, where settlement fees go, staking, and the bond resolvers post.',
};

export default function TokenPage() {
  return <TokenView />;
}
