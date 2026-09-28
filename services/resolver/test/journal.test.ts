import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeJournal, encodeJournal, openFileJournal } from '../src/journal.js';
import type { DisputeRecord } from '../src/journal.js';
import { ESCROW, REGISTRY } from './support/fake-chain.js';

const RECORD: DisputeRecord = {
  registry: REGISTRY,
  disputeId: 2n,
  escrow: ESCROW,
  escrowId: 9n,
  openedAt: 1n,
  commitEndsAt: 2n,
  revealEndsAt: 3n,
  disputedAt: 1n,
  stage: 'observed',
  snapshot: null,
  submissions: [],
  overrides: [],
  ruling: null,
  votes: [],
  outcome: null,
  finalizeTx: null,
  alerted: [],
  published: false,
};

describe('journal', () => {
  it('round-trips bigints exactly', () => {
    const value = { a: 2n ** 200n, b: [1n], c: 'x', d: { $n: 'not alone', e: 1 } };
    expect(decodeJournal(encodeJournal(value))).toEqual(value);
  });

  it('survives a restart from the file, owner-readable only', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'resolver-journal-')), 'nested', 'journal.json');
    const first = await openFileJournal(path);
    await first.update(REGISTRY, 2n, () => RECORD);
    await first.setCursor(REGISTRY, 74_711_539n);

    const second = await openFileJournal(path);
    expect(await second.get(REGISTRY, 2n)).toEqual(RECORD);
    expect(await second.cursor(REGISTRY)).toBe(74_711_539n);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain('"$n":"74711539"');
  });

  it('serialises concurrent updates to one record so neither is lost', async () => {
    const journal = await openFileJournal(join(mkdtempSync(join(tmpdir(), 'resolver-journal-')), 'j.json'));
    await journal.update(REGISTRY, 2n, () => RECORD);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        journal.update(REGISTRY, 2n, (current) => (current === undefined ? undefined : { ...current, alerted: [...current.alerted, `a${index}`] })),
      ),
    );
    expect((await journal.get(REGISTRY, 2n))?.alerted).toHaveLength(20);
  });

  it('leaves memory unchanged when the write fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolver-journal-'));
    const path = join(dir, 'journal.json');
    const journal = await openFileJournal(path);
    // A directory where the temporary file has to go, so the write cannot land.
    mkdirSync(`${path}.${process.pid}.tmp`);
    await expect(journal.update(REGISTRY, 2n, () => RECORD)).rejects.toThrow();
    expect(await journal.get(REGISTRY, 2n)).toBeUndefined();
  });
});
