import { EnvError, deploymentForChain, isBursarError } from '@bursar/core';
import type { EnvSource } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const KEY = `0x${'1a'.repeat(32)}`;
const SCOPE = '4663-0x000000000000000000000000000000000000e5c0';

const REQUIRED: EnvSource = {
  RHC_RPC_PRIMARY: 'https://rpc.mainnet.chain.robinhood.com',
  RHC_RPC_FALLBACK: 'https://robinhood.drpc.org',
  PAYEE_PRIVATE_KEY: KEY,
  API_BASE: 'http://127.0.0.1:8787',
  // Deliberately not the address the deployment record holds. A sidecar pointed at a fork or at a
  // second deployment names its own escrow, and these cases have to exercise that path rather than
  // the record lookup they would otherwise fall through to.
  ESCROW_ADDRESS: '0x000000000000000000000000000000000000E5c0',
};

function problems(source: EnvSource): string[] {
  try {
    loadConfig(source);
  } catch (error) {
    if (error instanceof EnvError) return error.problems.map((problem) => `${problem.name}: ${problem.reason}`);
    throw error;
  }

  throw new Error('loadConfig accepted an unusable environment');
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return isBursarError(error) ? error.code : 'not_a_bursar_error';
  }

  return 'no_error';
}

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const { config } = loadConfig(REQUIRED);

    expect(config).toMatchObject({
      apiBase: 'http://127.0.0.1:8787',
      capabilitiesPath: 'capabilities.json',
      outputDir: './out',
      outputBaseUrl: undefined,
      outputScope: SCOPE,
      statePath: `./out/${SCOPE}/cursor.json`,
      pollMs: 2_000,
      fetchTimeoutMs: 10_000,
      confirmTimeoutMs: 60_000,
      maxBodyBytes: 1_048_576,
      maxInlineOutputBytes: 4_096,
      blockRange: 1_000n,
      startBlock: undefined,
      finalizeReleases: true,
      escalateExpired: false,
      escalateMaxBond: undefined,
      minGasWei: undefined,
      gasCheckMs: 300_000,
    });
    expect(config.chain.chainId).toBe(4663);
  });

  it('refuses testnet, because USDG is not deployed there', () => {
    // 46630 will take a deploy and will not settle. A sidecar there would watch an escrow that
    // holds nothing and report a quiet day.
    expect(codeOf(() => loadConfig({ ...REQUIRED, RHC_NETWORK: 'testnet' }))).toBe(
      'rhc_testnet_no_settlement_asset',
    );
  });

  it('reads the gas floor in wei, because fees are ETH and settlement is USDG', () => {
    // A quarter of an ETH's thousandth, not a quarter of a dollar. The two are different assets
    // and a floor written in micro-USD would be twelve orders of magnitude too small to warn.
    const { config } = loadConfig({ ...REQUIRED, MIN_GAS_WEI: '250000000000000' });

    expect(config.minGasWei).toBe(250_000_000_000_000n);
  });

  it('will not read a gas floor out of the old settlement-asset variable', () => {
    // MIN_GAS_BALANCE meant micro-USD on a chain where gas was the settlement asset. Taking that
    // number as wei would disarm the warning silently, so the name is gone and an old value is
    // ignored rather than reinterpreted.
    expect(loadConfig({ ...REQUIRED, MIN_GAS_BALANCE: '2000000' }).config.minGasWei).toBeUndefined();
  });

  it('prefers an escrow the operator named', () => {
    const escrow = '0x4444444444444444444444444444444444444444';

    expect(loadConfig({ ...REQUIRED, ESCROW_ADDRESS: escrow }).config.escrow).toBe(escrow);
  });

  it('hands the key back beside the configuration, never inside it', () => {
    const { config, payeeKey } = loadConfig(REQUIRED);

    expect(payeeKey).toBe(KEY);
    expect(JSON.stringify(config, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain(KEY);
  });

  it('carries both rpc endpoints, in the order they were declared', () => {
    expect(loadConfig(REQUIRED).config.providers.map((provider) => provider.name)).toEqual(['primary', 'fallback']);
  });

  it('allows only the configured hosts, loopback included', () => {
    expect([...loadConfig(REQUIRED).config.allowedHosts]).toEqual([]);

    const { config } = loadConfig({ ...REQUIRED, ALLOWED_HOSTS: ' Inputs.Example.com , ,cache.test,[::1] ' });
    expect([...config.allowedHosts]).toEqual(['inputs.example.com', 'cache.test', '::1']);
  });

  it('trims a trailing slash from the api base and the output base', () => {
    const { config } = loadConfig({
      ...REQUIRED,
      API_BASE: 'http://127.0.0.1:8787/',
      OUTPUT_BASE_URL: 'https://outputs.example.com/jobs/',
    });

    expect(config.apiBase).toBe('http://127.0.0.1:8787');
    expect(config.outputBaseUrl).toBe('https://outputs.example.com/jobs');
  });

  it('derives the cursor path from the output directory and the escrow unless one is given', () => {
    expect(loadConfig({ ...REQUIRED, OUTPUT_DIR: '/var/mandate/out/' }).config.statePath).toBe(
      `/var/mandate/out/${SCOPE}/cursor.json`,
    );
    expect(loadConfig({ ...REQUIRED, STATE_PATH: '/var/lib/cursor.json' }).config.statePath).toBe('/var/lib/cursor.json');
  });

  describe('more than one escrow', () => {
    const V2 = '0x4315F8be7C9661345710910577Ec31cb867f3c20';
    const V1 = '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4';

    it('watches every escrow in ESCROW_ADDRESSES, each with its own scope and cursor', () => {
      const { config } = loadConfig({ ...REQUIRED, ESCROW_ADDRESS: undefined, ESCROW_ADDRESSES: `${V2}, ${V1}` });

      expect(config.escrows).toEqual([
        { escrow: V2, outputScope: `4663-${V2.toLowerCase()}`, statePath: `./out/4663-${V2.toLowerCase()}/cursor.json` },
        { escrow: V1, outputScope: `4663-${V1.toLowerCase()}`, statePath: `./out/4663-${V1.toLowerCase()}/cursor.json` },
      ]);
      expect(config.escrow).toBe(V2);
      expect(config.statePath).toBe(`./out/4663-${V2.toLowerCase()}/cursor.json`);
    });

    it('joins ESCROW_ADDRESS with the list, first, and drops a repeat in any case', () => {
      const { config } = loadConfig({ ...REQUIRED, ESCROW_ADDRESS: V1, ESCROW_ADDRESSES: `${V2},${V1.toLowerCase()}` });

      expect(config.escrows.map((watch) => watch.escrow)).toEqual([V1, V2]);
    });

    it('keeps ESCROW_ADDRESS alone as one escrow', () => {
      expect(loadConfig(REQUIRED).config.escrows).toEqual([
        { escrow: REQUIRED.ESCROW_ADDRESS, outputScope: SCOPE, statePath: `./out/${SCOPE}/cursor.json` },
      ]);
    });

    it('refuses an entry that is not an address, and one STATE_PATH for several cursors', () => {
      expect(problems({ ...REQUIRED, ESCROW_ADDRESSES: `${V2},escrow` })).toContain(
        'ESCROW_ADDRESSES: has an entry that is not a 20-byte hex address (escrow)',
      );
      expect(problems({ ...REQUIRED, ESCROW_ADDRESSES: V2, STATE_PATH: '/var/lib/cursor.json' })).toContain(
        'STATE_PATH: is set while 2 escrows are configured, and one cursor cannot serve them all',
      );
    });
  });

  it('reads the overridable numbers and the replay block', () => {
    const { config } = loadConfig({
      ...REQUIRED,
      POLL_MS: '500',
      FETCH_TIMEOUT_MS: '2500',
      CONFIRM_TIMEOUT_MS: '30000',
      MAX_BODY_BYTES: '4096',
      MAX_INLINE_OUTPUT_BYTES: '1024',
      MAX_BLOCK_RANGE: '500',
      START_BLOCK: '61540100',
      OUTPUT_DIR: '/var/mandate/out',
      CAPABILITIES_PATH: './config/capabilities.json',
    });

    expect(config).toMatchObject({
      pollMs: 500,
      fetchTimeoutMs: 2_500,
      confirmTimeoutMs: 30_000,
      maxBodyBytes: 4_096,
      maxInlineOutputBytes: 1_024,
      blockRange: 500n,
      startBlock: 61_540_100n,
      outputDir: '/var/mandate/out',
      capabilitiesPath: './config/capabilities.json',
    });
  });

  it('reads the escalation switch together with its ceiling', () => {
    const { config } = loadConfig({ ...REQUIRED, ESCALATE_EXPIRED: 'true', ESCALATE_MAX_BOND: '250000' });

    expect(config).toMatchObject({ escalateExpired: true, escalateMaxBond: 250_000n });
  });

  it('refuses to escalate without a ceiling on what it may bond', () => {
    expect(problems({ ...REQUIRED, ESCALATE_EXPIRED: 'true' })).toEqual([
      'ESCALATE_MAX_BOND: is not set while ESCALATE_EXPIRED is true',
    ]);
  });

  it('reports every missing variable at once', () => {
    expect(problems({})).toEqual([
      'PAYEE_PRIVATE_KEY: is not set',
      'API_BASE: is not set',
      'RHC_RPC_PRIMARY: is not set',
    ]);
  });

  // ESCROW_ADDRESS is absent from that list because chain 4663 has a deployment record now, and an
  // operator who has to look up an address the address book already holds will eventually paste the
  // wrong one. It is still overridable, for a fork or a second deployment.
  it('takes the escrow off the deployment record when the operator does not name one', () => {
    expect(loadConfig({ ...REQUIRED, ESCROW_ADDRESS: undefined }).config.escrow).toBe(
      deploymentForChain(4663).contracts.Escrow,
    );
  });

  it('refuses two provider names that resolve to one host', () => {
    // RHC_RPC_FALLBACK defaults to the keyless second provider, so an unset fallback is
    // redundant, not single-provider. Naming the primary twice is the real regression.
    expect(codeOf(() => loadConfig({ ...REQUIRED, RHC_RPC_FALLBACK: REQUIRED['RHC_RPC_PRIMARY'] }))).toBe(
      'rpc_single_provider',
    );
    expect(loadConfig({ ...REQUIRED, RHC_RPC_FALLBACK: undefined }).config.chain.chainId).toBe(4663);
  });

  it('reports a chain parameter blanked out in the environment alongside the rest', () => {
    // The chain parameters have verified defaults, so the way to be without one is to set it to
    // an empty string, which is what a shell interpolation that came back blank looks like.
    expect(
      problems({ ...REQUIRED, RHC_MAINNET_CHAIN_ID: '9999', RHC_MAINNET_RPC_URL: '' }),
    ).toEqual(['RHC_MAINNET_RPC_URL: is not set']);
  });

  it('asks for the escrow by name on a chain with no deployment record', () => {
    // A fork of 4663 is mainnet at a different URL and a different chain id, and nothing is
    // recorded for it.
    const fork: EnvSource = {
      ...REQUIRED,
      ESCROW_ADDRESS: undefined,
      RHC_MAINNET_CHAIN_ID: '9999',
      RHC_MAINNET_RPC_URL: 'https://rpc.fork.example',
    };

    expect(problems(fork)).toEqual([
      'ESCROW_ADDRESS: is not set and there is no deployment record for chain 9999',
    ]);
    expect(loadConfig({ ...fork, ESCROW_ADDRESS: '0x4444444444444444444444444444444444444444' }).config.chain.chainId).toBe(
      9999,
    );
  });

  it.each([
    ['PAYEE_PRIVATE_KEY', '0xabc', 'PAYEE_PRIVATE_KEY: does not match the required shape'],
    ['ESCROW_ADDRESS', 'escrow', 'ESCROW_ADDRESS: is not a 20-byte hex address (value: escrow)'],
    ['API_BASE', 'ws://127.0.0.1:8787', 'API_BASE: is not http: or https:'],
    ['POLL_MS', '0', 'POLL_MS: is outside 250..600000 (value: 0)'],
    ['MAX_BODY_BYTES', '1.5', 'MAX_BODY_BYTES: is not an integer (value: 1.5)'],
    ['MAX_BLOCK_RANGE', '0', 'MAX_BLOCK_RANGE: is outside 1..100000 (value: 0)'],
    ['START_BLOCK', '-1', 'START_BLOCK: is below 0 (value: -1)'],
    ['FINALIZE_RELEASES', 'yes', 'FINALIZE_RELEASES: is not true or false (value: yes)'],
  ])('refuses %s=%s', (name, value, problem) => {
    expect(problems({ ...REQUIRED, [name]: value })).toContain(problem);
  });

  it('never repeats the private key in its problem report', () => {
    const secret = `0x${'9c'.repeat(20)}`;

    try {
      loadConfig({ ...REQUIRED, PAYEE_PRIVATE_KEY: secret });
      expect.unreachable('loadConfig accepted a malformed key');
    } catch (error) {
      expect((error as EnvError).message).not.toContain(secret);
    }
  });
});
