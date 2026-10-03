// What the monitor keeps between runs: the balance of every contract that holds funds, so a run can
// say when one fell. Kept apart from monitor.mjs, which reads the chain as soon as it loads, so the
// rule and the file format can be tested on their own.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// A fall between two runs alerts when it is over both of these: a quarter of the previous figure,
// and 100 whole units of the asset (100 USDG, 100 BRSR, 100 shares). The share catches a drain of
// a large balance; the floor keeps a small balance's ordinary movements quiet.
export const OUTFLOW_ALERT_BPS = 2_500n;
export const OUTFLOW_ALERT_FLOOR_UNITS = 100n;

export const STATE_VERSION = 1;

/** By how much `current` fell from `previous` when the fall is over the threshold, else null. */
export function outflow(previous, current, decimals) {
  if (current >= previous) return null;
  const fall = previous - current;
  const share = (previous * OUTFLOW_ALERT_BPS) / 10_000n;
  const floor = OUTFLOW_ALERT_FLOOR_UNITS * 10n ** BigInt(decimals);
  return fall > (share > floor ? share : floor) ? fall : null;
}

/** The previous run's state, or null when there is none yet. A file that is there but not a state throws. */
export function readState(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not JSON`);
  }
  if (parsed?.version !== STATE_VERSION || typeof parsed.at !== 'string' || typeof parsed.block !== 'string' || !isRecord(parsed.balances)) {
    throw new Error(`${path} is not a monitor state this script writes`);
  }
  for (const [label, balance] of Object.entries(parsed.balances)) {
    if (!isRecord(balance) || typeof balance.value !== 'string' || !/^\d+$/.test(balance.value) || !Number.isInteger(balance.decimals) || typeof balance.symbol !== 'string') {
      throw new Error(`${path}: the balance of ${label} is not an amount`);
    }
  }
  return parsed;
}

/** Written whole to a sibling and renamed into place, so a run cut short leaves the previous state. */
export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const sibling = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(sibling, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(sibling, path);
  } catch (error) {
    rmSync(sibling, { force: true });
    throw error;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
