import type { Metadata } from 'next';

import { TokenView } from './token-view';

export const metadata: Metadata = {
  title: 'Token · BURSAR',
  description:
    'BRSR supply and who holds it, the path a settlement fee takes to a staker, the staking position and its loss exposure, and the bond a resolver posts.',
};

export default function TokenPage() {
  return <TokenView />;
}
