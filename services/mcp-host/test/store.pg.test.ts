import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { hashToken, newAgentKey, openKey, sealKey } from '../src/crypto.js';
import { migrate, migrationPlan } from '../src/db/migrate.js';
import { createPostgres } from '../src/db/postgres.js';
import { DuplicateProofError, createPostgresStore } from '../src/store.js';

/**
 * The SQL, against a real server. Point BURSAR_TEST_DATABASE_URL at a scratch server; the suite
 * creates its own database there and drops it afterwards. Without the variable it is skipped.
 */
const TEST_URL = process.env.BURSAR_TEST_DATABASE_URL ?? '';
const KEK = `0x${'ab'.repeat(32)}` as const;
const MANDATE = '0x00000000000000000000000000000000000ACC01' as const;
const OWNER = '0x1111111111111111111111111111111111111111' as const;

describe.skipIf(TEST_URL === '')('the postgres store', () => {
  it('keeps a connection with its sealed key, finds it by token hash, and revokes it once', async () => {
    const name = `bursar_mcp_host_test_${randomBytes(4).toString('hex')}`;
    const admin = createPostgres({ url: TEST_URL });
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.close();

    const url = new URL(TEST_URL);
    url.pathname = `/${name}`;
    const db = createPostgres({ url: url.toString() });
    try {
      await migrate(db);
      expect((await migrationPlan(db)).pending).toEqual([]);

      const store = createPostgresStore(db);
      const { key, agent } = newAgentKey();
      const token = 'bmcp_' + randomBytes(32).toString('base64url');
      const nonce = `0x${randomBytes(16).toString('hex')}`;
      const inserted = await store.insert({
        chainId: 4663,
        mandate: MANDATE,
        owner: OWNER,
        agent,
        label: 'Claude',
        tokenHash: hashToken(token),
        key: sealKey(KEK, key, { chainId: 4663, mandate: MANDATE, agent }),
        proofNonce: nonce,
      });
      expect(inserted.mandate).toBe(MANDATE.toLowerCase());
      expect(inserted.status).toBe('active');

      const found = await store.byTokenHash(hashToken(token));
      expect(found?.id).toBe(inserted.id);
      expect(openKey(KEK, found!.key, { chainId: 4663, mandate: MANDATE, agent })).toBe(key);
      expect(await store.byTokenHash(hashToken('bmcp_other'))).toBeNull();
      expect((await store.listByMandate(4663, MANDATE)).map((row) => row.id)).toEqual([inserted.id]);
      expect(await store.countByOwnerSince(OWNER, new Date(Date.now() - 60_000))).toBe(1);

      await expect(
        store.insert({ ...inserted, agent: newAgentKey().agent, tokenHash: hashToken('bmcp_second'), proofNonce: nonce }),
      ).rejects.toBeInstanceOf(DuplicateProofError);

      await store.touch(inserted.id, new Date());
      expect((await store.byId(inserted.id))?.lastUsedAt).toBeInstanceOf(Date);

      const revoked = await store.revoke(inserted.id, new Date());
      expect(revoked?.status).toBe('revoked');
      expect(await store.revoke(inserted.id, new Date())).toBeNull();
    } finally {
      await db.close();
      const cleanup = createPostgres({ url: TEST_URL });
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.close();
    }
  });
});
