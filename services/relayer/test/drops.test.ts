import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { GAS_DROP_WINDOW_MS, GasDropLedger } from '../src/index.js';

const A: Address = '0x88466ccD4688ddb6413DBBA420Af2B0696892388';
const B: Address = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'cd'.repeat(32)}` as Hex;

describe('the gas-drop ledger', () => {
  it('remembers notes and recipients across a restart, and counts a rolling day', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'relayer-')), 'drops', 'gas-drops.jsonl');
    let now = 1_000_000;
    const first = new GasDropLedger(path, () => now);
    first.record({ note: 1n, recipient: A, wei: 10n, hash: HASH });
    now += 1_000;
    first.record({ note: 2n, recipient: B, wei: 10n, hash: HASH });
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);

    const second = new GasDropLedger(path, () => now);
    expect(second.hasNote(1n)).toBe(true);
    expect(second.hasNote(3n)).toBe(false);
    expect(second.hasRecipient(A.toLowerCase() as Address)).toBe(true);
    expect(second.hasRecipient(B)).toBe(true);
    expect(second.countToday()).toBe(2);

    now += GAS_DROP_WINDOW_MS - 1;
    expect(second.countToday()).toBe(1);
    now += 2;
    expect(second.countToday()).toBe(0);
    // The rules outlive the window; only the budget rolls.
    expect(second.hasNote(1n)).toBe(true);
  });

  it('starts empty without a file', () => {
    const ledger = new GasDropLedger(null);
    expect(ledger.countToday()).toBe(0);
    ledger.record({ note: 1n, recipient: A, wei: 10n, hash: HASH });
    expect(ledger.countToday()).toBe(1);
  });
});
