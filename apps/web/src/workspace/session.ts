import { KDF_ITERATIONS, deriveKey, newKdfParams, openJson, sealJson } from './crypto';
import type { KdfParams } from './crypto';
import { EMPTY_WORKSPACE, readWorkspace } from './model';
import type { Workspace } from './model';
import { isSealedWorkspace } from './store';
import type { SealedWorkspace, WorkspaceStore } from './store';

/** Bound into every ciphertext, so a record sealed for something else never opens as a workspace. */
const AAD = 'bursar-workspace:v1';

export const MIN_PASSPHRASE_LENGTH = 12;

export type WorkspaceStatus = 'none' | 'locked' | 'unlocked';

export class WorkspaceLockedError extends Error {
  constructor() {
    super('The workspace is locked. Enter the passphrase to open it.');
    this.name = 'WorkspaceLockedError';
  }
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/** What is wrong with a new passphrase, or undefined when it can be used. */
export function passphraseProblem(passphrase: string, confirmation: string): string | undefined {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Use at least ${MIN_PASSPHRASE_LENGTH} characters. A longer phrase of ordinary words is easier to remember and harder to guess.`;
  }
  if (passphrase !== confirmation) return 'The two passphrases do not match.';
  return undefined;
}

/**
 * One open, or openable, workspace.
 *
 * The key and the decrypted workspace live on this object and nowhere else. `lock` drops both, so
 * after it returns nothing in the page can read a draft until the passphrase is entered again.
 * Closing the page drops them too, because they were never written down.
 */
export class WorkspaceSession {
  readonly #store: WorkspaceStore;
  readonly #iterations: number;
  #key: CryptoKey | null = null;
  #kdf: KdfParams | null = null;
  #workspace: Workspace | null = null;
  #updatedAt: string | null = null;

  constructor(store: WorkspaceStore, options: { readonly iterations?: number } = {}) {
    this.#store = store;
    this.#iterations = options.iterations ?? KDF_ITERATIONS;
  }

  get unlocked(): boolean {
    return this.#key !== null && this.#workspace !== null;
  }

  /** Whether a key is held. Separate from `unlocked` so a test can see the key itself is gone. */
  get holdsKey(): boolean {
    return this.#key !== null;
  }

  get updatedAt(): string | null {
    return this.#updatedAt;
  }

  get workspace(): Workspace {
    if (this.#workspace === null) throw new WorkspaceLockedError();
    return this.#workspace;
  }

  async status(): Promise<WorkspaceStatus> {
    if (this.unlocked) return 'unlocked';
    const record = await this.#store.read();
    if (record === undefined) return 'none';
    this.#updatedAt = record.updatedAt;
    return 'locked';
  }

  async create(passphrase: string): Promise<Workspace> {
    if ((await this.#store.read()) !== undefined) {
      throw new Error('A workspace already exists in this browser. Unlock it, or remove it first.');
    }
    const kdf = newKdfParams(this.#iterations);
    const key = await deriveKey(passphrase, kdf);
    this.#kdf = kdf;
    this.#key = key;
    await this.save(EMPTY_WORKSPACE);
    return this.workspace;
  }

  async unlock(passphrase: string): Promise<Workspace> {
    const record = await this.#store.read();
    if (record === undefined) throw new Error('There is no workspace in this browser to unlock.');
    const { key, workspace } = await openRecord(record, passphrase);
    this.#kdf = record.kdf;
    this.#key = key;
    this.#workspace = workspace;
    this.#updatedAt = record.updatedAt;
    return workspace;
  }

  lock(): void {
    this.#key = null;
    this.#kdf = null;
    this.#workspace = null;
  }

  /** Seals the whole workspace under a fresh IV and writes it. Nothing is written in the clear. */
  async save(next: Workspace): Promise<void> {
    if (this.#key === null || this.#kdf === null) throw new WorkspaceLockedError();
    const updatedAt = new Date().toISOString();
    const sealed = await sealJson(this.#key, next, AAD);
    const record: SealedWorkspace = {
      format: 'bursar-workspace',
      version: 1,
      kdf: this.#kdf,
      cipher: 'AES-GCM',
      ...sealed,
      updatedAt,
    };
    await this.#store.write(record);
    this.#workspace = next;
    this.#updatedAt = updatedAt;
  }

  /** The stored record as a file. It is the same ciphertext, so it opens with the same passphrase. */
  async exportBackup(): Promise<string> {
    const record = await this.#store.read();
    if (record === undefined) throw new Error('There is no workspace in this browser to back up.');
    return JSON.stringify(record, null, 2);
  }

  /**
   * Replaces this browser's workspace with a backup, once the passphrase has opened it. A backup
   * that does not open is refused before anything is overwritten.
   */
  async importBackup(text: string, passphrase: string): Promise<Workspace> {
    const record = parseBackup(text);
    const { key, workspace } = await openRecord(record, passphrase);
    await this.#store.write(record);
    this.#kdf = record.kdf;
    this.#key = key;
    this.#workspace = workspace;
    this.#updatedAt = record.updatedAt;
    return workspace;
  }

  /** Deletes the workspace from this browser. Without a backup it cannot be recovered. */
  async remove(): Promise<void> {
    this.lock();
    await this.#store.remove();
    this.#updatedAt = null;
  }
}

async function openRecord(record: SealedWorkspace, passphrase: string): Promise<{ key: CryptoKey; workspace: Workspace }> {
  const key = await deriveKey(passphrase, record.kdf);
  const workspace = readWorkspace(await openJson(key, record, AAD));
  return { key, workspace };
}

export function parseBackup(text: string): SealedWorkspace {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BackupError('That file is not a workspace backup. A backup is the JSON file this page exports.');
  }
  if (!isSealedWorkspace(value)) {
    throw new BackupError('That file is not a workspace backup this console can open.');
  }
  return value;
}
