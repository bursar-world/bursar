import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createPostgres } from '../src/db.js';
import type { Postgres } from '../src/db.js';
import { createPostgresDocumentStore } from '../src/store/postgres.js';

/**
 * Mandate documents out of Postgres, which is the shape a deployment with more than a handful of
 * principals needs. The interesting cases are the ones where the row and the document it holds
 * disagree, because either could be the one somebody meant.
 */

const TEST_DATABASE_URL = process.env['BURSAR_TEST_DATABASE_URL'] ?? '';
const DATABASE = 'bursar_underwriter_documents_test';
const ACCOUNT = '0xe8fd2904175811Db41636c6085eBFE6661E196d5';

const document = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  subject: 'agent-1',
  account: ACCOUNT,
  chain_id: 4663,
  expires_at: '2099-01-01T00:00:00.000Z',
  rules: [{ pattern: 'doc.*', effect: 'allow' }],
  ceiling_micros: 10_000_000,
  per_call_cap_micros: 2_000_000,
  ...overrides,
});

describe.skipIf(!TEST_DATABASE_URL)('mandate documents in Postgres', () => {
  let db: Postgres;

  beforeAll(async () => {
    const admin = createPostgres(TEST_DATABASE_URL);
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    await admin.close();

    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${DATABASE}`;
    db = createPostgres(url.toString());
    // The store creates its schema on first load.
    await createPostgresDocumentStore(db, 'postgres').load();
  }, 60_000);

  afterEach(async () => {
    await db.query('TRUNCATE bursar_documents');
  });

  afterAll(async () => {
    await db?.close();
    const admin = createPostgres(TEST_DATABASE_URL);
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.close();
  });

  async function insert(subject: string, account: string, body: Record<string, unknown>): Promise<void> {
    await db.query('INSERT INTO bursar_documents (subject, account, document) VALUES ($1, $2, $3::jsonb)', [
      subject,
      account,
      JSON.stringify(body),
    ]);
  }

  it('binds a subject to the account its document names', async () => {
    await insert('agent-1', ACCOUNT, document());

    const [binding, ...rest] = await createPostgresDocumentStore(db, 'postgres').load();

    expect(rest).toEqual([]);
    expect(binding?.subject).toBe('agent-1');
    expect(binding?.account).toBe(ACCOUNT);
    expect(binding?.document?.perCallCapMicros).toBe(2_000_000n);
  });

  it('refuses a row whose account column disagrees with its document', async () => {
    await insert('agent-1', '0x1111111111111111111111111111111111111111', document());

    await expect(createPostgresDocumentStore(db, 'postgres').load()).rejects.toMatchObject({
      code: 'underwriter_document_invalid',
    });
  });

  it('refuses a row whose subject column disagrees with its document', async () => {
    await insert('agent-2', ACCOUNT, document());

    await expect(createPostgresDocumentStore(db, 'postgres').load()).rejects.toMatchObject({
      code: 'underwriter_document_invalid',
    });
  });

  it('refuses a document that names no account at all', async () => {
    await insert('agent-1', ACCOUNT, document({ account: undefined }));

    await expect(createPostgresDocumentStore(db, 'postgres').load()).rejects.toMatchObject({
      code: 'underwriter_document_invalid',
    });
  });
});
