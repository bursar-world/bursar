import type { Metadata } from 'next';

import { GovernanceView } from './governance-view';

export const metadata: Metadata = {
  title: 'Governance · BURSAR',
  description:
    'Pending changes to BURSAR parameters, who has approved each one, and when it becomes executable. Two of three signatures and a fixed delay: one hour on the payment contracts, 48 hours on the token.',
};

export default function GovernancePage() {
  return <GovernanceView />;
}
