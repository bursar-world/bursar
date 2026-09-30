import { RHC_MAINNET, RHC_TESTNET, deployment, deploymentForChain, isBursarError } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import { loadConfig, secretsOf } from '../src/config.js';

const ACCOUNT = '0x00000000000000000000000000000000000acc01';
const ESCROW = '0x8E298457cDFc1Cb9ef6253D36d3BD5cFEf10F915';

const ENV = {
  RHC_RPC_PRIMARY: 'https://rpc.mainnet.chain.robinhood.com/k/primary-key',
  RHC_RPC_FALLBACK: 'https://fallback.example/rpc',
  MANDATE_ACCOUNT: ACCOUNT,
  MANDATE_ESCROW: ESCROW,
};

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return isBursarError(error) ? error.code : 'not_a_bursar_error';
  }

  return 'no_error';
}

describe('configuration', () => {
  it('settles on Robinhood Chain mainnet unless told otherwise', () => {
    const config = loadConfig(ENV);

    expect(config.chain.chainId).toBe(4663);
    expect(config.settlementAsset).toBe(RHC_MAINNET.usdg);
    expect(config.escrow).toBe(ESCROW);
    expect(config.account).toBe(ACCOUNT);
  });

  it('refuses testnet, because USDG is not deployed there', () => {
    // 46630 is up and will take a deploy. What it will not do is settle, and a server that came
    // up healthy on it would refuse every payment at the last step with a signature error.
    expect(codeOf(() => loadConfig({ ...ENV, RHC_NETWORK: 'testnet' }))).toBe(
      'rhc_testnet_no_settlement_asset',
    );
    expect(() => loadConfig({ ...ENV, RHC_NETWORK: 'testnet' })).toThrow(
      new RegExp(String(RHC_TESTNET.chainId), 'u'),
    );
  });

  it('runs read-only until a signer is configured', () => {
    expect(loadConfig(ENV).relay).toBeNull();
    expect(
      loadConfig({ ...ENV, BURSAR_RELAY_URL: 'https://relay.example', BURSAR_RELAY_TOKEN: 'a-long-relay-token' })
        .relay,
    ).toEqual({ url: 'https://relay.example/', token: 'a-long-relay-token', timeoutMs: 30_000 });
  });

  describe('a key held in this process', () => {
    const KEY = `0x${'7f'.repeat(32)}`;

    it('is off unless the operator names it, and reads the key when they do', () => {
      expect(loadConfig(ENV).signer).toBeNull();
      expect(loadConfig({ ...ENV, BURSAR_SIGNER: 'local', BURSAR_SIGNER_KEY: KEY }).signer).toEqual({ key: KEY });
    });

    it('refuses a key handed to a server that was never told to hold one', () => {
      expect(codeOf(() => loadConfig({ ...ENV, BURSAR_SIGNER_KEY: KEY }))).toBe('custody_refused');
      expect(codeOf(() => loadConfig({ ...ENV, BURSAR_SIGNER: 'relay', BURSAR_SIGNER_KEY: KEY }))).toBe(
        'custody_refused',
      );
    });

    it('refuses to sign locally with nothing to sign with', () => {
      expect(() => loadConfig({ ...ENV, BURSAR_SIGNER: 'local' })).toThrow(/nothing to sign with/u);
    });

    it('refuses to hold a key and point at a relay at the same time', () => {
      expect(() =>
        loadConfig({
          ...ENV,
          BURSAR_SIGNER: 'local',
          BURSAR_SIGNER_KEY: KEY,
          BURSAR_RELAY_URL: 'https://relay.example',
        }),
      ).toThrow(/both name a signer/u);
    });

    /** The key acts on one mandate. A resolver or a provider signs through a relay or not at all. */
    it('refuses a local key with no mandate for it to act on', () => {
      const { MANDATE_ACCOUNT: _account, ...withoutMandate } = ENV;

      expect(() =>
        loadConfig({
          ...withoutMandate,
          BURSAR_RESOLVER_ACCOUNT: '0x4444444444444444444444444444444444444444',
          BURSAR_SIGNER: 'local',
          BURSAR_SIGNER_KEY: KEY,
        }),
      ).toThrow(/signs for one mandate and MANDATE_ACCOUNT is not set/u);
    });

    it('refuses a key that is not a key, without quoting it', () => {
      const failed = codeOf(() => loadConfig({ ...ENV, BURSAR_SIGNER: 'local', BURSAR_SIGNER_KEY: '0xnope' }));

      expect(failed).toBe('env_invalid');
      expect(() => loadConfig({ ...ENV, BURSAR_SIGNER: 'local', BURSAR_SIGNER_KEY: '0xnope' })).toThrow(
        /BURSAR_SIGNER_KEY/u,
      );
    });

    it('scrubs the key from anything this server prints', () => {
      const config = loadConfig({ ...ENV, BURSAR_SIGNER: 'local', BURSAR_SIGNER_KEY: KEY });

      expect(secretsOf(config)).toContain(KEY);
    });
  });

  it('refuses a key arriving under a name something else may be reading, and says which', () => {
    expect(() => loadConfig({ ...ENV, AGENT_PRIVATE_KEY: `0x${'5c'.repeat(32)}` })).toThrow(
      /does not take a key under a name something else may also be reading. Unset AGENT_PRIVATE_KEY/u,
    );
    expect(codeOf(() => loadConfig({ ...ENV, MNEMONIC: 'test test test' }))).toBe('custody_refused');
  });

  it('never quotes the key it refused', () => {
    const key = `0x${'5c'.repeat(32)}`;

    try {
      loadConfig({ ...ENV, PRIVATE_KEY: key });
      expect.unreachable();
    } catch (error) {
      expect(error instanceof Error ? error.message : '').not.toContain('5c5c');
    }
  });

  it('reports every missing variable at once', () => {
    expect(codeOf(() => loadConfig({ MANDATE_ACCOUNT: ACCOUNT }))).toBe('env_invalid');

    try {
      loadConfig({ MANDATE_ACCOUNT: ACCOUNT });
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';

      expect(message).toContain('RHC_RPC_PRIMARY');
    }
  });

  it('refuses two provider names that resolve to one host', () => {
    // The fallback defaults to the keyless second provider. What still has to fail is a
    // deployment that names the same endpoint twice and calls it redundancy.
    expect(
      codeOf(() =>
        loadConfig({ ...ENV, RHC_RPC_FALLBACK: 'https://rpc.mainnet.chain.robinhood.com/k/other' }),
      ),
    ).toBe('rpc_single_provider');

    const providers = loadConfig({ ...ENV, RHC_RPC_FALLBACK: undefined }).providers;
    expect(new Set(providers.map((provider) => new URL(provider.url).host)).size).toBe(2);
  });

  it('refuses a relay token with no relay to send it to', () => {
    expect(codeOf(() => loadConfig({ ...ENV, BURSAR_RELAY_TOKEN: 'a-long-relay-token' }))).toBe('env_invalid');
  });

  it('rejects an account that is not an address', () => {
    expect(codeOf(() => loadConfig({ ...ENV, MANDATE_ACCOUNT: '0x1234' }))).toBe('env_invalid');
  });

  // Written to hold before and after a newer set lands: the escrow that answers for the chain comes
  // first, and the two earlier sets stay accepted behind it.
  it('accepts mandates on every live escrow on the chain unless one is pinned', () => {
    const escrows = loadConfig({ ...ENV, MANDATE_ESCROW: undefined }).escrows;

    expect(escrows[0]).toBe(deploymentForChain(4663).contracts.Escrow);
    expect(escrows.slice(-2)).toEqual([
      deployment('rhc-mainnet-v2').contracts.Escrow,
      deployment('rhc-mainnet').contracts.Escrow,
    ]);
    expect(loadConfig({ ...ENV, MANDATE_ESCROW: ACCOUNT }).escrows).toEqual([ACCOUNT]);
  });

  it('asks for the escrow by name on a chain with no recorded deployment', () => {
    const unrecorded = {
      ...ENV,
      MANDATE_ESCROW: undefined,
      RHC_MAINNET_CHAIN_ID: '4664',
      RHC_MAINNET_RPC_URL: 'https://rpc.fork.example',
    };

    expect(() => loadConfig(unrecorded)).toThrow(/MANDATE_ESCROW is required on chain 4664/u);
    expect(loadConfig({ ...unrecorded, MANDATE_ESCROW: ACCOUNT }).escrow).toBe(ACCOUNT);
  });

  it('carries the index key and base, and leaves both unset when the operator did', () => {
    // The history tool is the only one that needs them, so a server without a key still starts
    // and still answers every contract read.
    expect(loadConfig(ENV).index).toEqual({ apiKey: undefined, baseUrl: undefined });

    const keyed = loadConfig({
      ...ENV,
      BLOCKSCOUT_API_KEY: 'a-long-index-key',
      BLOCKSCOUT_API_BASE: 'https://api.blockscout.com/4663/api/v2',
    });

    expect(keyed.index.apiKey).toBe('a-long-index-key');
    expect(keyed.index.baseUrl).toBe('https://api.blockscout.com/4663/api/v2');
  });

  it('refuses an index base served over plain http, which would put the key on the wire', () => {
    expect(codeOf(() => loadConfig({ ...ENV, BLOCKSCOUT_API_BASE: 'http://index.example' }))).toBe(
      'env_invalid',
    );
  });

  it('hands the rpc urls, the relay token and the index key to the redactor', () => {
    const secrets = secretsOf(
      loadConfig({
        ...ENV,
        BURSAR_RELAY_URL: 'https://relay.example',
        BURSAR_RELAY_TOKEN: 'a-long-relay-token',
        BLOCKSCOUT_API_KEY: 'a-long-index-key',
      }),
    );

    expect(secrets).toContain('a-long-relay-token');
    expect(secrets).toContain('a-long-index-key');
    expect(secrets.some((secret) => secret.includes('primary-key'))).toBe(true);
  });
});

