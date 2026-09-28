import type { Metadata } from 'next';

import { ApprovalsView } from './approvals-view';

export const metadata: Metadata = {
  title: 'Approvals · BURSAR',
  description: 'Consent for the payments this mandate will not make without the account owner.',
};

export default function ApprovalsPage() {
  return <ApprovalsView />;
}
