import type { Metadata } from 'next';

import { GovernanceView } from './governance-view';

export const metadata: Metadata = {
  title: 'Governance · Bursar',
  description:
    'Proposed changes to Bursar settings, who has approved each one, and when each can run. Every change needs two of three signatures and a fixed delay. A guardian key can pause, and only pause.',
};

export default function GovernancePage() {
  return <GovernanceView />;
}
