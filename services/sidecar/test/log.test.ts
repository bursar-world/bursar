import { describe, expect, it } from 'vitest';

import { createLogger, describeError } from '../src/log.js';

function capture(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];

  return { lines, logger: createLogger((line) => lines.push(line)) };
}

describe('createLogger', () => {
  it('writes one json object per line with the level, the event and the time', () => {
    const { lines, logger } = capture();

    logger.info('released', { id: 7n, hash: '0xabc', published: true, outputBytes: 42 });

    const record = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(record).toMatchObject({
      level: 'info',
      event: 'released',
      id: '7',
      hash: '0xabc',
      published: true,
      outputBytes: 42,
    });
    expect(Date.parse(String(record['time']))).not.toBeNaN();
  });

  it('emits only the fields the call site passed', () => {
    const { lines, logger } = capture();

    logger.warn('gas_low');

    expect(Object.keys(JSON.parse(lines[0] ?? '') as object).sort()).toEqual(['event', 'level', 'time']);
  });

  it('clips a runaway field so one bad rpc answer cannot flood the log', () => {
    const { lines, logger } = capture();

    logger.error('release_failed', { reason: 'x'.repeat(5_000) });

    const reason = String((JSON.parse(lines[0] ?? '') as Record<string, unknown>)['reason']);
    expect(reason).toHaveLength(513);
    expect(reason.endsWith('…')).toBe(true);
  });
});

describe('describeError', () => {
  it('keeps the message and drops the stack', () => {
    expect(describeError(new Error('execution reverted: TooEarly'))).toBe('execution reverted: TooEarly');
  });

  /**
   * The headline is the same sentence for every revert the escrow raises. Kept alone, `TooEarly`,
   * `BadStatus` and `NotPayee` read identically in the log and whoever is on call cannot tell them
   * apart.
   */
  it('keeps the decoded revert viem puts on a later line', () => {
    const message = ['The contract function "finalizeRelease" reverted.', '', 'Error: TooEarly()', '  at ...'].join('\n');

    expect(describeError(new Error(message))).toBe('The contract function "finalizeRelease" reverted.; Error: TooEarly()');
  });

  it('two reverts of the same call are not the same line', () => {
    const revert = (custom: string): string =>
      ['The contract function "release" reverted.', '', `Error: ${custom}`, 'Contract Call:', '  address: 0x44'].join('\n');

    expect(describeError(new Error(revert('BadStatus()')))).not.toBe(describeError(new Error(revert('NotPayee()'))));
  });

  it('leaves the request viem writes out behind it out of the log', () => {
    const message = [
      'The contract function "release" reverted.',
      '',
      'Error: BadStatus()',
      '',
      'Contract Call:',
      '  address:   0x4444444444444444444444444444444444444444',
      '  function:  release(uint256 id, bytes32 outputCommit, string outputURI)',
      '',
      'Docs: https://viem.sh/docs/contract/writeContract',
      'Version: viem@2.56.3',
    ].join('\n');

    expect(describeError(new Error(message))).toBe('The contract function "release" reverted.; Error: BadStatus()');
  });

  it('describes a thrown value that is not an error', () => {
    expect(describeError('rpc down')).toBe('rpc down');
  });
});
