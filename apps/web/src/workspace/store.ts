import type { KdfParams, Sealed } from './crypto';

/**
 * Where the sealed workspace lives.
 *
 * The record is the whole workspace as one ciphertext, plus the parameters needed to open it and
 * the time it was written. Nothing in it names a draft, an agent or a field, so what the storage
 * can read is that a workspace exists and when it last changed.
 *
 * `WorkspaceStore` is the seam cloud storage plugs into. This build ships the browser store only.
 * A cloud store implements the same three calls against an account-scoped endpoint and keeps the
 * same record, which is why the record carries nothing a server should not hold.
 */
export type SealedWorkspace = Sealed & {
  readonly format: 'bursar-workspace';
  readonly version: 1;
  readonly kdf: KdfParams;
  readonly cipher: 'AES-GCM';
  readonly updatedAt: string;
};

export interface WorkspaceStore {
  read(): Promise<SealedWorkspace | undefined>;
  write(record: SealedWorkspace): Promise<void>;
  remove(): Promise<void>;
}

/** Where the workspace is kept, as the interface names it to the reader. */
export type StorageMode = 'browser';

const DB_NAME = 'bursar-workspace';
const STORE = 'sealed';
const KEY = 'workspace';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('The browser store refused the request.'));
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('This browser would not open its storage for the workspace.'));
  });
}

/** The workspace in this browser's IndexedDB. It stays on this device. */
export function browserStore(factory: IDBFactory = globalThis.indexedDB): WorkspaceStore {
  const run = async <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await openDb(factory);
    try {
      const tx = db.transaction(STORE, mode);
      const result = await request(act(tx.objectStore(STORE)));
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('The browser store did not save the workspace.'));
        tx.onabort = () => reject(tx.error ?? new Error('The browser store did not save the workspace.'));
      });
      return result;
    } finally {
      db.close();
    }
  };

  return {
    read: async () => (await run('readonly', (store) => store.get(KEY) as IDBRequest<SealedWorkspace | undefined>)) ?? undefined,
    write: async (record) => {
      await run('readwrite', (store) => store.put(record, KEY));
    },
    remove: async () => {
      await run('readwrite', (store) => store.delete(KEY));
    },
  };
}

/** A store held in memory, for a page with no IndexedDB and for tests. */
export function memoryStore(initial?: SealedWorkspace): WorkspaceStore {
  let record = initial;
  return {
    read: async () => record,
    write: async (next) => {
      record = next;
    },
    remove: async () => {
      record = undefined;
    },
  };
}

export function isSealedWorkspace(value: unknown): value is SealedWorkspace {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<SealedWorkspace>;
  return (
    v.format === 'bursar-workspace' &&
    v.version === 1 &&
    v.cipher === 'AES-GCM' &&
    typeof v.iv === 'string' &&
    typeof v.ciphertext === 'string' &&
    typeof v.updatedAt === 'string' &&
    v.kdf !== undefined &&
    v.kdf.name === 'PBKDF2' &&
    v.kdf.hash === 'SHA-256' &&
    typeof v.kdf.iterations === 'number' &&
    v.kdf.iterations >= 100_000 &&
    typeof v.kdf.salt === 'string'
  );
}
