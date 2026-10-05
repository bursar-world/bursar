import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { outflow, readState, readingState, writeState, type MonitorState } from '../../../contracts/script/monitor-state.mjs';

const USDG = (whole: number) => BigInt(whole) * 1_000_000n;
const BRSR = (whole: number) => BigInt(whole) * 10n ** 18n;

describe('the monitor rule for an outflow between two runs', () => {
  it('ignores a balance that held or grew', () => {
    expect(outflow(USDG(1_000), USDG(1_000), 6)).toBeNull();
    expect(outflow(USDG(1_000), USDG(1_500), 6)).toBeNull();
    expect(outflow(0n, 0n, 6)).toBeNull();
  });

  it('alerts on a fall over a quarter of the previous figure, and not under it', () => {
    expect(outflow(USDG(1_000), USDG(800), 6)).toBeNull();
    expect(outflow(USDG(1_000), USDG(750), 6)).toBeNull();
    expect(outflow(USDG(1_000), USDG(749), 6)).toBe(USDG(251));
    expect(outflow(USDG(1_000), 0n, 6)).toBe(USDG(1_000));
  });

  it('keeps dust quiet under one whole unit, whatever the share', () => {
    expect(outflow(1_000_000n, 1n, 6)).toBeNull();
    expect(outflow(3_000_000n, 2_000_000n, 6)).toBeNull();
    expect(outflow(3_000_000n, 1_999_999n, 6)).toBe(1_000_001n);
    // The floor is in the asset's own units, so BRSR at 18 decimals is held to 1 BRSR.
    expect(outflow(BRSR(3), BRSR(2), 18)).toBeNull();
    expect(outflow(BRSR(3), BRSR(2) - 1n, 18)).toBe(BRSR(1) + 1n);
  });

  it('sees a small balance drained: the credit pool at 20 USDG halving alerts, a 2.5% dip does not', () => {
    expect(outflow(USDG(20), USDG(10), 6)).toBe(USDG(10));
    expect(outflow(USDG(20), 19_500_000n, 6)).toBeNull();
  });
});

describe('the monitor rule for the price guard\'s readings', () => {
  const MIN = 300n;
  const MAX = 3600n;
  const now = 1_800_000_000n;

  it('alerts when nothing is in force: no aged sample, or one past the bound', () => {
    expect(readingState(0n, 0n, now, MIN, MAX)).toEqual({ level: 'alert', agedAge: null, pendingAge: null });
    expect(readingState(0n, now - 60n, now, MIN, MAX)).toEqual({ level: 'alert', agedAge: null, pendingAge: 60n });
    expect(readingState(now - MAX - 1n, now - 60n, now, MIN, MAX)).toEqual({ level: 'alert', agedAge: MAX + 1n, pendingAge: 60n });
  });

  it('is ok while the aged sample is inside the bound, and at the bound itself', () => {
    expect(readingState(now - 600n, now - 120n, now, MIN, MAX)).toEqual({ level: 'ok', agedAge: 600n, pendingAge: 120n });
    expect(readingState(now - (MAX - 2n * MIN), now - 120n, now, MIN, MAX).level).toBe('ok');
  });

  it('warns once the keeper has missed a pass: older than the bound less two keeper intervals', () => {
    expect(readingState(now - (MAX - 2n * MIN) - 1n, now - 120n, now, MIN, MAX)).toEqual({ level: 'warn', agedAge: MAX - 2n * MIN + 1n, pendingAge: 120n });
    expect(readingState(now - MAX, now - 120n, now, MIN, MAX).level).toBe('warn');
  });
});

describe('the monitor state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bursar-monitor-'));
  const state: MonitorState = {
    version: 1,
    at: '2027-01-15T08:00:00Z',
    block: '78643249',
    balances: { 'escrow USDG': { value: '123450000', decimals: 6, symbol: 'USDG' }, 'staking BRSR': { value: '0', decimals: 18, symbol: 'BRSR' } },
  };

  it('is absent before the first run, and reads back what the last run wrote', () => {
    const path = join(dir, 'runs', 'state.json');
    expect(readState(path)).toBeNull();

    writeState(path, state);

    expect(readState(path)).toEqual(state);
    expect(readdirSync(join(dir, 'runs')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a file that is not a state rather than comparing against it', () => {
    for (const [text, reason] of [
      ['not json', 'not JSON'],
      ['[]', 'not a monitor state'],
      ['{"version":2,"at":"x","block":"1","balances":{}}', 'not a monitor state'],
      ['{"version":1,"at":"x","block":"1","balances":{"escrow USDG":{"value":"-5","decimals":6,"symbol":"USDG"}}}', 'not an amount'],
    ]) {
      const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(path, text as string);
      expect(() => readState(path)).toThrow(reason);
    }
  });

  it('leaves the previous state when the new one cannot be written', () => {
    const path = join(dir, 'kept.json');
    writeState(path, state);
    expect(() => writeState(path, { ...state, balances: { bad: 1n as never } })).toThrow();
    expect(readState(path)).toEqual(state);
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });
});