/**
 * A server carries the roles it was configured for. A resolver ruling on disputes has no mandate
 * and should not have to invent one to start, and the address it votes as has to be named rather
 * than inferred: that address sits inside every commitment it seals.
 */
describe('the roles a server is bound to', () => {
  const RESOLVER = '0x5555555555555555555555555555555555555555';
  const PROVIDER = '0x3333333333333333333333333333333333333333';

  it('takes the registries from the recorded deployment when the chain has one', () => {
    const config = loadConfig({
      RHC_RPC_PRIMARY: ENV.RHC_RPC_PRIMARY,
      RHC_RPC_FALLBACK: ENV.RHC_RPC_FALLBACK,
      BURSAR_RESOLVER_ACCOUNT: RESOLVER,
      BURSAR_PROVIDER_ACCOUNT: PROVIDER,
    });

    expect(config.account).toBeNull();
    expect(config.resolver?.account).toBe(RESOLVER);
    expect(config.resolver?.registry).toMatch(/^0x[0-9a-fA-F]{40}$/u);
    expect(config.provider?.account).toBe(PROVIDER);
    expect(config.provider?.registry).toMatch(/^0x[0-9a-fA-F]{40}$/u);
    expect(config.provider?.reputation).toMatch(/^0x[0-9a-fA-F]{40}$/u);
  });

  it('carries a mandate and a role at once, because one agent can be both', () => {
    const config = loadConfig({ ...ENV, BURSAR_RESOLVER_ACCOUNT: RESOLVER });

    expect(config.account).toBe(ACCOUNT);
    expect(config.resolver?.account).toBe(RESOLVER);
    expect(config.provider).toBeNull();
  });

  it('lets an operator name the registries itself', () => {
    const registry = '0x6666666666666666666666666666666666666666';
    const config = loadConfig({ ...ENV, BURSAR_RESOLVER_ACCOUNT: RESOLVER, BURSAR_ORACLE_REGISTRY: registry });

    expect(config.resolver?.registry).toBe(registry);
  });

  it('refuses to start bound to nothing, and names all three ways to bind it', () => {
    const failure = messageOf(() =>
      loadConfig({ RHC_RPC_PRIMARY: ENV.RHC_RPC_PRIMARY, RHC_RPC_FALLBACK: ENV.RHC_RPC_FALLBACK }),
    );

    expect(failure).toContain('MANDATE_ACCOUNT');
    expect(failure).toContain('BURSAR_RESOLVER_ACCOUNT');
    expect(failure).toContain('BURSAR_PROVIDER_ACCOUNT');
    expect(failure).toContain('more than one of them');
  });
});

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  return 'no_error';
}
