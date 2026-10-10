import { randomUUID } from 'node:crypto';
import type { Address } from 'viem';

import type { SealedKey } from './crypto.js';
import type { Database } from './db/sql.js';
import { many, one } from './db/sql.js';

/**
 * The connection records, behind one interface with two implementations: Postgres for a
 * deployment, memory for a test that is about the HTTP surface rather than the SQL.
 */

export type ConnectionStatus = 'active' | 'revoked';

export type Connection = {
  readonly id: string;
  readonly chainId: number;
  /** Lowercase, as stored. Callers checksum for display. */
  readonly mandate: Address;
  readonly owner: Address;
  readonly agent: Address;
  readonly label: string | null;
  readonly tokenHash: string;
  readonly key: SealedKey;
  readonly proofNonce: string;
  readonly status: ConnectionStatus;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
  readonly lastUsedAt: Date | null;
};

export type NewConnection = Omit<Connection, 'id' | 'status' | 'createdAt' | 'revokedAt' | 'lastUsedAt'>;

export type ConnectionStore = {
  insert(record: NewConnection): Promise<Connection>;
  byTokenHash(hash: string): Promise<Connection | null>;
  byId(id: string): Promise<Connection | null>;
  listByMandate(chainId: number, mandate: Address): Promise<readonly Connection[]>;
  countByOwnerSince(owner: Address, since: Date): Promise<number>;
  revoke(id: string, at: Date): Promise<Connection | null>;
  touch(id: string, at: Date): Promise<void>;
};

export class DuplicateProofError extends Error {
  constructor() {
    super('This signature has already opened a connection. Sign a fresh message.');
    this.name = 'DuplicateProofError';
  }
}

type Row = {
  id: string;
  chain_id: number;
  mandate: string;
  owner: string;
  agent: string;
  label: string | null;
  token_hash: string;
  key_ciphertext: Buffer;
  key_nonce: Buffer;
  key_tag: Buffer;
  kek_id: string;
  proof_nonce: string;
  status: ConnectionStatus;
  created_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
};

const COLUMNS =
  'id, chain_id, mandate, owner, agent, label, token_hash, key_ciphertext, key_nonce, key_tag, kek_id, proof_nonce, status, created_at, revoked_at, last_used_at';

function fromRow(row: Row): Connection {
  return {
    id: row.id,
    chainId: row.chain_id,
    mandate: row.mandate as Address,
    owner: row.owner as Address,
    agent: row.agent as Address,
    label: row.label,
    tokenHash: row.token_hash,
    key: { ciphertext: new Uint8Array(row.key_ciphertext), nonce: new Uint8Array(row.key_nonce), tag: new Uint8Array(row.key_tag), kekId: row.kek_id },
    proofNonce: row.proof_nonce,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

const lower = (address: Address): Address => address.toLowerCase() as Address;

export function createPostgresStore(db: Database): ConnectionStore {
  return {
    async insert(record) {
      try {
        const row = await one<Row>(
          db,
          `INSERT INTO bursar_mcp_connections
             (chain_id, mandate, owner, agent, label, token_hash, key_ciphertext, key_nonce, key_tag, kek_id, proof_nonce)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING ${COLUMNS}`,
          [
            record.chainId,
            lower(record.mandate),
            lower(record.owner),
            lower(record.agent),
            record.label,
            record.tokenHash,
            Buffer.from(record.key.ciphertext),
            Buffer.from(record.key.nonce),
            Buffer.from(record.key.tag),
            record.key.kekId,
            record.proofNonce,
          ],
        );
        if (!row) throw new Error('insert returned no row');
        return fromRow(row);
      } catch (error) {
        if (isUniqueViolation(error, 'uq_mcp_connections_proof')) throw new DuplicateProofError();
        throw error;
      }
    },

    async byTokenHash(hash) {
      const row = await one<Row>(db, `SELECT ${COLUMNS} FROM bursar_mcp_connections WHERE token_hash = $1`, [hash]);
      return row ? fromRow(row) : null;
    },

    async byId(id) {
      const row = await one<Row>(db, `SELECT ${COLUMNS} FROM bursar_mcp_connections WHERE id = $1::uuid`, [id]);
      return row ? fromRow(row) : null;
    },

    async listByMandate(chainId, mandate) {
      const rows = await many<Row>(
        db,
        `SELECT ${COLUMNS} FROM bursar_mcp_connections WHERE chain_id = $1 AND mandate = $2 ORDER BY created_at DESC LIMIT 100`,
        [chainId, lower(mandate)],
      );
      return rows.map(fromRow);
    },

    async countByOwnerSince(owner, since) {
      const row = await one<{ count: string }>(
        db,
        'SELECT COUNT(*)::text AS count FROM bursar_mcp_connections WHERE owner = $1 AND created_at >= $2',
        [lower(owner), since],
      );
      return Number(row?.count ?? '0');
    },

    async revoke(id, at) {
      const row = await one<Row>(
        db,
        `UPDATE bursar_mcp_connections SET status = 'revoked', revoked_at = $2
         WHERE id = $1::uuid AND status = 'active' RETURNING ${COLUMNS}`,
        [id, at],
      );
      return row ? fromRow(row) : null;
    },

    async touch(id, at) {
      await db.query('UPDATE bursar_mcp_connections SET last_used_at = $2 WHERE id = $1::uuid', [id, at]);
    },
  };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const code = (error as { code?: unknown })?.code;
  const named = (error as { constraint?: unknown })?.constraint;
  return code === '23505' && named === constraint;
}

/** The same contract in memory, for tests. */
export function createMemoryStore(): ConnectionStore {
  const rows = new Map<string, Connection>();
  return {
    async insert(record) {
      for (const existing of rows.values()) {
        if (existing.owner === lower(record.owner) && existing.proofNonce === record.proofNonce) throw new DuplicateProofError();
      }
      const connection: Connection = {
        ...record,
        mandate: lower(record.mandate),
        owner: lower(record.owner),
        agent: lower(record.agent),
        id: randomUUID(),
        status: 'active',
        createdAt: new Date(),
        revokedAt: null,
        lastUsedAt: null,
      };
      rows.set(connection.id, connection);
      return connection;
    },
    async byTokenHash(hash) {
      return [...rows.values()].find((row) => row.tokenHash === hash) ?? null;
    },
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async listByMandate(chainId, mandate) {
      return [...rows.values()]
        .filter((row) => row.chainId === chainId && row.mandate === lower(mandate))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    async countByOwnerSince(owner, since) {
      return [...rows.values()].filter((row) => row.owner === lower(owner) && row.createdAt >= since).length;
    },
    async revoke(id, at) {
      const row = rows.get(id);
      if (!row || row.status !== 'active') return null;
      const revoked: Connection = { ...row, status: 'revoked', revokedAt: at };
      rows.set(id, revoked);
      return revoked;
    },
    async touch(id, at) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, lastUsedAt: at });
    },
  };
}
