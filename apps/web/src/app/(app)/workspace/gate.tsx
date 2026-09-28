'use client';

import type { ReactNode } from 'react';

import { EmptyState, Skeleton } from '@/components/layout';
import { useWorkspace } from '@/workspace/context';
import type { Workspace } from '@/workspace/model';
import { CreateWorkspaceForm, ImportBackupForm, UnlockForm } from './passphrase';

/**
 * Whatever a workspace screen needs before it can show a draft: a workspace, and the passphrase
 * that opens it. Children render only once it is open.
 */
export function WorkspaceGate({ children }: { readonly children: (workspace: Workspace) => ReactNode }) {
  const { view } = useWorkspace();

  switch (view.status) {
    case 'loading':
      return (
        <div aria-busy="true" aria-live="polite">
          <Skeleton width="16rem" height={20} />
        </div>
      );
    case 'unavailable':
      return (
        <EmptyState title="This browser cannot keep a workspace.">
          It offers no local storage to this page, which happens in some private windows. Open the console in a regular
          window to create one.
        </EmptyState>
      );
    case 'none':
      return (
        <div className="grid gap-6 lg:grid-cols-2">
          <CreateWorkspaceForm />
          <ImportBackupForm replacing={false} />
        </div>
      );
    case 'locked':
      return (
        <div className="grid gap-6 lg:grid-cols-2">
          <UnlockForm />
          <ImportBackupForm replacing />
        </div>
      );
    case 'unlocked':
      return <>{children(view.workspace)}</>;
  }
}
