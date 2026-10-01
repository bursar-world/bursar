import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SHIELDED_TIMING_LINE, STEALTH_LIMIT_LINE } from '@/chain/stealth';
import {
  PURPOSES,
  depositProblem,
  depositRoomLine,
  intentFromQuery,
  labelInSet,
  poolLimits,
  relayFee,
  setMatchesChain,
  shieldedContracts,
  shieldedHref,
  shieldedServices,
  usdgText,
  withdrawProblem,
} from '@/chain/shielded';
import { ADDRESS_ROUTES, addressSegment } from '@/lib/path';
import { copyShieldedArtifacts } from '../scripts/shielded-artifacts';

const MANDATE = '0x8e9F843C646a4bFEb25C72cDC8Df18d7686b1359';
const limits = { minimumDeposit: 10_000n, maxDeposit: 100_000_000n, maxTotal: 1_000_000_000n };
const query = (entries: Record<string, string>) => ({ get: (name: string) => entries[name] ?? null });

describe('the shielded pool deployment', () => {
  it('is recorded for Robinhood Chain with the launch limits', () => {
    const contracts = shieldedContracts();
    expect(contracts).toBeDefined();
    // The third set's pool takes 1 USDG at least, 100 USDG a deposit and 1,000 USDG in all.
    expect(poolLimits(contracts!)).toEqual({ minimumDeposit: 1_000_000n, maxDeposit: 100_000_000n, maxTotal: 1_000_000_000n });
  });
});

describe('deposit limits', () => {
  it('accepts an amount inside every limit', () => {
    expect(depositProblem({ amount: 100_000n, limits, poolBalance: 0n, walletBalance: 170_000n })).toBeUndefined();
    expect(depositProblem({ amount: undefined, limits, poolBalance: 0n, walletBalance: 0n })).toBeUndefined();
  });

  it('names the limit that stops it', () => {
    expect(depositProblem({ amount: 9_999n, limits, poolBalance: 0n, walletBalance: 1n })).toBe('The smallest deposit is 0.01 USDG.');
    expect(depositProblem({ amount: 100_000_001n, limits, poolBalance: 0n, walletBalance: undefined })).toBe('One deposit can be at most 100 USDG.');
    expect(depositProblem({ amount: 60_000_000n, limits, poolBalance: 950_000_000n, walletBalance: undefined })).toBe(
      'The pool holds at most 1000 USDG, so it can take 50 more.',
    );
    expect(depositProblem({ amount: 10_000n, limits, poolBalance: 1_000_000_000n, walletBalance: undefined })).toBe('The pool is full at 1000 USDG.');
    expect(depositProblem({ amount: 200_000n, limits, poolBalance: 0n, walletBalance: 170_000n })).toBe('This wallet holds 0.17 USDG.');
  });
});

/**
 * From v4 the pool holds each wallet to a cap per window. The form refuses above it before the
 * wallet opens, in the pool's own order, and says what the wallet may still put in and when the
 * window resets. A pool with no window answers no room, and the form checks what that pool checks.
 */
describe('what one wallet may still deposit', () => {
  const NOW = new Date('2026-10-01T12:00:00Z');
  const WEEK = 604_800n;
  const room = { room: 50_000_000n, cap: 250_000_000n, window: WEEK, resetsAt: new Date('2026-10-04T12:00:00Z') };

  it('refuses above the room, after the per-deposit cap and before the pool cap', () => {
    expect(depositProblem({ amount: 60_000_000n, limits, poolBalance: 990_000_000n, walletBalance: undefined, room, now: NOW })).toBe(
      'This wallet can put in 50 USDG more: one wallet can put in at most 250 USDG in 7 days. Its window resets in 3d.',
    );
    expect(depositProblem({ amount: 200_000_000n, limits, poolBalance: 0n, walletBalance: undefined, room, now: NOW })).toBe(
      'One deposit can be at most 100 USDG.',
    );
    expect(depositProblem({ amount: 40_000_000n, limits, poolBalance: 990_000_000n, walletBalance: undefined, room, now: NOW })).toBe(
      'The pool holds at most 1000 USDG, so it can take 10 more.',
    );
    expect(depositProblem({ amount: 40_000_000n, limits, poolBalance: 0n, walletBalance: 50_000_000n, room, now: NOW })).toBeUndefined();
  });

  it('says a wallet at its cap has to wait for the window', () => {
    expect(depositProblem({ amount: 1_000_000n, limits, poolBalance: 0n, walletBalance: undefined, room: { ...room, room: 0n }, now: NOW })).toBe(
      'This wallet has put in 250 USDG, the most one wallet can in 7 days. Its window resets in 3d.',
    );
  });

  it('skips the check on a pool that holds nobody to a window', () => {
    expect(depositProblem({ amount: 100_000_000n, limits, poolBalance: 0n, walletBalance: undefined, room: undefined })).toBeUndefined();
  });

  it('tells the wallet its room under the field, and nothing on a pool with no window', () => {
    expect(depositRoomLine(room, NOW)).toBe('This wallet can put in 50 USDG more this window, of 250 USDG in 7 days. Its window resets in 3d.');
    expect(depositRoomLine({ ...room, room: 250_000_000n, resetsAt: null }, NOW)).toBe('This wallet can put in up to 250 USDG in any 7 days.');
    expect(depositRoomLine({ ...room, room: 0n }, NOW)).toBe('This wallet has put in its 250 USDG for this window. Its window resets in 3d.');
    expect(depositRoomLine({ ...room, resetsAt: new Date('2026-10-01T11:00:00Z') }, NOW)).toContain('Its window has just reset.');
    expect(depositRoomLine(undefined)).toBeUndefined();
  });
});

