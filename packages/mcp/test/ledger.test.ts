import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ToolError } from '../src/errors.js';
import { LEDGER_WINDOW_MS, createSpendLedger } from '../src/ledger.js';

const dir = mkdtempSync(join(tmpdir(), 'bursar-mcp-ledger-'));
const NOW = Date.parse('2027-01-15T08:00:00Z');
const HOUR = 3_600_000;

const fresh = () => join(dir, `${Math.random().toString(36).slice(2)}.json`);

function refusal(run: () => void): ToolError {
  try {
    run();
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('the call was expected to refuse');
}

describe('the ledger of shielded payments', () => {
  it('starts as an empty day with no file, and writes the file with the first payment', () => {
    const path = fresh();
    const ledger = createSpendLedger(path, () => NOW);

    expect(ledger.day()).toEqual({ drawn: 0n, payments: [] });

    ledger.draw(20_202n, 50_000n);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      payments: [{ at: '2027-01-15T08:00:00.000Z', micro: '20202' }],
    });
    expect(ledger.day()).toEqual({ drawn: 20_202n, payments: [{ at: NOW, micro: 20_202n }] });
  });

  it('refuses the payment that would pass the cap, says when room returns, and writes nothing', () => {
    let clock = NOW;
    const path = fresh();
    const ledger = createSpendLedger(path, () => clock);
    ledger.draw(20_000n, 50_000n);
    clock = NOW + HOUR;
    ledger.draw(20_000n, 50_000n);
    const before = readFileSync(path, 'utf8');

    const refused = refusal(() => ledger.check(20_000n, 50_000n));

    expect(refused.code).toBe('shielded_daily_cap');
    expect(refused.message).toContain('0.05 USDG');
    expect(refused.message).toContain('0.04 USDG has gone out');
    // Once the first payment is a day old, 20,000 + 20,000 fits under 50,000.
    expect(refused.detail).toEqual({ cap: '50000', drawn: '40000', payment: '20000', resumesAt: '2027-01-16T08:00:00Z' });
    expect(refusal(() => ledger.draw(20_000n, 50_000n)).code).toBe('shielded_daily_cap');
    expect(readFileSync(path, 'utf8')).toBe(before);

    // A payment over the cap on its own never fits, and the refusal says so rather than naming a time.
    const alone = refusal(() => ledger.check(60_000n, 50_000n));
    expect(alone.detail['resumesAt']).toBeNull();
    expect(alone.message).toContain('over the daily cap on its own');
  });

  it('counts a payment for exactly 24 hours, then drops it from the file', () => {
    let clock = NOW;
    const path = fresh();
    const ledger = createSpendLedger(path, () => clock);
    ledger.draw(30_000n, 50_000n);

    clock = NOW + LEDGER_WINDOW_MS - 1;
    expect(ledger.day().drawn).toBe(30_000n);
    expect(refusal(() => ledger.check(30_000n, 50_000n)).code).toBe('shielded_daily_cap');

    clock = NOW + LEDGER_WINDOW_MS;
    expect(ledger.day().drawn).toBe(0n);
    ledger.draw(30_000n, 50_000n);
    expect(JSON.parse(readFileSync(path, 'utf8')).payments).toEqual([{ at: '2027-01-16T08:00:00.000Z', micro: '30000' }]);
  });

  it('reads the day another process wrote, which is what a restart is', () => {
    const path = fresh();
    createSpendLedger(path, () => NOW).draw(45_000n, 50_000n);

    const restarted = createSpendLedger(path, () => NOW + HOUR);

    expect(restarted.day().drawn).toBe(45_000n);
    expect(refusal(() => restarted.draw(5_001n, 50_000n)).code).toBe('shielded_daily_cap');
    restarted.draw(5_000n, 50_000n);
    expect(createSpendLedger(path, () => NOW + 2 * HOUR).day().drawn).toBe(50_000n);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a JSON array', '[]'],
    ['a version this server does not write', '{"version":2,"payments":[]}'],
    ['no payments at all', '{"version":1}'],
    ['a payment without a time', '{"version":1,"payments":[{"micro":"1"}]}'],
    ['a payment at a time that is not one', '{"version":1,"payments":[{"at":"yesterday","micro":"1"}]}'],
    ['a payment that is not an amount', '{"version":1,"payments":[{"at":"2027-01-15T07:00:00Z","micro":"-5"}]}'],
    ['a payment that is a number', '{"version":1,"payments":[{"at":"2027-01-15T07:00:00Z","micro":5}]}'],
  ])('refuses to read %s, and sends nothing on it', (_label, text) => {
    const path = fresh();
    writeFileSync(path, text);
    const ledger = createSpendLedger(path, () => NOW);

    for (const read of [() => ledger.day(), () => ledger.check(1n, 10n), () => ledger.draw(1n, 10n)]) {
      const refused = refusal(read);
      expect(refused.code).toBe('shielded_ledger_unreadable');
      expect(refused.message).toContain('no shielded payment is sent');
      expect(refused.detail['path']).toBe(path);
    }
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('refuses to record where it cannot write, and leaves no half-written file behind', () => {
    const path = join(dir, 'nowhere', 'ledger.json');

    const refused = refusal(() => createSpendLedger(path, () => NOW).draw(1n, 10n));

    expect(refused.code).toBe('shielded_ledger_unwritable');
    expect(refused.message).toContain('this payment was not sent');
    expect(refused.detail).toEqual({ path, reason: 'ENOENT' });
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('writes the file for its owner alone, whole, with nothing left beside it', () => {
    const path = fresh();

    createSpendLedger(path, () => NOW).draw(1n, 10n);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
