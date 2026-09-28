import { describe, expect, it } from 'vitest';
import { EnvError, RHC_MAINNET, RHC_TESTNET, isBursarError } from '@bursar/core';

import { describeUnderwriterConfig, loadUnderwriterConfig } from '../src/config.js';

const ACCOUNT = '0xe8fd2904175811Db41636c6085eBFE6661E196d5';

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    RHC_RPC_PRIMARY: 'https://rpc.mainnet.chain.robinhood.com',
    RHC_RPC_FALLBACK: 'https://robinhood.drpc.org',
    MANDATE_DOCUMENT_SOURCE: 'chain',
    MANDATE_ACCOUNT: ACCOUNT,
    MANDATE_SUBJECT: 'agent-1',
    ...overrides,
  };
}

function codeOf(load: () => unknown): string {
  try {
    load();
    return 'did not throw';
  } catch (error) {
    return isBursarError(error) ? error.code : String(error);
  }
}

describe('underwriter configuration', () => {
  it('defaults to the chain as the document source, on loopback, on 8403', () => {
    const config = loadUnderwriterConfig(env({ MANDATE_DOCUMENT_SOURCE: undefined }));

    expect(config.documents).toEqual({ source: 'chain', subject: 'agent-1', account: ACCOUNT });
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8403);
    expect(config.journal).toEqual({ kind: 'file', directory: './.mandate/journal' });
  });

  it('names the account and the subject the chain mode needs', () => {
    expect(codeOf(() => loadUnderwriterConfig(env({ MANDATE_ACCOUNT: undefined })))).toBe('mandate_account_required');
    expect(codeOf(() => loadUnderwriterConfig(env({ MANDATE_SUBJECT: undefined })))).toBe('mandate_account_required');
  });

  it('needs a path for the file source and a database for the postgres one', () => {
    expect(codeOf(() => loadUnderwriterConfig(env({ MANDATE_DOCUMENT_SOURCE: 'file' })))).toBe(
      'mandate_document_path_required',
    );
    expect(codeOf(() => loadUnderwriterConfig(env({ MANDATE_DOCUMENT_SOURCE: 'postgres' })))).toBe(
      'underwriter_database_url_required',
    );
  });

  it('puts the journal in Postgres as soon as one is configured', () => {
    const config = loadUnderwriterConfig(
      env({ UNDERWRITER_DATABASE_URL: 'postgres://mandate@127.0.0.1:5432/mandate' }),
    );

    expect(config.journal).toEqual({ kind: 'postgres' });
    expect(config.databaseUrl).toContain('127.0.0.1:5432');
  });

  it('refuses a listener reachable off the machine without a token', () => {
    expect(codeOf(() => loadUnderwriterConfig(env({ UNDERWRITER_HOST: '0.0.0.0' })))).toBe(
      'underwriter_token_required',
    );
    expect(
      loadUnderwriterConfig(env({ UNDERWRITER_HOST: '0.0.0.0', UNDERWRITER_AUTH_TOKEN: 'z'.repeat(32) })).authToken,
    ).toHaveLength(32);
  });

  it('refuses a document source it does not implement', () => {
    expect(() => loadUnderwriterConfig(env({ MANDATE_DOCUMENT_SOURCE: 'guess' }))).toThrow(EnvError);
  });

  it('describes itself without carrying a secret', () => {
    const described = describeUnderwriterConfig(
      loadUnderwriterConfig(env({ UNDERWRITER_DATABASE_URL: 'postgres://mandate:hunter2@127.0.0.1:5432/mandate' })),
    );

    expect(JSON.stringify(described)).not.toContain('hunter2');
    expect(described['documentSource']).toBe('chain');
    expect(described['journal']).toBe('postgres');
  });

  it('reads Robinhood Chain mainnet unless told otherwise, and names it', () => {
    const config = loadUnderwriterConfig(env());

    expect(config.chain.chainId).toBe(RHC_MAINNET.chainId);
    expect(config.network).toBe(`eip155:${RHC_MAINNET.chainId}`);
    expect(describeUnderwriterConfig(config)['chain']).toBe(config.chain.name);
    expect(describeUnderwriterConfig(config)['chainId']).toBe(RHC_MAINNET.chainId);
  });

  it('refuses the testnet, naming the variable that chose it', () => {
    // A decision authorises a spend in USDG, and chain 46630 has no USDG to spend. Refusing at
    // configuration is cheaper than refusing at the last step of a payment.
    let refusal: { code?: string; message?: string } = {};
    try {
      loadUnderwriterConfig(env({ RHC_NETWORK: 'testnet' }));
      throw new Error('expected the testnet to be refused');
    } catch (error) {
      refusal = error as { code?: string; message?: string };
    }

    expect(refusal.code).toBe('rhc_testnet_no_settlement_asset');
    expect(refusal.message).toContain('RHC_NETWORK');
    expect(refusal.message).toContain(String(RHC_TESTNET.chainId));
  });
});