describe('withdrawals', () => {
  it('waits for the association set before anything else', () => {
    expect(withdrawProblem({ amount: 1n, note: { value: 5n }, inSet: false })).toMatch(/waiting for the next association set/);
    expect(withdrawProblem({ amount: 6n, note: { value: 5n }, inSet: true })).toMatch(/holds/);
    expect(withdrawProblem({ amount: 5n, note: { value: 5n }, inSet: true })).toBeUndefined();
  });

  it('computes the relayer fee the way the relay contract does', () => {
    expect(relayFee(50_000n, 0)).toBe(0n);
    expect(relayFee(400_000n, 100)).toBe(4_000n);
    expect(relayFee(3n, 100)).toBe(0n);
  });

  it('proves only against the set the chain holds now', () => {
    expect(setMatchesChain({ root: '42' }, 42n)).toBe(true);
    expect(setMatchesChain({ root: '42' }, 43n)).toBe(false);
    expect(setMatchesChain({ root: '42' }, undefined)).toBe(false);
    expect(setMatchesChain(undefined, 42n)).toBe(false);
    expect(labelInSet({ labels: ['7', '9'] }, 9n)).toBe(true);
    expect(labelInSet({ labels: ['7'] }, 9n)).toBe(false);
  });

  it('sends gas along only to a hidden owner', () => {
    expect(PURPOSES['stealth-owner'].gasDrop).toBe(true);
    expect(PURPOSES.mandate.gasDrop).toBe(false);
    expect(PURPOSES.provider.gasDrop).toBe(false);
  });
});

describe('arriving from another page', () => {
  it('reads the purpose and the recipient, checksummed', () => {
    expect(intentFromQuery(query({ for: 'stealth-owner', to: MANDATE.toLowerCase() }))).toEqual({ purpose: 'stealth-owner', recipient: MANDATE });
    expect(intentFromQuery(query({ for: 'provider' }))).toEqual({ purpose: 'provider', recipient: undefined });
  });

  it('falls back to funding a mandate and drops what is not an address', () => {
    expect(intentFromQuery(query({ for: 'elsewhere', to: '0x1234' }))).toEqual({ purpose: 'mandate', recipient: undefined });
  });

  it('round-trips through the link other pages build', () => {
    const url = new URL(shieldedHref('mandate', MANDATE), 'https://console.example');
    expect(url.pathname).toBe('/console/shielded');
    expect(intentFromQuery(url.searchParams)).toEqual({ purpose: 'mandate', recipient: MANDATE });
  });

  it('keeps /console/shielded off the mandate-address route', () => {
    const consoleRoute = ADDRESS_ROUTES.find((route) => route.prefix === 'console');
    expect(consoleRoute && addressSegment('/console/shielded', consoleRoute)).toBeUndefined();
  });
});

describe('services', () => {
  it('reads the relayer and the set provider from the build environment, blank as unset', () => {
    expect(shieldedServices({ NEXT_PUBLIC_BURSAR_RELAYER_URL: ' https://relay.example ', NEXT_PUBLIC_BURSAR_ASP_URL: '' })).toEqual({
      relayer: 'https://relay.example',
    });
    expect(shieldedServices({})).toEqual({});
  });
});

describe('copy', () => {
  it('states the funding link and the timing caveat plainly', () => {
    for (const line of [STEALTH_LIMIT_LINE, SHIELDED_TIMING_LINE]) {
      expect(line).not.toContain('—');
      expect(line).not.toMatch(/not available yet/);
    }
    expect(STEALTH_LIMIT_LINE).toMatch(/shielded funds/);
    expect(SHIELDED_TIMING_LINE).toMatch(/timing/);
  });

  it('formats USDG without trailing zeros', () => {
    expect(usdgText(100_000_000n)).toBe('100');
    expect(usdgText(50_000n)).toBe('0.05');
    expect(usdgText(0n)).toBe('0');
  });
});

describe('proving files', () => {
  const circuits = fileURLToPath(new URL('../../../circuits/privacy-pools', import.meta.url));

  it('copies the four browser files and checks them against the manifest', () => {
    const target = mkdtempSync(join(tmpdir(), 'shielded-'));
    expect(copyShieldedArtifacts(circuits, target)).toEqual(['withdraw.wasm', 'withdraw.zkey', 'commitment.wasm', 'commitment.zkey']);
    expect(copyShieldedArtifacts(circuits, target)).toEqual([]);
    expect(readFileSync(join(target, 'withdraw.wasm')).length).toBeGreaterThan(0);
  });

  it('refuses a file that differs from the manifest', () => {
    const fake = mkdtempSync(join(tmpdir(), 'shielded-src-'));
    const manifest = JSON.parse(readFileSync(join(circuits, 'manifest.json'), 'utf8'));
    writeFileSync(join(fake, 'manifest.json'), JSON.stringify(manifest));
    mkdirSync(join(fake, 'build'));
    writeFileSync(join(fake, 'build', 'withdraw.wasm'), 'not the circuit');
    expect(() => copyShieldedArtifacts(fake, mkdtempSync(join(tmpdir(), 'shielded-dst-')))).toThrow(/does not match/);
  });
});
