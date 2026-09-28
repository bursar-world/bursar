import { describe, expect, it } from 'vitest';
import { RpcPool } from '../src/rpc/pool.js';
import type { RpcPoolEvent } from '../src/rpc/pool.js';
import { RHC_MAINNET } from '../src/chain.js';

/**
 * The pacer against the endpoint it was measured on, with nothing else to fall back to.
 *
 * This suite exists because the last one did not. A counting semaphore set to twenty passed every
 * offline test and changed nothing on chain: thirty parallel calls still came back twenty answered
 * and ten rate-limited, because the endpoint meters arrivals per second and a semaphore cannot
 * bound a rate. A mock cannot tell you that. Only the endpoint can.
 *
 * Off by default because it needs the network. Point `BURSAR_LIVE_RPC` at a Robinhood Chain
 * endpoint to run it:
 *
 *   BURSAR_LIVE_RPC=https://rpc.mainnet.chain.robinhood.com pnpm --filter @bursar/core test
 */

const RPC = process.env.BURSAR_LIVE_RPC ?? '';

/** `decimals()` on USDG: cheap, cached by no one, and answers from any block. */
const DECIMALS_CALL = [{ to: RHC_MAINNET.usdg, data: '0x313ce567' }, 'latest'] as const;

function solo(onEvent: (event: RpcPoolEvent) => void): RpcPool {
  return new RpcPool({
    providers: [{ name: 'rhc', url: RPC }],
    timeoutMs: 30_000,
    onEvent,
    retry: { maxPasses: 3, baseDelayMs: 250, maxDelayMs: 2_000 },
  });
}

async function fanOut(pool: RpcPool, calls: number): Promise<{ answered: number; ms: number }> {
  const started = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: calls }, () => pool.request<string>('eth_call', [...DECIMALS_CALL])),
  );
  const ms = Date.now() - started;

  for (const result of results) {
    if (result.status === 'rejected') throw result.reason as Error;
    expect(BigInt(result.value)).toBe(6n);
  }
  return { answered: results.length, ms };
}

function report(label: string, pool: RpcPool, ms: number, events: RpcPoolEvent[]): void {
  const status = pool.status()[0];
  process.stdout.write(
    `  ${label} in ${ms} ms: ${status?.requests ?? 0} sent, ${status?.failures ?? 0} failed, ` +
      `${status?.throttled ?? 0} rate limited, pacing at ` +
      `${status?.effectiveRatePerSecond?.toFixed(2) ?? 'n/a'}/s, breaker ${status?.state ?? 'n/a'}, ` +
      `${events.length} events\n`,
  );
  for (const event of events.slice(0, 8)) process.stdout.write(`    ${JSON.stringify(event)}\n`);
}

/**
 * What is asserted is what a caller sees: every call answered, no breaker opened, no decision
 * refused. The endpoint drops the odd socket under a burst, which the retry pass absorbs. The
 * per-provider failure count is printed, not asserted on. A 429 is printed too: it is the pacer
 * being corrected by the endpoint, which is the mechanism working.
 */
describe.skipIf(!RPC)('pacing a fan-out at a single live Robinhood Chain endpoint', () => {
  it('answers thirty parallel eth_calls with nothing refused', async () => {
    const events: RpcPoolEvent[] = [];
    const pool = solo((event) => events.push(event));

    const { answered, ms } = await fanOut(pool, 30);
    report('30 parallel', pool, ms, events);

    expect(answered).toBe(30);
    expect(pool.status()[0]).toMatchObject({ state: 'closed' });
    expect(events.filter((e) => e.type === 'all_providers_down')).toHaveLength(0);
  }, 120_000);

  it('answers two hundred, slower, and still opens no breaker', async () => {
    const events: RpcPoolEvent[] = [];
    const pool = solo((event) => events.push(event));

    const { answered, ms } = await fanOut(pool, 200);
    report('200 parallel', pool, ms, events);

    expect(answered).toBe(200);
    expect(pool.status()[0]).toMatchObject({ state: 'closed' });
    expect(events.filter((e) => e.type === 'all_providers_down')).toHaveLength(0);

    // Two hundred through a forty-a-second bucket cannot be quick, and quick would mean the
    // pacer was not doing anything.
    expect(ms).toBeGreaterThan(3_000);
  }, 300_000);
});
