import { describe, expect, it } from 'vitest';

import { bufferSentence, parkableOf } from '@/app/(app)/console/[mandate]/park-panel';
import { SHIELDED_TIMING_LINE, STEALTH_LIMIT_LINE } from '@/chain/stealth';
import { switchRefusal } from '@/wallet/switch-network';

describe('parking under a buffer', () => {
  it('parks only what sits above the buffer, plus what already waits in the vault', () => {
    expect(parkableOf(79_952n, 0n, 100_000n)).toBe(0n);
    expect(parkableOf(79_952n, 0n, 50_000n)).toBe(29_952n);
    expect(parkableOf(0n, 5_000n, 100_000n)).toBe(5_000n);
  });

  it('explains the refusal before anyone presses a button, with both ways out', () => {
    const line = bufferSentence(79_952n, 100_000n);
    expect(line).toContain('$0.10');
    expect(line).toContain('$0.08');
    expect(line).toMatch(/holds more or the buffer is lowered/);
  });
});

describe('switching networks', () => {
  it('names a declined switch instead of doing nothing', () => {
    expect(switchRefusal({ code: 4001 })).toMatch(/stayed on its current network, so nothing was sent/);
    expect(switchRefusal(new Error('Unrecognized chain ID'))).toMatch(/could not switch/);
  });
});

describe('privacy copy', () => {
  it('states the single-depositor limit and makes no unlinkability claim', () => {
    expect(SHIELDED_TIMING_LINE).toMatch(/only depositor/);
    expect(STEALTH_LIMIT_LINE).toMatch(/only depositor/);
    for (const line of [SHIELDED_TIMING_LINE, STEALTH_LIMIT_LINE]) {
      expect(line).not.toMatch(/no on-chain link|nothing on chain that points back|cannot tell/i);
    }
  });
});
