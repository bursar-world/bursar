import { EnvError, BursarError } from '@bursar/core';
import type { EnvSource } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { reportStartupFailure } from '../src/refusal.js';

type Record_ = Record<string, unknown>;

function capture(): { records: Record_[]; logger: ReturnType<typeof createLogger> } {
  const records: Record_[] = [];

  return { records, logger: createLogger((line) => records.push(JSON.parse(line) as Record_)) };
}

/** Whatever `loadConfig` rejects for this environment, reported the way the process reports it. */
function refuse(source: EnvSource): Record_[] {
  const { records, logger } = capture();

  try {
    loadConfig(source);
  } catch (error) {
    reportStartupFailure(logger, error);
    return records;
  }

  throw new Error('loadConfig accepted an unusable environment');
}

describe('the refusal an operator reads', () => {
  /** The command the README prints: a key, an API base, and nothing else. */
  const DOCUMENTED: EnvSource = { PAYEE_PRIVATE_KEY: `0x${'1a'.repeat(32)}`, API_BASE: 'https://api.internal' };

  it('names every missing variable instead of stopping at the colon', () => {
    const records = refuse(DOCUMENTED);
    const named = records.filter((record) => record.event === 'config_problem').map((record) => record.variable);

    expect(named).toContain('RHC_RPC_PRIMARY');
  });

  it('names all of them at once, so one restart fixes the lot', () => {
    const named = refuse({}).filter((record) => record.event === 'config_problem').map((record) => record.variable);

    expect(named).toContain('PAYEE_PRIVATE_KEY');
    expect(named).toContain('API_BASE');
    expect(named).toContain('RHC_RPC_PRIMARY');
  });

  it('gives each one its reason and the format it expected', () => {
    const [problem] = refuse({}).filter((record) => record.event === 'config_problem');

    expect(problem).toMatchObject({ level: 'error', event: 'config_problem' });
    expect(typeof problem?.variable).toBe('string');
    expect(typeof problem?.reason).toBe('string');
    expect((problem?.expected as string).length).toBeGreaterThan(0);
  });

  it('leads with the condition, its code and how many things are wrong', () => {
    const records = refuse({});
    const fatal = records[0];

    expect(fatal).toMatchObject({ level: 'error', event: 'fatal', reason: 'Configuration is not usable', code: 'env_invalid' });
    expect(fatal?.problems).toBe(records.filter((record) => record.event === 'config_problem').length);
    expect(fatal?.problems as number).toBeGreaterThan(1);
  });

  it('never echoes the private key, whatever it did with it', () => {
    const key = `0x${'ab'.repeat(32)}`;
    const records = refuse({ PAYEE_PRIVATE_KEY: key, API_BASE: 'not-a-url' });

    expect(JSON.stringify(records)).not.toContain(key);
  });

  it('holds nothing back to a field limit', () => {
    const records = refuse({});
    for (const record of records) {
      expect(JSON.stringify(record)).not.toContain('…');
    }
  });
});

describe('a failure that is not about configuration', () => {
  it('keeps the code when the error carries one', () => {
    const { records, logger } = capture();
    reportStartupFailure(logger, new BursarError('rpc_unreachable', 'Neither endpoint answered.'));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: 'fatal', reason: 'Neither endpoint answered.', code: 'rpc_unreachable' });
  });

  it('drops the request a message carries behind it and keeps what was decoded', () => {
    const { records, logger } = capture();
    reportStartupFailure(
      logger,
      new Error('Execution reverted.\nRequest body: {"method":"eth_call"}\nDetails: insufficient funds'),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.reason).toBe('Execution reverted.; Details: insufficient funds');
  });

  it('reports a configuration refusal as more than one line', () => {
    const { records, logger } = capture();
    reportStartupFailure(logger, new EnvError([{ name: 'API_BASE', reason: 'is not set', expected: 'an https url' }]));

    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ variable: 'API_BASE', reason: 'is not set', expected: 'an https url' });
  });
});
