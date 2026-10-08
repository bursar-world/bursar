import type { Metadata } from 'next';

import { WorkspaceView } from './workspace-view';

export const metadata: Metadata = {
  title: 'Workspace · BURSAR',
  description: 'Draft a mandate privately and check a payment against it before anything goes on chain.',
};

export default function WorkspacePage() {
  return <WorkspaceView />;
}
