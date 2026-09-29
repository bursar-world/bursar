import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { EvidenceWire } from '@bursar/sdk';
import pg from 'pg';
import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';

import type { LockState, MandateFacts, PayeeFacts } from './chain.js';
import type { GrantCheckpoint } from './disclosure.js';
import type { InputCheck, Ruling, RulingScore } from './policy.js';

/**
 * What this service remembers about a dispute.
 *
 * None of it is needed to vote. The salt is derived from the key, the score can be read back off
 * the chain, and every window is on the dispute record, so a process that starts with an empty
 * journal in the middle of a reveal window still reveals. What the journal adds is the evidence
 * inbox, the ruling and its reasons, and which alerts were already sent, which is what the
 * publication and a quiet pager are made of.
 */
export type Stage =
  | 'observed'
  | 'evidence_open'
  | 'ruled'
  | 'committed'
  | 'revealed'
  | 'finalized'
  | 'verified'
  | 'abstained'
  | 'closed';

export type StoredSubmission = {
  /** Chain time at receipt. The cutoff is judged against it, never against this machine. */
  readonly receivedAt: bigint;
  readonly hash: Hex;
  readonly signer: Address;
  readonly wire: EvidenceWire;
};

export type StoredOverride = {
  readonly receivedAt: bigint;
  readonly score: RulingScore;
  readonly reason: string;
};

export type StoredVote = {
  readonly key: string;
  readonly address: Address;
  readonly score: number;
  readonly commitTx: Hex | null;
  readonly revealTx: Hex | null;
};

export type StoredSnapshot = {
  readonly block: bigint;
  readonly chainTime: bigint;
  readonly lock: LockState;
  readonly heldInDispute: boolean;
  readonly mandate: MandateFacts | null;
  readonly payee: PayeeFacts;
  readonly input: InputCheck;
  readonly inputHash: Hex | null;
  readonly operatorParty: boolean;
};

export type FrozenRuling = Ruling & {
  readonly decidedAt: bigint;
  /** Digests of the delivery evidence the ruling counted. */
  readonly evidenceHashes: readonly Hex[];
};

export type Outcome = {
  readonly status: 'finalized' | 'failed';
  readonly medianScore: number;
  readonly refundBps: number;
  readonly lockStatus: number;
};

export type DisputeRecord = {
  readonly registry: Address;
  readonly disputeId: bigint;
  readonly escrow: Address;
  readonly escrowId: bigint;
  readonly openedAt: bigint;
  readonly commitEndsAt: bigint;
  readonly revealEndsAt: bigint;
  readonly disputedAt: bigint;
  readonly stage: Stage;
  readonly snapshot: StoredSnapshot | null;
  readonly submissions: readonly StoredSubmission[];
  readonly overrides: readonly StoredOverride[];
  readonly ruling: FrozenRuling | null;
  readonly votes: readonly StoredVote[];
  readonly outcome: Outcome | null;
  /** The finalize this service sent, when it was this service that sent it. */
  readonly finalizeTx: Hex | null;
  /** Once-only alerts already sent, by key, so a restart does not page twice for one fault. */
  readonly alerted: readonly string[];
  /** Set once this service's reveals have landed. Until then the ruling stays sealed. */
  readonly published: boolean;
  /** How far the disclosure-grant scan for this lock has read, and what it found. */
  readonly disclosureScan?: GrantCheckpoint;
};

export type Journal = {
  readonly describe: string;
  get(registry: Address, disputeId: bigint): Promise<DisputeRecord | undefined>;
  /**
   * Read, change and write one record as a single step. The voter and the evidence route both
   * write the same record, and two read-modify-writes that interleave lose one of the two.
   */
  update(
    registry: Address,
    disputeId: bigint,
    mutate: (current: DisputeRecord | undefined) => DisputeRecord | undefined,
  ): Promise<DisputeRecord | undefined>;
  list(): Promise<readonly DisputeRecord[]>;
  cursor(registry: Address): Promise<bigint | undefined>;
  setCursor(registry: Address, block: bigint): Promise<void>;
  close(): Promise<void>;
};

type Backend = {
  readonly describe: string;
  load(): Promise<{ records: DisputeRecord[]; cursors: Record<string, bigint> }>;
  saveRecord(record: DisputeRecord, all: readonly DisputeRecord[], cursors: Readonly<Record<string, bigint>>): Promise<void>;
  saveCursor(registry: string, block: bigint, all: readonly DisputeRecord[], cursors: Readonly<Record<string, bigint>>): Promise<void>;
  close(): Promise<void>;
};

const recordKey = (registry: Address, disputeId: bigint): string => `${getAddress(registry)}:${disputeId.toString()}`;

/**
 * The journal on a backend. Everything is held in memory and every write goes through one queue,
 * so a record is never written from two versions at once and a read never waits on the disk.
 */
