import type { Metadata } from 'next';

import { GovernanceView } from './governance-view';

export const metadata: Metadata = {
  title: 'Governance · BURSAR',
  description:
    'Pending changes to BURSAR parameters, who has approved each one, and when it becomes executable. Two of three signatures and a 48-hour delay on every contract; a guardian key can pause, and only pause.',
};

export default function GovernancePage() {
  return <GovernanceView />;
}
