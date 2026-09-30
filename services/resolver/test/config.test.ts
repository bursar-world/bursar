import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EnvError, deploymentForChain } from '@bursar/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  // Written to hold before and after the v3 record lands: the set that answers for the chain comes
  // first, and v2 and v1 follow it.
  it('serves every mainnet record in the line, newest first, and prefers the primary for writes', () => {
    const { config, keys } = loadConfig(BASE);
    expect(config.served[0]?.name).toBe(deploymentForChain(4663).network);
    expect(config.served.slice(-2)).toEqual([
      {
        name: 'rhc-mainnet-v2',
        escrow: '0x4315F8be7C9661345710910577Ec31cb867f3c20',
        registry: '0xE38349668f0C470C814487E95C14e7652F713B17',
        contractSet: 'v2',
      },
      {
        name: 'rhc-mainnet',
        escrow: '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4',
        registry: '0xCb7c60037eC43b9692A5dDcA42A500181Cf549FF',
        contractSet: 'v1',
      },
    ]);
    expect(config.writeUrls).toEqual(['https://rpc.mainnet.chain.robinhood.com/', 'https://robinhood.drpc.org/']);
    expect(keys).toMatchObject({ kind: 'raw', names: ['resolver-1', 'resolver-2', 'resolver-3'] });
    expect(config.operatorToken).toBeNull();
    expect(config.operatorAddresses).toBeNull();
    expect(config.journal).toEqual({ kind: 'file', path: './resolver-journal.json' });
  });

  it('serves exactly the records RESOLVER_DEPLOYMENTS names, in that order', () => {
    const v1 = new URL('../../../contracts/deployments/rhc-mainnet.json', import.meta.url).pathname;
    const { config } = loadConfig({ ...BASE, RESOLVER_DEPLOYMENTS: v1 });
    expect(config.served.map((entry) => [entry.name, entry.contractSet])).toEqual([['rhc-mainnet', 'v1']]);
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

/**
 * The address book the service is built with, swapped for one holding a third set. The records are
 * the real v1 and v2 ones plus a v3 made up here, because the service has to serve all three the
 * day the v3 record lands, without a release of its own.
 */
const ADDRESS_BOOK = fileURLToPath(new URL('../../../packages/core/dist/generated/deployments.js', import.meta.url));

function record(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../../contracts/deployments/${name}.json`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;
}

const fill = (digit: string): string => `0x${digit.repeat(40)}`;

describe('config with a third contract set', () => {
  afterEach(() => {
    vi.doUnmock(ADDRESS_BOOK);
    vi.resetModules();
  });

  it('serves v3, then the v2 it supersedes, then v1, each read as its own set', async () => {
    const v2 = record('rhc-mainnet-v2');
    const v3 = {
      ...v2,
      network: 'rhc-mainnet-v3',
      supersedes: 'rhc-mainnet-v2',
      contracts: {
        AdminTimelock: fill('1'),
        Reputation: fill('2'),
        Escrow: fill('3'),
        OracleRegistry: fill('4'),
        AgentRegistry: fill('5'),
        MandateAccountFactory: fill('6'),
      },
    };

    vi.resetModules();
    vi.doMock(ADDRESS_BOOK, () => ({
      RAW_DEPLOYMENTS: { 'rhc-mainnet': record('rhc-mainnet'), 'rhc-mainnet-v2': v2, 'rhc-mainnet-v3': v3 },
    }));
    const { loadConfig: load } = await import('../src/config.js');

    expect(load(BASE).config.served.map((entry) => [entry.name, entry.contractSet, entry.escrow, entry.registry])).toEqual([
      ['rhc-mainnet-v3', 'v3', '0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444'],
      ['rhc-mainnet-v2', 'v2', '0x4315F8be7C9661345710910577Ec31cb867f3c20', '0xE38349668f0C470C814487E95C14e7652F713B17'],
      ['rhc-mainnet', 'v1', '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4', '0xCb7c60037eC43b9692A5dDcA42A500181Cf549FF'],
    ]);
  });
});
