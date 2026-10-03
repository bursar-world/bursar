import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { outflow, readState, writeState, type MonitorState } from '../../../contracts/script/monitor-state.mjs';

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

  it('keeps a small balance quiet under 100 whole units, whatever the share', () => {
    expect(outflow(USDG(10), USDG(1), 6)).toBeNull();
    expect(outflow(USDG(300), USDG(200), 6)).toBeNull();
    expect(outflow(USDG(300), USDG(199), 6)).toBe(USDG(101));
    // The floor is in the asset's own units, so BRSR at 18 decimals is held to 100 BRSR.
    expect(outflow(BRSR(150), BRSR(60), 18)).toBeNull();
    expect(outflow(BRSR(150), BRSR(40), 18)).toBe(BRSR(110));
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
