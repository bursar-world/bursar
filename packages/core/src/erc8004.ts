import type { Address } from 'viem';

/**
 * ERC-8004, Trustless Agents: the standard's three per-chain singletons and what Bursar writes
 * into them.
 *
 * The identity registry is an ERC-721 whose token URI resolves to an agent card, the registration
 * file the standard prescribes. The reputation registry takes signed feedback per agent from any
 * client that is not the agent's own owner or operator. Both are the standard's own vanity
 * deployments; the 4663 entries were checked against Base at the proxy and behind it: the same
 * proxy addresses, the same implementation addresses, identical implementation code hashes. The
 * validation registry has no code on 4663.
 */

/** The `type` field every agent card carries. */
export const ERC8004_REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

export type Erc8004Registries = {
  readonly identity: Address;
  /** Undefined where the chain carries no reputation registry. Nothing is posted there. */
  readonly reputation: Address | undefined;
  readonly validation: Address | undefined;
  /** The chain's segment in an 8004scan agent URL. */
  readonly scanChain: string;
  /** The chain's segment in an OpenSea item URL. */
  readonly openseaChain: string;
};

export const ERC8004_REGISTRIES: Readonly<Record<number, Erc8004Registries>> = Object.freeze({
  4663: Object.freeze({
    identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as Address,
    reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as Address,
    validation: undefined,
    scanChain: 'robinhood-chain',
    openseaChain: 'robinhood',
  }),
});

export function erc8004Registries(chainId: number): Erc8004Registries | undefined {
  return ERC8004_REGISTRIES[chainId];
}

/** `{namespace}:{chainId}:{identityRegistry}`, the registry name a card's `registrations` entry carries. */
export function agentRegistryId(chainId: number, identity: Address): string {
  return `eip155:${chainId}:${identity.toLowerCase()}`;
}

export function scanAgentUrl(chainId: number, agentId: bigint): string | undefined {
  const registries = erc8004Registries(chainId);
  return registries === undefined ? undefined : `https://www.8004scan.io/agents/${registries.scanChain}/${agentId.toString()}`;
}

export function openseaAgentUrl(chainId: number, agentId: bigint): string | undefined {
  const registries = erc8004Registries(chainId);
  if (registries === undefined) return undefined;
  return `https://opensea.io/item/${registries.openseaChain}/${registries.identity.toLowerCase()}/${agentId.toString()}`;
}

/**
 * The metadata key a Bursar registration sets on its identity: the Bursar address the identity
 * stands for, a provider's payee address or a mandate account. The registry has no reverse index,
 * so a reader lists the owner's identities and keeps the ones whose entry names the address.
 */
export const BURSAR_SUBJECT_KEY = 'bursar.subject';

/** `tag1` on every ruling the resolver service posts as feedback. `tag2` names the dispute. */
export const RULING_FEEDBACK_TAG = 'ruling';

export type AgentCardService = { readonly name: string; readonly endpoint: string; readonly version?: string };

export type AgentCardRegistration = { readonly agentId: number; readonly agentRegistry: string };

/** The registration file, as the standard lays it out, with Bursar's own block beside it. */
export type AgentCard = {
  readonly type: typeof ERC8004_REGISTRATION_TYPE;
  readonly name: string;
  readonly description: string;
  readonly image: string;
  readonly services: readonly AgentCardService[];
  readonly x402Support: boolean;
  readonly active: boolean;
  readonly registrations: readonly AgentCardRegistration[];
  readonly supportedTrust: readonly string[];
  readonly bursar: Readonly<Record<string, unknown>>;
};

/** The agent ids a card claims on one registry, read defensively from a body somebody else served. */
export function cardRegistrations(body: unknown, agentRegistry: string): readonly bigint[] {
  if (typeof body !== 'object' || body === null) return [];
  const list = (body as { registrations?: unknown }).registrations;
  if (!Array.isArray(list)) return [];
  const ids: bigint[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { agentId, agentRegistry: registry } = entry as { agentId?: unknown; agentRegistry?: unknown };
    if (typeof registry !== 'string' || registry.toLowerCase() !== agentRegistry.toLowerCase()) continue;
    if (typeof agentId === 'number' && Number.isInteger(agentId) && agentId >= 0) ids.push(BigInt(agentId));
    else if (typeof agentId === 'string' && /^\d+$/.test(agentId)) ids.push(BigInt(agentId));
  }
  return ids;
}

export const identityRegistryAbi = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentURI', type: 'string' },
      {
        name: 'metadata',
        type: 'tuple[]',
        components: [
          { name: 'metadataKey', type: 'string' },
          { name: 'metadataValue', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setAgentURI',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newURI', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setMetadata',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
      { name: 'metadataValue', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getMetadata',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'getAgentWallet',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'isAuthorizedOrOwner',
    stateMutability: 'view',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'agentId', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'MetadataSet',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'indexedMetadataKey', type: 'string', indexed: true },
      { name: 'metadataKey', type: 'string', indexed: false },
      { name: 'metadataValue', type: 'bytes', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'URIUpdated',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'newURI', type: 'string', indexed: false },
      { name: 'updatedBy', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
] as const;

export const reputationRegistryAbi = [
  {
    type: 'function',
    name: 'getIdentityRegistry',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'giveFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getSummary',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
  },
  {
    type: 'function',
    name: 'readAllFeedback',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'includeRevoked', type: 'bool' },
    ],
    outputs: [
      { name: 'clients', type: 'address[]' },
      { name: 'feedbackIndexes', type: 'uint64[]' },
      { name: 'values', type: 'int128[]' },
      { name: 'valueDecimals', type: 'uint8[]' },
      { name: 'tag1s', type: 'string[]' },
      { name: 'tag2s', type: 'string[]' },
      { name: 'revokedStatuses', type: 'bool[]' },
    ],
  },
  {
    type: 'function',
    name: 'getLastIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'getClients',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'event',
    name: 'NewFeedback',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'clientAddress', type: 'address', indexed: true },
      { name: 'feedbackIndex', type: 'uint64', indexed: false },
      { name: 'value', type: 'int128', indexed: false },
      { name: 'valueDecimals', type: 'uint8', indexed: false },
      { name: 'indexedTag1', type: 'string', indexed: true },
      { name: 'tag1', type: 'string', indexed: false },
      { name: 'tag2', type: 'string', indexed: false },
      { name: 'endpoint', type: 'string', indexed: false },
      { name: 'feedbackURI', type: 'string', indexed: false },
      { name: 'feedbackHash', type: 'bytes32', indexed: false },
    ],
  },
] as const;
