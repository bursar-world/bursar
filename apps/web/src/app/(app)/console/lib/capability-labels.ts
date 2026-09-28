'use client';

import { toCapabilityId } from '@bursar/core';
import { useCallback, useSyncExternalStore } from 'react';
import type { Hex } from 'viem';

import { publishedCapability } from '@/chain/capabilities';

/**
 * The name behind a capability hash.
 *
 * A capability reaches the chain as a hash, and a hash does not come back. `doc.summarize:1` and
 * the 32 bytes it produces are the same thing to the contract and nothing like the same thing to
 * the person reading a settlement.
 *
 * Two sources answer it, and both answer the same way the preview panel does: hash a candidate
 * name and compare the id. The names this product publishes are compiled in, so a console opened
 * for the first time already reads them. Every name typed into this console joins them on this
 * browser, because whoever names a capability in order to allow it is the person who knows what it
 * is called.
 *
 * Nothing is read from here for a decision, a name is never sent anywhere, and an id that matches
 * neither source is shown as the id. Guessing at it is the one thing this must never do.
 */

const KEY = 'mandate.capability-labels.v1';

let labels: Record<string, string> = {};
let loaded = false;
const listeners = new Set<() => void>();

function load(): void {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) labels = JSON.parse(raw) as Record<string, string>;
  } catch {
    labels = {};
  }
}

function save(): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(labels));
  } catch {
    // A browser with storage switched off still runs the console. It just forgets the labels.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): Record<string, string> {
  load();
  return labels;
}

/**
 * The server has no local storage, so it renders whatever the published names answer and the
 * browser fills in the rest. A published name resolves identically on both sides.
 */
const EMPTY: Record<string, string> = {};

export function useCapabilityLabels(): {
  readonly labelFor: (id: Hex) => string | undefined;
  readonly remember: (label: string) => Hex;
} {
  const current = useSyncExternalStore(subscribe, snapshot, () => EMPTY);

  const labelFor = useCallback((id: Hex) => current[id.toLowerCase()] ?? publishedCapability(id), [current]);

  const remember = useCallback((label: string) => {
    const trimmed = label.trim();
    const id = toCapabilityId(trimmed);
    load();
    // A label that is already the id carries no words worth keeping.
    if (trimmed.toLowerCase() !== id.toLowerCase() && labels[id.toLowerCase()] !== trimmed) {
      labels = { ...labels, [id.toLowerCase()]: trimmed };
      save();
    }
    return id;
  }, []);

  return { labelFor, remember };
}
