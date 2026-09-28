import { describe, expect, it } from 'vitest';

import { IndexUnavailable } from '@/app/(app)/console/lib/explorer';
import { listState, readingOf, refusalOf, weaker } from '@/app/(app)/console/lib/reading';

/**
 * Loading, unreadable, refused and empty are four answers.
 *
 * Every list in this console comes back as an array, and a request in flight, a request that failed,
 * a request that was turned down and an account that has allowed nobody all produce the same empty
 * one. Collapsing them is how a network fault ends up rendered as "this mandate pays nobody".
 */
describe('readingOf', () => {
  it('separates the read that has not landed from the read that failed', () => {
    expect(readingOf(false, null).state).toBe('loading');
    expect(readingOf(true, null).state).toBe('read');
    expect(readingOf(true, new Error('index down')).state).toBe('unreadable');
  });

  it('lets a failure outrank a read still in flight', () => {
    expect(readingOf(false, new Error('index down')).state).toBe('unreadable');
  });

  it('carries the failure so a surface can show what went wrong', () => {
    const error = new Error('index down');
    expect(readingOf(true, error).error).toBe(error);
    expect(readingOf(true, null).error).toBeNull();
  });
});

describe('weaker', () => {
  const loading = readingOf(false, null);
  const read = readingOf(true, null);
  const failed = readingOf(true, new Error('chain down'));

  it('takes the failure over anything else', () => {
    expect(weaker(read, failed).state).toBe('unreadable');
    expect(weaker(failed, read).state).toBe('unreadable');
    expect(weaker(loading, failed).state).toBe('unreadable');
  });

  it('takes the read still in flight over the one that landed', () => {
    expect(weaker(read, loading).state).toBe('loading');
    expect(weaker(loading, read).state).toBe('loading');
  });

  it('calls a list read only when both sources answered', () => {
    expect(weaker(read, read).state).toBe('read');
  });
});

describe('listState', () => {
  const loading = readingOf(false, null);
  const read = readingOf(true, null);
  const failed = readingOf(true, new Error('chain down'));

  it('never calls a failed read an empty result', () => {
    expect(listState(failed, 0)).toBe('unreadable');
    expect(listState(failed, 3)).toBe('unreadable');
  });

  it('never calls a read in flight an empty result', () => {
    expect(listState(loading, 0)).toBe('loading');
  });

  it('reaches empty only from a reading that landed', () => {
    expect(listState(read, 0)).toBe('empty');
    expect(listState(read, 1)).toBe('filled');
  });

  it('answers four distinct things for four distinct inputs', () => {
    const answers = [listState(loading, 0), listState(failed, 0), listState(read, 0), listState(read, 2)];
    expect(new Set(answers).size).toBe(4);
  });
});

/**
 * A read that was refused, kept apart from a read that failed.
 *
 * The network index charges for the settlement history and answers HTTP 402 to a deployment
 * holding no key. That read arrived, it arrived fast, and no amount of waiting changes it. Folded
 * into "unreadable" it becomes an outage nobody is having, sends the reader to press a control
 * that cannot help, and never names the person who can clear it.
 */
describe('a refused read', () => {
  const refused = new IndexUnavailable(
    'unkeyed',
    'api.blockscout.com',
    'api.blockscout.com charges for the index and this deployment holds no key, so it answered HTTP 402.',
    'BURSAR sets BLOCKSCOUT_API_KEY on the server.',
    402,
  );

  /** Nothing answered at all, so there is no status and nothing to name. */
  const silent = new IndexUnavailable(
    'unreachable',
    'api.blockscout.com',
    'Nothing answered at api.blockscout.com.',
    'Check the network this browser is on.',
  );

  it('is its own state, not a worse kind of unreadable', () => {
    expect(readingOf(true, refused).state).toBe('refused');
    expect(readingOf(true, silent).state).toBe('unreadable');
    expect(readingOf(true, new Error('index down')).state).toBe('unreadable');
  });

  it('is offered to the surface with the refuser’s own words attached', () => {
    expect(refusalOf(refused)).toBe(refused);
    expect(refusalOf(refused)?.condition).toContain('402');
    expect(refusalOf(silent)).toBeUndefined();
    expect(refusalOf(new Error('index down'))).toBeUndefined();
  });

  it('never renders as an empty list', () => {
    expect(listState(readingOf(true, refused), 0)).toBe('refused');
    expect(listState(readingOf(true, refused), 4)).toBe('refused');
  });

  it('loses to a read that failed for no stated reason, which supports less', () => {
    const stated = readingOf(true, refused);
    const unknown = readingOf(true, silent);
    expect(weaker(stated, unknown).state).toBe('unreadable');
    expect(weaker(unknown, stated).state).toBe('unreadable');
  });

  it('outranks a read still in flight and a read that landed', () => {
    const stated = readingOf(true, refused);
    expect(weaker(stated, readingOf(false, null)).state).toBe('refused');
    expect(weaker(readingOf(true, null), stated).state).toBe('refused');
  });

  it('keeps all five answers distinct', () => {
    const answers = [
      listState(readingOf(false, null), 0),
      listState(readingOf(true, silent), 0),
      listState(readingOf(true, refused), 0),
      listState(readingOf(true, null), 0),
      listState(readingOf(true, null), 2),
    ];
    expect(new Set(answers).size).toBe(5);
  });
});
