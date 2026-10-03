/**
 * One of several processes drawing on the same ledger at once. Spawned by ledger.test.ts with the
 * file, the cap and how many draws of one micro-USDG to attempt; prints how many were recorded and
 * how many the cap refused.
 */
import { createSpendLedger } from '../src/ledger.js';

const [path, cap, draws] = process.argv.slice(2);
if (path === undefined || cap === undefined || draws === undefined) throw new Error('usage: ledger-worker <path> <cap> <draws>');

const ledger = createSpendLedger(path);
let drawn = 0;
let refused = 0;
for (let i = 0; i < Number(draws); i++) {
  try {
    ledger.draw(1n, BigInt(cap));
    drawn++;
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'shielded_daily_cap') throw error;
    refused++;
  }
}
process.stdout.write(`${JSON.stringify({ drawn, refused })}\n`);
