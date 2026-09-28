import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { KDF_ITERATIONS, WrongPassphraseError, deriveKey, fromBase64, newKdfParams, openJson, sealJson } from '@/workspace/crypto';
import { newDraft } from '@/workspace/model';
import type { Workspace } from '@/workspace/model';
import { browserStore, memoryStore } from '@/workspace/store';
import { WorkspaceLockedError, WorkspaceSession, parseBackup, passphraseProblem } from '@/workspace/session';

/** Fewer rounds than production so the suite stays quick. One test runs the real count. */
const FAST = { iterations: 100_000 };
const PASS = 'correct horse battery staple';

function sample(): Workspace {
  const draft = {
    ...newDraft(),
    name: 'Research budget Q4',
    notes: 'Only for the summariser agent',
    agent: '0x1111111111111111111111111111111111111111',
    payees: ['0x2222222222222222222222222222222222222222'],
    capabilities: [{ spendClass: 'service' as const, label: 'doc.summarize:1' }],
    limits: { ...newDraft().limits, perCall: '0.25', daily: '0.50', monthly: '1.00' },
  };
  return {
    version: 1,
    drafts: [draft],
    agents: [{ id: 'a1', name: 'Summariser', address: '0x1111111111111111111111111111111111111111', notes: 'night shift' }],
  };
}

describe('workspace cipher', () => {
  it('derives with PBKDF2-SHA256 at 600,000 iterations by default', () => {
    const params = newKdfParams();
    expect(KDF_ITERATIONS).toBe(600_000);
    expect(params).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000 });
    expect(fromBase64(params.salt)).toHaveLength(16);
  });

  it('round-trips a value, and the real iteration count opens what it sealed', async () => {
    const params = newKdfParams();
    const key = await deriveKey(PASS, params);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.extractable).toBe(false);
    const sealed = await sealJson(key, { hello: 'world' }, 'aad');
    expect(fromBase64(sealed.iv)).toHaveLength(12);
    expect(await openJson(await deriveKey(PASS, params), sealed, 'aad')).toEqual({ hello: 'world' });
  });

  it('refuses a wrong passphrase', async () => {
    const params = newKdfParams(FAST.iterations);
    const sealed = await sealJson(await deriveKey(PASS, params), { a: 1 }, 'aad');
    await expect(openJson(await deriveKey('wrong passphrase!!', params), sealed, 'aad')).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });

  it('draws a fresh IV for every write', async () => {
    const key = await deriveKey(PASS, newKdfParams(FAST.iterations));
    const a = await sealJson(key, { same: true }, 'aad');
    const b = await sealJson(key, { same: true }, 'aad');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('asks for a passphrase of reasonable length that is typed the same twice', () => {
    expect(passphraseProblem('short', 'short')).toMatch(/at least 12/);
    expect(passphraseProblem(PASS, `${PASS}x`)).toMatch(/do not match/);
    expect(passphraseProblem(PASS, PASS)).toBeUndefined();
  });
});

describe('workspace session', () => {
  it('stores only ciphertext in IndexedDB: no field names and no values', async () => {
    const factory = new IDBFactory();
    const session = new WorkspaceSession(browserStore(factory), FAST);
    await session.create(PASS);
    const workspace = sample();
    await session.save(workspace);

    const stored = await browserStore(factory).read();
    expect(stored).toBeDefined();
    expect(Object.keys(stored!).sort()).toEqual(['cipher', 'ciphertext', 'format', 'iv', 'kdf', 'updatedAt', 'version']);

    const raw = JSON.stringify(stored);
    const draft = workspace.drafts[0]!;
    const plaintext = [
      // field names
      'drafts', 'agents', 'perCall', 'payees', 'capabilities', 'notes', 'agent', 'limits', 'classes',
      // values
      draft.name, draft.notes, draft.agent.slice(2), draft.payees[0]!.slice(2), 'doc.summarize', '0.25', 'Summariser', 'night shift',
      PASS,
    ];
    for (const needle of plaintext) expect(raw).not.toContain(needle);
  });

  it('opens with the right passphrase and refuses the wrong one', async () => {
    const store = memoryStore();
    const first = new WorkspaceSession(store, FAST);
    await first.create(PASS);
    await first.save(sample());

    const second = new WorkspaceSession(store, FAST);
    expect(await second.status()).toBe('locked');
    await expect(second.unlock('not the passphrase')).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(second.unlocked).toBe(false);
    const opened = await second.unlock(PASS);
    expect(opened.drafts[0]?.name).toBe('Research budget Q4');
  });

  it('lock drops the key and the drafts from memory', async () => {
    const session = new WorkspaceSession(memoryStore(), FAST);
    await session.create(PASS);
    await session.save(sample());
    expect(session.holdsKey).toBe(true);

    session.lock();
    expect(session.holdsKey).toBe(false);
    expect(session.unlocked).toBe(false);
    expect(() => session.workspace).toThrow(WorkspaceLockedError);
    await expect(session.save(sample())).rejects.toBeInstanceOf(WorkspaceLockedError);
    expect(await session.status()).toBe('locked');

    await session.unlock(PASS);
    expect(session.workspace.drafts).toHaveLength(1);
  });

  it('writes a fresh IV on every save', async () => {
    const store = memoryStore();
    const session = new WorkspaceSession(store, FAST);
    await session.create(PASS);
    const first = (await store.read())!.iv;
    await session.save(sample());
    expect((await store.read())!.iv).not.toBe(first);
  });

  it('exports a backup that imports into a fresh browser with the same passphrase', async () => {
    const session = new WorkspaceSession(browserStore(new IDBFactory()), FAST);
    await session.create(PASS);
    await session.save(sample());
    const backup = await session.exportBackup();
    expect(backup).not.toContain('Research budget');

    const fresh = new WorkspaceSession(browserStore(new IDBFactory()), FAST);
    expect(await fresh.status()).toBe('none');
    await expect(fresh.importBackup(backup, 'wrong passphrase!!')).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(await fresh.status()).toBe('none');

    const imported = await fresh.importBackup(backup, PASS);
    expect(imported).toEqual(session.workspace);
    fresh.lock();
    expect(await fresh.status()).toBe('locked');
    expect((await fresh.unlock(PASS)).agents[0]?.name).toBe('Summariser');
  });

  it('refuses a file that is not a backup', () => {
    expect(() => parseBackup('not json')).toThrow(/not a workspace backup/);
    expect(() => parseBackup(JSON.stringify({ drafts: [] }))).toThrow(/not a workspace backup/);
  });

  it('will not create over an existing workspace', async () => {
    const store = memoryStore();
    await new WorkspaceSession(store, FAST).create(PASS);
    await expect(new WorkspaceSession(store, FAST).create(PASS)).rejects.toThrow(/already exists/);
  });
});
