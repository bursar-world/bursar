import { IndexUnavailable } from './explorer';

/**
 * What a screen is allowed to say about the list underneath it.
 *
 * A read in flight and a read that failed both produce an empty array, and neither of them is an
 * empty account. This is the whole defect the console kept shipping: a surface that branches on
 * `rows.length` turns a network fault into a statement about what a mandate permits. Every list
 * here reads its state from one of these instead.
 */

export type Reading = {
  /**
   * `refused` is a read that arrived and was turned down for a reason the refuser stated, which
   * is the fourth thing and not a worse kind of `unreadable`. The network index charges for the
   * settlement history and answers HTTP 402 to a deployment holding no key: the request came
   * back, it came back quickly, and waiting does nothing for it. Rendered as "the request did not
   * come back" it sends a reader after an outage that is not happening and never reaches the one
   * person who can clear it.
   */
  readonly state: 'loading' | 'unreadable' | 'refused' | 'read';
  /** Carried so the surface can show what went wrong. Null unless the read failed. */
  readonly error: unknown;
};

const LOADING: Reading = { state: 'loading', error: null };
const READ: Reading = { state: 'read', error: null };

export function readingOf(loaded: boolean, error: unknown): Reading {
  if (error !== null && error !== undefined) {
    return { state: refusalOf(error) === undefined ? 'unreadable' : 'refused', error };
  }
  return loaded ? READ : LOADING;
}

/**
 * The stated refusal behind a failed read, where there is one.
 *
 * A status is what tells the two apart: the index answered and named its own reason. A fetch that
 * never completed, a response the browser would not hand over and a body that is not the history
 * all arrive without one, and those stay unreadable.
 */
export function refusalOf(error: unknown): IndexUnavailable | undefined {
  return error instanceof IndexUnavailable && error.status !== undefined ? error : undefined;
}

/**
 * A list assembled from two sources is only as read as the weaker of them.
 *
 * An unknown failure outranks a stated one: it is the reading that supports the least, so it is
 * the one the surface has to answer for.
 */
export function weaker(a: Reading, b: Reading): Reading {
  if (a.state === 'unreadable') return a;
  if (b.state === 'unreadable') return b;
  if (a.state === 'refused') return a;
  if (b.state === 'refused') return b;
  return a.state === 'loading' ? a : b;
}

/**
 * The five things a list can be. `empty` is reachable only from a reading that landed, which is the
 * point: nothing else may render as "nobody is allowed".
 */
export type ListState = 'loading' | 'unreadable' | 'refused' | 'empty' | 'filled';

export function listState(reading: Reading, rows: number): ListState {
  if (reading.state === 'unreadable') return 'unreadable';
  if (reading.state === 'refused') return 'refused';
  if (reading.state === 'loading') return 'loading';
  return rows === 0 ? 'empty' : 'filled';
}
