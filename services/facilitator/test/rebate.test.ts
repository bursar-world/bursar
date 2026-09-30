import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  MAX_REBATE_BPS,
  REBATE_CACHE_MS,
  REBATE_CACHE_SIZE,
  Rebates,
  stakingRebateAbi,
  stakingRebates,
} from '../src/x402/rebate.js';

const POOL = '0x3f2a0E7822B30aD928488F053348b137866Cf962';
const PAYEE = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374';
const OTHER = '0x877c349EFb5926082C413833E8055F0991185c61';

/** A pool that answers from `answer` and remembers who it was asked about. */
function pool(answer: (payee: Address) => Promise<number>) {
  const asked: Address[] = [];
  return {
    asked,
    read: async (payee: Address) => {
      asked.push(payee);
      return answer(payee);
    },
  };
}

describe('the pool read', () => {
  it('calls rebateBpsOf on the pool for the payee', async () => {
    const calls: unknown[] = [];
    const read = stakingRebates(
      {
        readContract: async (args) => {
          calls.push(args);
          return 1_000;
        },
      },
      POOL,
    );

    expect(await read?.(PAYEE)).toBe(1_000);
    expect(calls).toEqual([{ address: POOL, abi: stakingRebateAbi, functionName: 'rebateBpsOf', args: [PAYEE] }]);
  });

  it('is absent where the deployment record names no pool', () => {
    expect(stakingRebates({ readContract: async () => 0 }, null)).toBeNull();
  });
});

describe('rebates', () => {
  it('asks the pool once per payee within the interval, and again after it', async () => {
    let now = 0;
    const source = pool(async () => 500);
    const rebates = new Rebates({ read: source.read, now: () => now });

    expect(await rebates.of(PAYEE)).toBe(500);
    now += REBATE_CACHE_MS - 1;
    // A payee is one address however it is spelled.
    expect(await rebates.of(PAYEE.toLowerCase())).toBe(500);
    expect(source.asked).toHaveLength(1);

    now += 1;
    expect(await rebates.of(PAYEE)).toBe(500);
    expect(source.asked).toHaveLength(2);
  });

  it('answers each payee for itself', async () => {
    const source = pool(async (payee) => (payee === PAYEE.toLowerCase() ? 3_000 : 0));
    const rebates = new Rebates({ read: source.read });

    expect(await rebates.of(PAYEE)).toBe(3_000);
    expect(await rebates.of(OTHER)).toBe(0);
    expect(source.asked).toEqual([PAYEE.toLowerCase(), OTHER.toLowerCase()]);
  });

  it('counts a failed read as no rebate, logs it, and asks again on the next settle', async () => {
    const lines: string[] = [];
    let down = true;
    const source = pool(async () => {
      if (down) throw new Error('socket hang up');
      return 2_000;
    });
    const rebates = new Rebates({ read: source.read, log: (line) => lines.push(line) });

    expect(await rebates.of(PAYEE)).toBe(0);
    expect(lines).toEqual([`rebate unread payee=${PAYEE} fee=full reason=socket hang up`]);

    down = false;
    expect(await rebates.of(PAYEE)).toBe(2_000);
    expect(source.asked).toHaveLength(2);
  });

  it('refuses an answer the pool could not have given', async () => {
    for (const answer of [MAX_REBATE_BPS + 1, -1, 2.5]) {
      const lines: string[] = [];
      const rebates = new Rebates({ read: async () => answer, log: (line) => lines.push(line) });

      expect(await rebates.of(PAYEE)).toBe(0);
      expect(lines).toEqual([
        `rebate unread payee=${PAYEE} fee=full reason=the pool answered ${answer}, outside 0 to ${MAX_REBATE_BPS}`,
      ]);
    }
  });

  it('asks nothing about a payee that is not an address', async () => {
    const lines: string[] = [];
    const source = pool(async () => 3_000);
    const rebates = new Rebates({ read: source.read, log: (line) => lines.push(line) });

    expect(await rebates.of('')).toBe(0);
    expect(source.asked).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it('charges the full fee without asking where no pool is deployed', async () => {
    const lines: string[] = [];
    const rebates = new Rebates({ read: null, log: (line) => lines.push(line) });

    expect(await rebates.of(PAYEE)).toBe(0);
    expect(lines).toEqual([]);
  });

  it('drops the oldest answer once it holds as many payees as it keeps', async () => {
    const source = pool(async () => 500);
    const rebates = new Rebates({ read: source.read });
    const payee = (index: number): Address => `0x${index.toString(16).padStart(40, '0')}`;

    for (let index = 1; index <= REBATE_CACHE_SIZE + 1; index += 1) await rebates.of(payee(index));
    expect(source.asked).toHaveLength(REBATE_CACHE_SIZE + 1);

    await rebates.of(payee(REBATE_CACHE_SIZE + 1));
    expect(source.asked).toHaveLength(REBATE_CACHE_SIZE + 1);
    await rebates.of(payee(1));
    expect(source.asked).toHaveLength(REBATE_CACHE_SIZE + 2);
  });
});
