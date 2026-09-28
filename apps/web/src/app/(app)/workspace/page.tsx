import type { Metadata } from 'next';

import { WorkspaceView } from './workspace-view';

export const metadata: Metadata = {
  title: 'Workspace · BURSAR',
  description: 'Prepare encrypted mandate drafts, organize agents, check spending rules and export your workspace.',
};

export default function WorkspacePage() {
  return <WorkspaceView />;
}
