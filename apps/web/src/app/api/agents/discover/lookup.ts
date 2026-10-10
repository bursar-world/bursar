import { createIndexClient, erc8004Registries } from '@bursar/core';
import { getAddress } from 'viem';
import type { Address } from 'viem';

import { CHAIN_ID } from '@/chain/rhc';

/**
 * Which ERC-8004 identities an address owns, asked of the indexes that watch the registry.
 *
 * The registry itself has no list per owner and its history is too long to scan from a browser, so
 * the ids are found here and proved afterwards: every id this returns is read back from the
 * registry before anything is shown. Two indexes are asked and their answers joined. 8004scan is
 * keyless and indexes this chain; the Blockscout index needs this deployment's key and sees a
 * fresh registration sooner. Either one being down costs nothing but freshness.
 */
export type Discovered = {
  readonly ids: readonly string[];
  readonly sources: readonly { readonly name: 'scan' | 'index'; readonly ok: boolean }[];
};

const SCAN_API = 'https://api.8004scan.io/api/v1';
const TIMEOUT_MS = 8_000;

export async function discoverIdentities(owner: Address, fetchFn: typeof fetch = fetch): Promise<Discovered> {
  const registries = erc8004Registries(CHAIN_ID);
  if (registries === undefined) return { ids: [], sources: [] };
  const identity = registries.identity.toLowerCase();
  const holder = getAddress(owner);

  const [scan, index] = await Promise.all([fromScan(holder, identity, fetchFn), fromIndex(holder, identity, fetchFn)]);
  const ids = [...new Set([...scan.ids, ...index.ids])].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return {
    ids,
    sources: [
      { name: 'scan', ok: scan.ok },
      { name: 'index', ok: index.ok },
    ],
  };
}

type Answer = { readonly ids: readonly string[]; readonly ok: boolean };

async function fromScan(owner: Address, identity: string, fetchFn: typeof fetch): Promise<Answer> {
  try {
    const response = await fetchFn(`${SCAN_API}/agents?owner_address=${owner.toLowerCase()}&limit=100`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { ids: [], ok: false };
    const body = (await response.json()) as { items?: unknown };
    const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
    return {
      ok: true,
      ids: items
        .filter((item) => Number(item['chain_id']) === CHAIN_ID && String(item['contract_address'] ?? '').toLowerCase() === identity)
        .map((item) => String(item['token_id'] ?? ''))
        .filter((id) => /^\d+$/.test(id)),
    };
  } catch {
    return { ids: [], ok: false };
  }
}

async function fromIndex(owner: Address, identity: string, fetchFn: typeof fetch): Promise<Answer> {
  let client;
  try {
    client = createIndexClient({ chainId: CHAIN_ID, timeoutMs: TIMEOUT_MS, fetchFn });
  } catch {
    // No key configured. The route says nothing about it; the other index still answers.
    return { ids: [], ok: false };
  }

  try {
    const body = await client.get<{ items?: unknown }>(`/tokens/${identity}/instances`, { holder_address_hash: owner });
    const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
    return { ok: true, ids: items.map((item) => String(item['id'] ?? '')).filter((id) => /^\d+$/.test(id)) };
  } catch {
    return { ids: [], ok: false };
  }
}
