import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const ENV = {
  DATABASE_URL: 'postgres://bursar:bursar@127.0.0.1:55432/bursar',
  MCP_HOST_KEK: `0x${'ab'.repeat(32)}`,
  RHC_RPC_PRIMARY: 'https://primary.test',
  RHC_RPC_FALLBACK: 'https://fallback.test',
};

describe('host configuration', () => {
  it('reads the defaults and derives the public address from the listener', () => {
    const config = loadConfig(ENV);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8410);
    expect(config.publicUrl).toBe('http://127.0.0.1:8410');
    expect(config.tokenRpm).toBe(120);
    expect(config.chain.chainId).toBe(4663);
    expect(config.providers.map((provider) => provider.name)).toEqual(['primary', 'fallback']);
  });

  it('takes the public address connectors are told, without a trailing slash', () => {
    expect(loadConfig({ ...ENV, MCP_HOST_PUBLIC_URL: 'https://mcp.bursar.world/' }).publicUrl).toBe('https://mcp.bursar.world');
  });

  it('refuses to start without a key-encryption key, and never echoes one it cannot read', () => {
    expect(() => loadConfig({ ...ENV, MCP_HOST_KEK: '' })).toThrow(/MCP_HOST_KEK/u);
    expect(() => loadConfig({ ...ENV, MCP_HOST_KEK: 'deadbeef' })).toThrow(/MCP_HOST_KEK/u);
    expect(() => loadConfig({ ...ENV, MCP_HOST_KEK: 'deadbeef' })).not.toThrow(/deadbeef/u);
  });

  it('refuses a key arriving from the environment', () => {
    expect(() => loadConfig({ ...ENV, PRIVATE_KEY: `0x${'11'.repeat(32)}` })).toThrow(/PRIVATE_KEY/u);
    expect(() => loadConfig({ ...ENV, BURSAR_SIGNER_KEY: `0x${'11'.repeat(32)}` })).toThrow(/BURSAR_SIGNER_KEY/u);
    expect(() => loadConfig({ ...ENV, BURSAR_RELAY_URL: 'https://relay.test' })).toThrow(/BURSAR_RELAY_URL/u);
  });
});
