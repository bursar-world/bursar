'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { Workspace } from './model';
import { WorkspaceSession } from './session';
import { browserStore } from './store';
import type { StorageMode } from './store';

export type WorkspaceView =
  | { readonly status: 'loading' }
  /** This browser offers no IndexedDB, so nothing can be kept. */
  | { readonly status: 'unavailable' }
  | { readonly status: 'none' }
  | { readonly status: 'locked'; readonly updatedAt: string | null }
  | { readonly status: 'unlocked'; readonly workspace: Workspace; readonly updatedAt: string | null };

export type WorkspaceActions = {
  readonly storage: StorageMode;
  readonly create: (passphrase: string) => Promise<void>;
  readonly unlock: (passphrase: string) => Promise<void>;
  readonly lock: () => void;
  /** Applies a change and writes the whole workspace again, sealed under a fresh IV. */
  readonly update: (change: (current: Workspace) => Workspace) => Promise<void>;
  readonly exportBackup: () => Promise<string>;
  readonly importBackup: (text: string, passphrase: string) => Promise<void>;
  readonly remove: () => Promise<void>;
};

type Value = { readonly view: WorkspaceView; readonly actions: WorkspaceActions };

const WorkspaceContext = createContext<Value | null>(null);

/**
 * Holds the one workspace session for the page.
 *
 * It sits above every route, so moving between the console and the workspace keeps it open. It
 * keeps nothing across a reload: the key and the drafts live in this component's memory and
 * nowhere else, which is what "an unlocked browser can read the workspace until you lock it or
 * close the page" means in practice.
 */
export function WorkspaceProvider({ children }: { readonly children: ReactNode }) {
  const session = useRef<WorkspaceSession | null>(null);
  const [view, setView] = useState<WorkspaceView>({ status: 'loading' });

  const current = useCallback((): WorkspaceSession => {
    if (session.current === null) session.current = new WorkspaceSession(browserStore());
    return session.current;
  }, []);

  const refresh = useCallback(async () => {
    const s = current();
    const status = await s.status();
    setView(
      status === 'unlocked'
        ? { status, workspace: s.workspace, updatedAt: s.updatedAt }
        : status === 'locked'
          ? { status, updatedAt: s.updatedAt }
          : { status: 'none' },
    );
  }, [current]);

  useEffect(() => {
    if (typeof indexedDB === 'undefined') {
      setView({ status: 'unavailable' });
      return;
    }
    refresh().catch(() => setView({ status: 'unavailable' }));
  }, [refresh]);

  const actions = useMemo<WorkspaceActions>(
    () => ({
      storage: 'browser',
      create: async (passphrase) => {
        await current().create(passphrase);
        await refresh();
      },
      unlock: async (passphrase) => {
        await current().unlock(passphrase);
        await refresh();
      },
      lock: () => {
        current().lock();
        void refresh();
      },
      update: async (change) => {
        const s = current();
        await s.save(change(s.workspace));
        await refresh();
      },
      exportBackup: () => current().exportBackup(),
      importBackup: async (text, passphrase) => {
        await current().importBackup(text, passphrase);
        await refresh();
      },
      remove: async () => {
        await current().remove();
        await refresh();
      },
    }),
    [current, refresh],
  );

  const value = useMemo(() => ({ view, actions }), [view, actions]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): Value {
  const value = useContext(WorkspaceContext);
  if (value === null) throw new Error('useWorkspace needs a WorkspaceProvider above it.');
  return value;
}
