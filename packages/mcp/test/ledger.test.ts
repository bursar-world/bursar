import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ToolError } from '../src/errors.js';
import { LEDGER_WINDOW_MS, createSpendLedger } from '../src/ledger.js';

const dir = mkdtempSync(join(tmpdir(), 'bursar-mcp-ledger-'));
const NOW = Date.parse('2027-01-15T08:00:00Z');
const HOUR = 3_600_000;

const fresh = () => join(dir, `${Math.random().toString(36).slice(2)}.json`);

/** Runs ledger-worker.ts in its own process, drawing `draws` times against `cap` on the ledger at `path`. */
function worker(path: string, cap: number, draws: number): Promise<{ drawn: number; refused: number }> {
  const script = fileURLToPath(new URL('ledger-worker.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    // tsx is resolved from the package, where it is a dev dependency.
    const child = spawn(process.execPath, ['--import', 'tsx', script, path, String(cap), String(draws)], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}: ${err}`));
      else resolve(JSON.parse(out) as { drawn: number; refused: number });
    });
  });
}

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

  it('takes a lock for the draw and leaves none behind', () => {
    const path = fresh();

    createSpendLedger(path, () => NOW).draw(1n, 10n);

    expect(readdirSync(dir).filter((name) => name.endsWith('.lock'))).toEqual([]);
  });

  it('clears a lock left by a process that died, and draws', () => {
    const path = fresh();
    writeFileSync(`${path}.lock`, '');
    const aMinuteAgo = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, aMinuteAgo, aMinuteAgo);

    createSpendLedger(path, () => NOW, { waitMs: 500, staleMs: 10_000 }).draw(1n, 10n);

    expect(createSpendLedger(path, () => NOW).day().drawn).toBe(1n);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('refuses the payment, sending nothing, while a live process holds the lock past the wait', () => {
    const path = fresh();
    writeFileSync(`${path}.lock`, '');
    const ledger = createSpendLedger(path, () => NOW, { waitMs: 200, staleMs: 10_000 });

    const refused = refusal(() => ledger.draw(1n, 10n));

    expect(refused.code).toBe('shielded_ledger_locked');
    expect(refused.message).toContain('this payment was not sent');
    expect(refused.detail).toEqual({ path, lock: `${path}.lock` });
    expect(existsSync(path)).toBe(false);
    // Reads need no lock: the file is replaced whole, so a reader sees one day or the next.
    expect(ledger.day()).toEqual({ drawn: 0n, payments: [] });
    ledger.check(1n, 10n);
  });

  it('counts every draw and holds the cap exactly when several processes share the file', async () => {
    const path = fresh();
    const cap = 1_000;
    const results = await Promise.all([1, 2, 3, 4].map(() => worker(path, cap, 300)));

    const drawn = results.reduce((sum, r) => sum + r.drawn, 0);
    const refused = results.reduce((sum, r) => sum + r.refused, 0);
    expect(drawn).toBe(cap);
    expect(refused).toBe(1_200 - cap);
    // What the workers were told they drew is what the file holds: nothing was lost to a race.
    const day = createSpendLedger(path).day();
    expect(day.payments).toHaveLength(cap);
    expect(day.drawn).toBe(BigInt(cap));
    expect(readdirSync(dir).filter((name) => name.startsWith(`${path.slice(dir.length + 1)}.`))).toEqual([]);
  });
});
