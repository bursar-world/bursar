import { describe, expect, it } from 'vitest';

import { createGasMonitor, readGasBalance } from '../src/gas.js';
import { PAYEE, createRecordingLogger } from './fakes.js';

const GWEI = 1_000_000_000n;

describe('readGasBalance', () => {
  it('reports the fee budget in wei, not in the settlement asset', async () => {
    // Gas is ETH and settlement is USDG. Dividing this down into micro-USD would report five
    // million of something the payee does not hold, next to amounts it really does.
    const client = { getBalance: async () => 5n * 10n ** 18n };

    expect(await readGasBalance(client, PAYEE)).toBe(5_000_000_000_000_000_000n);
  });

  it('keeps the whole balance, because a fee is priced in wei', async () => {
    // Under a millionth of an ETH still buys blocks at 0.05 gwei, which is the price on this
    // chain. Flooring it away would report a working payee as empty.
    const client = { getBalance: async () => 1_999_999_999_999n };

    expect(await readGasBalance(client, PAYEE)).toBe(1_999_999_999_999n);
  });
});

function monitor(balances: bigint[], minimum: bigint) {
  const log = createRecordingLogger();
  let clock = 0;
  const queue = [...balances];

  const gas = createGasMonitor({
    address: PAYEE,
    read: async () => queue.shift() ?? 0n,
    minimum,
    intervalMs: 300_000,
    logger: log.logger,
    now: () => clock,
  });

  return { gas, log, advance: (ms: number) => (clock += ms) };
}

describe('createGasMonitor', () => {
  it('warns while the fee budget sits under the floor, in ETH', async () => {
    const { gas, log } = monitor([400_000n * GWEI], 1_000_000n * GWEI);

    await gas.check();

    expect(log.find('gas_low')?.fields).toMatchObject({
      balance: '0.0004 ETH',
      minimum: '0.001 ETH',
    });
  });

  it('says nothing while the balance is healthy', async () => {
    const { gas, log } = monitor([9_000_000n * GWEI], 1_000_000n * GWEI);

    await gas.check();

    expect(log.entries).toHaveLength(0);
  });

  it('reads at most once per interval', async () => {
    const { gas, log, advance } = monitor([0n, 0n], 1_000_000n * GWEI);

    await gas.check();
    await gas.check();
    advance(299_999);
    await gas.check();

    expect(log.events()).toEqual(['gas_low']);

    advance(1);
    await gas.check();

    expect(log.events()).toEqual(['gas_low', 'gas_low']);
  });

  it('notes the refill once, then goes quiet again', async () => {
    const { gas, log, advance } = monitor(
      [0n, 5_000_000n * GWEI, 5_000_000n * GWEI],
      1_000_000n * GWEI,
    );

    await gas.check();
    advance(300_000);
    await gas.check();
    advance(300_000);
    await gas.check();

    expect(log.events()).toEqual(['gas_low', 'gas_refilled']);
  });
});
