import { describe, expect, it } from 'vitest';
import { MAX_SETTLEMENT_CALLS, RECEIPT_WAIT_MS } from '@bursar/x402';
import { SHUTDOWN_DEADLINE_MS } from '../src/main.js';
import { SETTLE_WORST_CASE_MS } from '../src/x402/facilitator.js';

/**
 * Shutdown against the longest settle.
 *
 * The deadline was twenty seconds while a settle could wait sixty on one receipt, so a deploy
 * killed settles mid-wait with their transfers already broadcast.
 */
describe('the shutdown deadline', () => {
  it('outlasts every receipt wait a settle can be in', () => {
    expect(SETTLE_WORST_CASE_MS).toBeGreaterThan(MAX_SETTLEMENT_CALLS * RECEIPT_WAIT_MS);
    expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThan(SETTLE_WORST_CASE_MS);
  });
});
