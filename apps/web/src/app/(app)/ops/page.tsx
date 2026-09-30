import type { Metadata } from 'next';

import { OpsView } from './ops-view';

export const metadata: Metadata = {
  title: 'Operations · BURSAR',
  description:
    'Sweep settlement fees to the treasury, rotate the treasury in two steps, and propose the staking rebate tiers and the buyback price ceiling.',
};

export default function OpsPage() {
  return <OpsView />;
}
