import { describe, expect, it } from 'vitest';
import { rwaDeployment } from '@bursar/core';

import { connect } from '../src/connection.js';
import { mandateAccount } from '../src/mandate.js';
import { RwaClient, UnknownAssetError, rwa } from '../src/rwa.js';
import type { MandateAccountClient } from '../src/mandate.js';

const EXAMPLE = '0x420BeB507F72173E7d78e0f956968f64fb508356';
const live = process.env['BURSAR_LIVE_RHC'] === '1';

function offline(): MandateAccountClient {
  return { address: EXAMPLE, connection: connect({ chainId: 4663 }) } as unknown as MandateAccountClient;
}

describe('rwa client', () => {
  it('resolves assets and adapters from the deployment record', () => {
    const client = new RwaClient(offline());
    expect(client.resolve('sgov')).toBe('0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5');
    expect(client.resolve('SPY')).toBe('0x117cc2133c37B721F49dE2A7a74833232B3B4C0C');
    expect(client.adapter('SGOV')).toBe(rwaDeployment(4663)?.adapters['SGOV']);
    expect(() => client.resolve('TSLA')).toThrow(UnknownAssetError);
  });

  it.skipIf(!live)('reads the example mandate on 4663', async () => {
    const client = rwa(await mandateAccount(EXAMPLE, { chainId: 4663 }));
    const assets = await client.assets();
    expect(assets.map((a) => a.symbol).sort()).toEqual(['AAPL', 'NVDA', 'SGOV', 'SPY']);
    const holdings = await client.holdings();
    expect(holdings.find((h) => h.asset.symbol === 'SPY')?.raw).toBeGreaterThan(0n);
    const parked = await client.parked();
    expect(parked.find((p) => p.symbol === 'SGOV')?.raw).toBeGreaterThan(0n);
    const policy = await client.policy();
    expect(policy.allowed).toContain('0x117cc2133c37B721F49dE2A7a74833232B3B4C0C');
  });
});
