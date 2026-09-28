import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';
import type { EnvSource } from '@bursar/core';

import { compose } from '../src/main.js';

/** A port nothing listens on: bound by the OS, then released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function env(databaseUrl: string): EnvSource {
  return {
    DATABASE_URL: databaseUrl,
    RHC_RPC_PRIMARY: 'http://127.0.0.1:1/primary',
    RHC_RPC_FALLBACK: 'http://localhost:1/fallback',
    FACILITATOR_GAS_FLOAT: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
    FACILITATOR_SETTLEMENT: '0x3E9CF4ef0C0A0F1b2A5B4a1F6c0d7e8F9a0bB8a8',
    FACILITATOR_COLLATERAL: '0x139FC6Df0b5C8a9E2d3F4a5B6c7D8e9F0a1b8c18',
    FACILITATOR_TREASURY: '0x7F97980568AD3bFe77B2150b5cdD98eB5f271718',
    FACILITATOR_RELAYER_KEY: `0x${'11'.repeat(32)}`,
    FACILITATOR_GAS_FLOAT_MINIMUM_ETH: '0.0001',
    FACILITATOR_FEE_BPS: '100',
    FACILITATOR_FEE_FLOOR_MICRO: '1900',
    FACILITATOR_UNDERWRITER: 'none',
  };
}

describe('starting against a database it cannot reach', () => {
  it('refuses by name, with the reason and without the password', async () => {
    const port = await closedPort();
    const refusal = await compose(env(`postgres://bursar:hunter2@127.0.0.1:${port}/bursar`)).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ code: 'database_unreachable' });
    const message = (refusal as Error).message;
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain(`127.0.0.1:${port}/bursar`);
    expect(message).toContain('ECONNREFUSED');
    expect(message).not.toContain('hunter2');
  }, 20_000);

  // localhost resolves to both families here, and the driver reports that as an AggregateError
  // whose own message is empty.
  it('still says why when the refusal comes from every address a name resolves to', async () => {
    const port = await closedPort();
    const refusal = await compose(env(`postgres://bursar:hunter2@localhost:${port}/bursar`)).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ code: 'database_unreachable' });
    expect((refusal as Error).message).toMatch(/: \S.*\. Check the host/);
  }, 20_000);
});
