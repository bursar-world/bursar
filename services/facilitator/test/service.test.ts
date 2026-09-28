import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createFacilitatorService } from '../src/service.js';
import type { FacilitatorService } from '../src/service.js';
import { RecordingDatabase, ScriptedScheme } from './support/doubles.js';

/**
 * Housekeeping the service owns.
 *
 * A hold that is never consumed keeps a principal's balance locked, and a quarantined trust event
 * stays in the dead letter table for ever. Both are documented as swept and neither was, because
 * nothing started a timer.
 */

const RELAYER_KEY = `0x${'11'.repeat(32)}`;
const RELAYER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';

let service: FacilitatorService | null = null;

afterEach(async () => {
  await service?.stop();
  service = null;
  vi.useRealTimers();
});

async function start(db: RecordingDatabase): Promise<void> {
  const config = loadConfig({
    DATABASE_URL: 'postgres://mandate:secret@127.0.0.1:5432/mandate',
    RHC_RPC_PRIMARY: 'https://rpc.mainnet.chain.robinhood.com',
    RHC_RPC_FALLBACK: 'https://robinhood.drpc.org',
    FACILITATOR_HOST: '127.0.0.1',
    FACILITATOR_PORT: String(await freePort()),
    FACILITATOR_GAS_FLOAT: RELAYER,
    FACILITATOR_SETTLEMENT: '0x2222222222222222222222222222222222222222',
    FACILITATOR_COLLATERAL: '0x3333333333333333333333333333333333333333',
    FACILITATOR_TREASURY: '0x4444444444444444444444444444444444444444',
    FACILITATOR_RELAYER_KEY: RELAYER_KEY,
    FACILITATOR_GAS_FLOAT_MINIMUM_ETH: '0.005',
    FACILITATOR_FEE_BPS: '100',
    FACILITATOR_FEE_FLOOR_MICRO: '1900',
    FACILITATOR_RESERVATION_TTL_SECONDS: '120',
  });

  service = createFacilitatorService({ config, scheme: new ScriptedScheme(), db });
  vi.useFakeTimers();
  await service.start();
}

describe('the maintenance timer', () => {
  it('expires stale holds and sweeps quarantined events while the service runs', async () => {
    const db = new RecordingDatabase();
    await start(db);

    expect(db.saw(/status = 'expired'/)).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(db.saw(/status = 'expired'/)).toBe(true);
    expect(db.saw(/DELETE FROM bursar_trust_dead_letter/)).toBe(true);
  });

  it('stops when the service does', async () => {
    const db = new RecordingDatabase();
    await start(db);

    await vi.advanceTimersByTimeAsync(60_000);
    const after = db.queries.length;

    await service?.stop();
    service = null;
    await vi.advanceTimersByTimeAsync(300_000);

    expect(db.queries.length).toBe(after);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
