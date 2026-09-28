import { EnvError } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const BASE = {
  RHC_RPC_PRIMARY: 'https://rpc.mainnet.chain.robinhood.com',
  RHC_RPC_FALLBACK: 'https://robinhood.drpc.org',
  RESOLVER_KEYS: [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, `0x${'33'.repeat(32)}`].join(','),
};

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    return error.problems.map((problem) => problem.name);
  }
}

describe('config', () => {
  it('serves the bundled mainnet record and prefers the primary for writes', () => {
    const { config, keys } = loadConfig(BASE);
    expect(config.served).toEqual([
      { name: 'rhc-mainnet', escrow: '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4', registry: '0xCb7c60037eC43b9692A5dDcA42A500181Cf549FF' },
    ]);
    expect(config.writeUrls).toEqual(['https://rpc.mainnet.chain.robinhood.com/', 'https://robinhood.drpc.org/']);
    expect(keys).toMatchObject({ kind: 'raw', names: ['resolver-1', 'resolver-2', 'resolver-3'] });
    expect(config.operatorToken).toBeNull();
    expect(config.operatorAddresses).toBeNull();
    expect(config.journal).toEqual({ kind: 'file', path: './resolver-journal.json' });
  });

  it('keeps the keys out of the configuration object', () => {
    const { config } = loadConfig(BASE);
    expect(JSON.stringify(config, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain('1111111111');
  });

  it('refuses two key sources at once, and none at all', () => {
    expect(problems({ ...BASE, RESOLVER_KEYSTORE_DIR: '/keys', RESOLVER_PASSWORD_FILE: '/pw' })).toContain('RESOLVER_KEYS');
    const { RESOLVER_KEYS: _keys, ...withoutKeys } = BASE;
    expect(problems(withoutKeys)).toContain('RESOLVER_KEYSTORE_DIR');
  });

  it('asks for exactly one password source with keystores', () => {
    const { RESOLVER_KEYS: _keys, ...withoutKeys } = BASE;
    expect(problems({ ...withoutKeys, RESOLVER_KEYSTORE_DIR: '/keys' })).toContain('RESOLVER_PASSWORD_FILE');
    expect(problems({ ...withoutKeys, RESOLVER_KEYSTORE_DIR: '/keys', RESOLVER_PASSWORD_FILE: '/pw', RESOLVER_PASSWORD_KEYCHAIN: 'a/b' })).toContain(
      'RESOLVER_PASSWORD_FILE',
    );
    expect(problems({ ...withoutKeys, RESOLVER_KEYSTORE_DIR: '/keys', RESOLVER_PASSWORD_FILE: '/pw' })).toEqual([]);
  });

  it('reads operator addresses and refuses one that is not an address', () => {
    const { config } = loadConfig({ ...BASE, RESOLVER_OPERATOR_ADDRESSES: '0x6b6fc40ed9652728a9b620c4e1b05fbf4f9712a4' });
    expect(config.operatorAddresses).toEqual(['0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4']);
    expect(problems({ ...BASE, RESOLVER_OPERATOR_ADDRESSES: 'nope' })).toContain('RESOLVER_OPERATOR_ADDRESSES');
  });

  it('refuses a short operator token without echoing it', () => {
    try {
      loadConfig({ ...BASE, RESOLVER_OPERATOR_TOKEN: 'short-secret' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('RESOLVER_OPERATOR_TOKEN');
      expect((error as Error).message).not.toContain('short-secret');
    }
  });

  it('reports a malformed key list by name only', () => {
    try {
      loadConfig({ ...BASE, RESOLVER_KEYS: `0x${'11'.repeat(31)}` });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('RESOLVER_KEYS');
      expect((error as Error).message).not.toContain('111111');
    }
  });

  it('takes Postgres over the file journal when a database is named', () => {
    const { config } = loadConfig({ ...BASE, RESOLVER_DATABASE_URL: 'postgres://u:p@db.internal:5432/resolver' });
    expect(config.journal).toEqual({ kind: 'postgres', url: 'postgres://u:p@db.internal:5432/resolver' });
  });
});
