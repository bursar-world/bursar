import type { Metadata } from 'next';

import { ApprovalsView } from './approvals-view';

export const metadata: Metadata = {
  title: 'Approvals · Bursar',
  description: 'Approve the payments above this mandate’s threshold.',
};

export default function ApprovalsPage() {
  return <ApprovalsView />;
}
