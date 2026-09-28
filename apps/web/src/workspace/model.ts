import type { SpendClass } from '@bursar/core';

import type { LimitsDraft } from '@/app/(app)/console/limits-form';
import { EMPTY_DRAFT } from '@/app/(app)/console/limits-form';

/**
 * What a workspace holds once it is open. None of this is ever written anywhere in this form: it
 * exists in memory while the workspace is unlocked, and as ciphertext everywhere else.
 */

export type WorkspaceAgent = {
  readonly id: string;
  readonly name: string;
  /** As typed. Checked when a draft that uses it is activated. */
  readonly address: string;
  readonly notes: string;
};

/** One capability a draft allows, named without its class namespace. */
export type DraftCapability = { readonly spendClass: SpendClass; readonly label: string };

export type MandateDraft = {
  readonly id: string;
  readonly name: string;
  readonly notes: string;
  /** The agent's address as typed. Picking a saved agent fills it in. */
  readonly agent: string;
  readonly limits: LimitsDraft;
  readonly classes: Readonly<Record<SpendClass, boolean>>;
  readonly capabilities: readonly DraftCapability[];
  readonly payees: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set once the draft has been deployed from the create screen. */
  readonly activated: { readonly address: string; readonly hash: string; readonly at: string } | null;
};

export type Workspace = {
  readonly version: 1;
  readonly drafts: readonly MandateDraft[];
  readonly agents: readonly WorkspaceAgent[];
};

export const EMPTY_WORKSPACE: Workspace = { version: 1, drafts: [], agents: [] };

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function newDraft(now = new Date()): MandateDraft {
  const at = now.toISOString();
  return {
    id: newId(),
    name: '',
    notes: '',
    agent: '',
    limits: EMPTY_DRAFT,
    classes: { service: true, hire: false, rwa: false },
    capabilities: [],
    payees: [],
    createdAt: at,
    updatedAt: at,
    activated: null,
  };
}

export function draftTitle(draft: MandateDraft): string {
  return draft.name.trim() === '' ? 'Untitled draft' : draft.name.trim();
}

export function upsert<T extends { readonly id: string }>(list: readonly T[], item: T): readonly T[] {
  return list.some((entry) => entry.id === item.id) ? list.map((entry) => (entry.id === item.id ? item : entry)) : [...list, item];
}

/**
 * A decrypted workspace, checked before it is trusted. A backup is a file a person hands this page,
 * so its plaintext is read as input: anything that is not a workspace is refused whole.
 */
export function readWorkspace(value: unknown): Workspace {
  if (value === null || typeof value !== 'object') throw new Error('The workspace did not decrypt to a workspace.');
  const shaped = value as { version?: unknown; drafts?: unknown; agents?: unknown };
  if (shaped.version !== 1 || !Array.isArray(shaped.drafts) || !Array.isArray(shaped.agents)) {
    throw new Error('The workspace did not decrypt to a workspace this console can read.');
  }
  return {
    version: 1,
    drafts: shaped.drafts.map((draft) => ({ ...newDraft(), ...(draft as MandateDraft) })),
    agents: shaped.agents as WorkspaceAgent[],
  };
}