async function open(backend: Backend): Promise<Journal> {
  const loaded = await backend.load();
  const records = new Map(loaded.records.map((record) => [recordKey(record.registry, record.disputeId), record]));
  const cursors: Record<string, bigint> = { ...loaded.cursors };

  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const turn = queue.then(work);
    queue = turn.catch(() => undefined);
    return turn;
  };

  return {
    describe: backend.describe,
    get: async (registry, disputeId) => records.get(recordKey(registry, disputeId)),
    update: (registry, disputeId, mutate) =>
      serial(async () => {
        const key = recordKey(registry, disputeId);
        const next = mutate(records.get(key));
        if (next === undefined) return records.get(key);
        // Written before it is held, so a failed write leaves memory and storage agreeing on the
        // version before it, and the caller's error is the only thing that changed.
        const all = [...records.entries()].filter(([other]) => other !== key).map(([, record]) => record);
        await backend.saveRecord(next, [...all, next], cursors);
        records.set(key, next);
        return next;
      }),
    list: async () => [...records.values()],
    cursor: async (registry) => cursors[getAddress(registry)],
    setCursor: (registry, block) =>
      serial(async () => {
        const next = { ...cursors, [getAddress(registry)]: block };
        await backend.saveCursor(getAddress(registry), block, [...records.values()], next);
        cursors[getAddress(registry)] = block;
      }),
    close: () => serial(() => backend.close()),
  };
}

/** Bigints survive a round trip as `{"$n":"123"}`, which no field of a record is otherwise shaped like. */
export function encodeJournal(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? { $n: item.toString() } : item));
}

export function decodeJournal<T>(text: string): T {
  return JSON.parse(text, (_key, item: unknown) => {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const keys = Object.keys(item);
      const tagged = (item as { $n?: unknown }).$n;
      if (keys.length === 1 && typeof tagged === 'string') return BigInt(tagged);
    }
    return item;
  }) as T;
}

type FileShape = { readonly version: 1; readonly cursors: Record<string, bigint>; readonly disputes: readonly DisputeRecord[] };

/**
 * One JSON file, replaced whole on every write through a rename, so a crash mid-write leaves the
 * previous version rather than half of the next one.
 */
export function openFileJournal(path: string): Promise<Journal> {
  const write = async (all: readonly DisputeRecord[], cursors: Readonly<Record<string, bigint>>): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, encodeJournal({ version: 1, cursors, disputes: all } satisfies FileShape), { mode: 0o600 });
    await rename(temporary, path);
  };

  return open({
    describe: `file ${path}`,
    load: async () => {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], cursors: {} };
        throw error;
      }
      const shape = decodeJournal<FileShape>(text);
      if (shape.version !== 1) throw new Error(`${path} is journal version ${String(shape.version)}, and this service reads version 1.`);
      return { records: [...shape.disputes], cursors: shape.cursors };
    },
    saveRecord: (_record, all, cursors) => write(all, cursors),
    saveCursor: (_registry, _block, all, cursors) => write(all, cursors),
    close: async () => undefined,
  });
}

/** Every statement here is a single-row read or write. One that has not answered in ten seconds will not. */
const STATEMENT_TIMEOUT_MS = 10_000;

export async function openPostgresJournal(url: string, describe: string, onError: (error: Error) => void): Promise<Journal> {
  const pool = new pg.Pool({
    connectionString: url,
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  // An idle connection the server drops arrives as an error event, which ends the process if
  // nobody listens. It is reported, and the next query reconnects.
  pool.on('error', onError);

  await pool.query(`
    create table if not exists resolver_dispute (
      registry text not null,
      dispute_id text not null,
      body text not null,
      updated_at timestamptz not null default now(),
      primary key (registry, dispute_id)
    );
    create table if not exists resolver_cursor (
      registry text primary key,
      block text not null
    );
  `);

  return open({
    describe: `postgres ${describe}`,
    load: async () => {
      const disputes = await pool.query<{ body: string }>('select body from resolver_dispute');
      const cursorRows = await pool.query<{ registry: string; block: string }>('select registry, block from resolver_cursor');
      return {
        records: disputes.rows.map((row) => decodeJournal<DisputeRecord>(row.body)),
        cursors: Object.fromEntries(cursorRows.rows.map((row) => [row.registry, BigInt(row.block)])),
      };
    },
    saveRecord: async (record) => {
      await pool.query(
        `insert into resolver_dispute (registry, dispute_id, body) values ($1, $2, $3)
         on conflict (registry, dispute_id) do update set body = excluded.body, updated_at = now()`,
        [getAddress(record.registry), record.disputeId.toString(), encodeJournal(record)],
      );
    },
    saveCursor: async (registry, block) => {
      await pool.query(
        `insert into resolver_cursor (registry, block) values ($1, $2)
         on conflict (registry) do update set block = excluded.block`,
        [registry, block.toString()],
      );
    },
    close: () => pool.end(),
  });
}

/** For the tests and the drill: the same journal with nothing underneath it. */
export function openMemoryJournal(): Promise<Journal> {
  return open({
    describe: 'memory',
    load: async () => ({ records: [], cursors: {} }),
    saveRecord: async () => undefined,
    saveCursor: async () => undefined,
    close: async () => undefined,
  });
}
