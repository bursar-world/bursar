import {
  BURSAR_SUBJECT_KEY,
  RULING_FEEDBACK_TAG,
  agentRegistryId,
  erc8004Registries,
  identityRegistryAbi,
  openseaAgentUrl,
  reputationRegistryAbi,
  scanAgentUrl,
} from '@bursar/core';
import type { Erc8004Registries } from '@bursar/core';
import { getAddress, parseEventLogs } from 'viem';
import type { Address, Hex, TransactionReceipt } from 'viem';
import { multicall, readContract } from 'viem/actions';

import { CHAIN_ID, MULTICALL3, deployment, explorerAddress } from './rhc';
import type { RhcPublicClient } from '@bursar/core';

/**
 * ERC-8004 identities, read from the standard's registry on this chain.
 *
 * A Bursar address, a provider's payee address or a mandate account, is the subject of an
 * identity. The registry mints the identity to whoever sends the registration, so a provider owns
 * its own and a mandate's identity belongs to the mandate's owner. What ties the token to the
 * subject is on the registry itself: the `bursar.subject` metadata entry set at registration, or
 * a token URI that is this console's card for the subject. Nothing here trusts an id it has not
 * read back from the registry.
 */

/** The registries on this chain. Undefined on a chain the standard has not reached. */
export const REGISTRIES: Erc8004Registries | undefined = erc8004Registries(CHAIN_ID);

/** The `register(agentURI, metadata)` overload on its own, so a write names one function. */
export const REGISTER_WITH_METADATA_ABI = [identityRegistryAbi[1]] as const;

export const SET_AGENT_URI_ABI = [identityRegistryAbi[2]] as const;

export type AgentIdentity = {
  readonly agentId: bigint;
  readonly owner: Address;
  readonly uri: string;
  readonly subject: Address;
  readonly registry: Address;
  readonly agentRegistry: string;
  readonly scanUrl: string;
  readonly openseaUrl: string;
  readonly explorerUrl: string;
  readonly cardUrl: string;
  /** The token URI is this console's live card for the subject. */
  readonly pointsAtCard: boolean;
};

/** What the resolver service has posted about an agent: the count and the mean of its rulings. */
export type RulingFeedback = {
  readonly count: number;
  readonly average: number | undefined;
  readonly clients: readonly Address[];
};

export type IdentityReading = {
  readonly identity: AgentIdentity | undefined;
  /** Further identities that also name the subject, oldest first. The first is the one shown. */
  readonly others: readonly AgentIdentity[];
  readonly rulings: RulingFeedback | undefined;
  readonly cardUrl: string;
};

/** Where this console serves the subject's card. The same string is what a registration points at. */
export function cardUrl(site: string, subject: Address): string {
  return `${site.replace(/\/+$/, '')}/agents/${getAddress(subject)}/card.json`;
}

/**
 * The origin a card is served from, for a browser.
 *
 * A deployment names itself so a registration made from any host, a preview or a local build
 * against mainnet included, points at the console that will keep serving the card.
 */
export function siteOrigin(): string {
  const declared = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (declared !== undefined && declared !== '') return declared.replace(/\/+$/, '');
  if (typeof window !== 'undefined') return window.location.origin;
  return 'https://app.bursar.world';
}

/** The resolver addresses on record, the clients whose feedback is a ruling. */
export function resolverAddresses(): readonly Address[] {
  return deployment().roles.resolvers;
}

function sameHex(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/**
 * The identities among `candidates` that stand for `subject`, read from the registry. A candidate
 * is kept when its `bursar.subject` entry names the subject or its URI is the subject's card; an
 * id that fails either read is dropped, never assumed.
 */
export async function verifyIdentities(
  client: RhcPublicClient,
  candidates: readonly bigint[],
  subject: Address,
  card: string,
): Promise<readonly AgentIdentity[]> {
  const registries = REGISTRIES;
  if (registries === undefined || candidates.length === 0) return [];

  const ids = [...new Set(candidates.map((id) => id.toString()))].map((id) => BigInt(id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const identity = registries.identity;
  const answers = await multicall(client, {
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: ids.flatMap((agentId) => [
      { address: identity, abi: identityRegistryAbi, functionName: 'ownerOf', args: [agentId] } as const,
      { address: identity, abi: identityRegistryAbi, functionName: 'tokenURI', args: [agentId] } as const,
      { address: identity, abi: identityRegistryAbi, functionName: 'getMetadata', args: [agentId, BURSAR_SUBJECT_KEY] } as const,
    ]),
  });

  const found: AgentIdentity[] = [];
  ids.forEach((agentId, index) => {
    const owner = answers[index * 3];
    const uri = answers[index * 3 + 1];
    const named = answers[index * 3 + 2];
    if (owner?.status !== 'success' || uri?.status !== 'success') return;
    const namesSubject = named?.status === 'success' && sameHex(named.result as string, subject);
    const pointsAtCard = sameHex(uri.result as string, card);
    if (!namesSubject && !pointsAtCard) return;
    found.push({
      agentId,
      owner: getAddress(owner.result as Address),
      uri: uri.result as string,
      subject: getAddress(subject),
      registry: identity,
      agentRegistry: agentRegistryId(CHAIN_ID, identity),
      scanUrl: scanAgentUrl(CHAIN_ID, agentId) ?? '',
      openseaUrl: openseaAgentUrl(CHAIN_ID, agentId) ?? '',
      explorerUrl: explorerAddress(identity),
      cardUrl: card,
      pointsAtCard,
    });
  });
  return found;
}

/** The rulings posted for an agent by the resolvers on record, summed by the registry itself. */
export async function rulingFeedback(client: RhcPublicClient, agentId: bigint): Promise<RulingFeedback | undefined> {
  const registries = REGISTRIES;
  const clients = resolverAddresses();
  if (registries?.reputation === undefined || clients.length === 0) return undefined;

  const [count, value, decimals] = await readContract(client, {
    address: registries.reputation,
    abi: reputationRegistryAbi,
    functionName: 'getSummary',
    args: [agentId, clients, RULING_FEEDBACK_TAG, ''],
  });
  const n = Number(count);
  return { count: n, average: n === 0 ? undefined : Number(value) / 10 ** decimals, clients };
}

/** The ids the receipt of a registration minted, read from the registry's own event. */
export function registeredIds(receipt: TransactionReceipt): readonly bigint[] {
  if (REGISTRIES === undefined) return [];
  return parseEventLogs({ abi: identityRegistryAbi, eventName: 'Registered', logs: receipt.logs })
    .filter((log) => sameHex(log.address, REGISTRIES?.identity ?? ''))
    .map((log) => log.args.agentId);
}

/** The arguments of a registration: the subject's card as the URI, the subject in metadata. */
export function registrationArgs(subject: Address, card: string): readonly [string, readonly { metadataKey: string; metadataValue: Hex }[]] {
  return [card, [{ metadataKey: BURSAR_SUBJECT_KEY, metadataValue: getAddress(subject) }]];
}
