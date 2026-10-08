import { listState, readingOf, weaker } from '@/app/(app)/console/lib/reading';
import type { ListState, Reading } from '@/app/(app)/console/lib/reading';

import type { ResolverDesk } from './desk';

/**
 * What this desk is allowed to say about the panel underneath it.
 *
 * A read in flight, a read that failed, and a registry with no open dispute all produce an empty
 * array. On a screen whose whole job is telling a resolver what is due, collapsing them is the
 * defect: a rate-limited endpoint would render as "nothing needs you today", and the resolver who
 * believed it is slashed for silence on a dispute that was there all along.
 */

const COUNT_UNREAD = 'Could not read how many disputes exist, so the list below may be incomplete.';

const RULES_UNREAD =
  'Could not read the voting rules, so the list below may be incomplete.';

export function deskReading(desk: ResolverDesk | undefined, error: unknown): Reading {
  return readingOf(desk !== undefined, error);
}

/**
 * The list is only as read as the two calls behind it.
 *
 * The count of disputes and the voting configuration each fail on their own. Without the count
 * there is nothing to walk; without the windows and the quorum every dispute falls to an unknown
 * phase and drops out of the open list, which is a clear bench built from a failed read.
 */
export function disputeReading(desk: ResolverDesk | undefined, error: unknown): Reading {
  const landed = deskReading(desk, error);
  if (desk === undefined) return landed;

  return weaker(
    weaker(landed, readingOf(desk.disputesReadable, desk.disputesReadable ? null : new Error(COUNT_UNREAD))),
    readingOf(desk.config !== undefined, desk.config === undefined ? new Error(RULES_UNREAD) : null),
  );
}

export function disputeListState(desk: ResolverDesk | undefined, error: unknown): ListState {
  return listState(disputeReading(desk, error), desk?.open.length ?? 0);
}

/**
 * Counting rows only where the rows mean something.
 *
 * A headline figure is read faster than the list under it and is believed harder, so it takes the
 * same test: no count is offered from a reading that could not place a dispute in a phase.
 */
export function countable(desk: ResolverDesk | undefined): boolean {
  return desk !== undefined && desk.disputesReadable && desk.config !== undefined;
}

export function countOpen(
  desk: ResolverDesk | undefined,
  predicate: (row: ResolverDesk['open'][number]) => boolean = () => true,
): number | undefined {
  return countable(desk) && desk !== undefined ? desk.open.filter(predicate).length : undefined;
}

export type { ListState, Reading };
