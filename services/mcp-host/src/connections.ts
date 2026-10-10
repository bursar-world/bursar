import type { ToolContext } from '@bursar/mcp';
import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';

import { connectorSettings } from './connectors.js';
import type { ConnectorSettings } from './connectors.js';
import type { ContextFactory } from './contexts.js';
import { SealError, generateToken, hashToken, newAgentKey, openKey, sealKey } from './crypto.js';
import { ProofError, verifyProof } from './proof.js';
import type { ChainReads, ConnectRequest, DisconnectRequest } from './proof.js';
import type { Connection, ConnectionStore } from './store.js';

/**
 * Opening, listing, cutting and answering connections.
 *
 * A connection is one token, one mandate, one agent key. The key is generated here, sealed before
 * it is stored, and opened only to build the tool context a request runs against. The context is
 * kept in memory for the next request from the same token, and dropped when the connection is
 * revoked or when enough others have been used since.
 */

export type PublicConnection = {
  readonly id: string;
  readonly chainId: number;
  readonly mandate: Address;
  readonly owner: Address;
  readonly agent: Address;
  readonly label: string | null;
  readonly status: 'active' | 'revoked';
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
};

export type CreatedConnection = {
  readonly connection: PublicConnection;
  /** Shown once. The store keeps its hash and nothing else. */
  readonly token: string;
  readonly settings: ConnectorSettings;
};

export type Answer =
  | { readonly ok: true; readonly connection: Connection; readonly context: ToolContext }
  | { readonly ok: false; readonly code: 'unauthorized' | 'token_revoked' | 'key_unreadable'; readonly message: string };

export type ConnectionService = {
  create(request: ConnectRequest): Promise<CreatedConnection>;
  list(mandate: Address): Promise<readonly PublicConnection[]>;
  revoke(request: DisconnectRequest): Promise<PublicConnection>;
  /** The context a presented token runs against, or why it runs against nothing. */
  answer(token: string): Promise<Answer>;
};

export type ConnectionServiceOptions = {
  readonly store: ConnectionStore;
  readonly contexts: ContextFactory;
  readonly reads: ChainReads;
  readonly chainId: number;
  readonly kek: Hex;
  readonly publicUrl: string;
  readonly proofWindowSeconds: number;
  readonly connectionsPerHour: number;
  /** How many opened contexts stay in memory. Past it the least recently used is dropped. */
  readonly contextCapacity?: number;
  readonly now?: () => Date;
};

export function publicView(connection: Connection): PublicConnection {
  return {
    id: connection.id,
    chainId: connection.chainId,
    mandate: getAddress(connection.mandate),
    owner: getAddress(connection.owner),
    agent: getAddress(connection.agent),
    label: connection.label,
    status: connection.status,
    createdAt: connection.createdAt.toISOString(),
    revokedAt: connection.revokedAt?.toISOString() ?? null,
    lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
  };
}

export function createConnectionService(options: ConnectionServiceOptions): ConnectionService {
  const { store, contexts, kek } = options;
  const now = options.now ?? (() => new Date());
  const capacity = options.contextCapacity ?? 64;
  const opened = new Map<string, Promise<ToolContext>>();
  const proof = { chainId: options.chainId, reads: options.reads, windowSeconds: options.proofWindowSeconds, now };

  function remember(id: string, context: Promise<ToolContext>): void {
    opened.delete(id);
    opened.set(id, context);
    while (opened.size > capacity) {
      const oldest = opened.keys().next().value;
      if (oldest === undefined) break;
      opened.delete(oldest);
    }
  }

  function open(connection: Connection): Promise<ToolContext> {
    const kept = opened.get(connection.id);
    if (kept) {
      remember(connection.id, kept);
      return kept;
    }
    const key = openKey(kek, connection.key, { chainId: connection.chainId, mandate: connection.mandate, agent: connection.agent });
    const built = contexts.build(getAddress(connection.mandate), key).catch((error: unknown) => {
      opened.delete(connection.id);
      throw error;
    });
    remember(connection.id, built);
    return built;
  }

  return {
    async create(request) {
      const { principal } = await verifyProof(request, proof);

      const since = new Date(now().getTime() - 3_600_000);
      if ((await store.countByOwnerSince(principal, since)) >= options.connectionsPerHour) {
        throw new ProofError('too_many_connections', `This owner has opened ${options.connectionsPerHour} connections in the last hour. Try again later.`, 409);
      }

      await contexts.check(request.mandate);

      const { key, agent } = newAgentKey();
      const token = generateToken();
      const connection = await store.insert({
        chainId: options.chainId,
        mandate: request.mandate,
        owner: principal,
        agent,
        label: request.label ?? null,
        tokenHash: hashToken(token),
        key: sealKey(kek, key, { chainId: options.chainId, mandate: request.mandate, agent }),
        proofNonce: request.nonce,
      });

      return { connection: publicView(connection), token, settings: connectorSettings(options.publicUrl, token) };
    },

    async list(mandate) {
      return (await store.listByMandate(options.chainId, mandate)).map(publicView);
    },

    async revoke(request) {
      const { principal } = await verifyProof(request, proof);
      const existing = await store.byId(request.connection);
      if (!existing || existing.mandate !== request.mandate.toLowerCase()) {
        throw new ProofError('connection_not_found', 'No connection by that id on this mandate.', 400);
      }
      if (existing.owner !== principal.toLowerCase() && existing.mandate !== request.mandate.toLowerCase()) {
        throw new ProofError('not_owner', 'This connection belongs to another mandate.', 403);
      }
      const revoked = (await store.revoke(existing.id, now())) ?? existing;
      opened.delete(existing.id);
      return publicView(revoked);
    },

    async answer(token) {
      const connection = await store.byTokenHash(hashToken(token));
      if (!connection) return { ok: false, code: 'unauthorized', message: 'This token opens no connection.' };
      if (connection.status !== 'active') return { ok: false, code: 'token_revoked', message: 'This connection was disconnected by the owner of its mandate.' };
      let context: ToolContext;
      try {
        context = await open(connection);
      } catch (error) {
        if (error instanceof SealError) return { ok: false, code: 'key_unreadable', message: error.message };
        throw error;
      }
      void store.touch(connection.id, now()).catch(() => undefined);
      return { ok: true, connection, context };
    },
  };
}
