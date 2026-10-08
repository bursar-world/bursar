import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { IndexUnavailable } from '@/app/(app)/console/lib/explorer';
import { GateEmpty } from '@/app/(app)/console/lib/gate-empty';
import { listState, readingOf } from '@/app/(app)/console/lib/reading';
import type { GateSubject } from '@/app/(app)/console/lib/gate-empty';

/**
 * Four states, four renderings.
 *
 * The gate tables are the only published account of what an agent may buy and who it may be paid.
 * A read that failed rendering as an empty list turns a network fault into a permission claim, so
 * this asserts on the sentences themselves, never on the branch that picks them.
 */
function render(subject: GateSubject, state: ReturnType<typeof listState>): string {
  return renderToStaticMarkup(<GateEmpty state={state} subject={subject} onRetry={() => undefined} />);
}

const LOADING = listState(readingOf(false, null), 0);
const UNREADABLE = listState(readingOf(true, new Error('index down')), 0);
const EMPTY = listState(readingOf(true, null), 0);
const FILLED = listState(readingOf(true, null), 2);

describe.each<GateSubject>(['payees', 'capabilities'])('the %s table with no rows', (subject) => {
  it('renders three different things for three different conditions', () => {
    const shown = [render(subject, LOADING), render(subject, UNREADABLE), render(subject, EMPTY)];
    expect(new Set(shown).size).toBe(3);
  });

  it('never claims nothing is allowed when the read failed', () => {
    const unreadable = render(subject, UNREADABLE);
    expect(unreadable).toContain('could not be loaded');
    expect(unreadable).toContain('The mandate still refuses');
    expect(unreadable).not.toMatch(/No (payees|kinds of work)/);
  });

  it('offers the read again where the read is what failed, and nowhere else', () => {
    expect(render(subject, UNREADABLE)).toContain('Read again');
    expect(render(subject, LOADING)).not.toContain('Read again');
    expect(render(subject, EMPTY)).not.toContain('Read again');
  });

  it('names the wait while a reading is in flight', () => {
    expect(render(subject, LOADING)).toContain('Loading');
  });

  it('renders nothing at all once there are rows to show', () => {
    expect(render(subject, FILLED)).toBe('');
  });
});

describe('the sentences name their own subject', () => {
  it('does not offer one list the other list’s account of itself', () => {
    expect(render('payees', EMPTY)).toContain('cannot pay anyone');
    expect(render('capabilities', EMPTY)).toContain('every payment is refused');
    expect(render('payees', EMPTY)).not.toContain('every payment is refused');
  });
});

/**
 * A read the index turned down, said as that.
 *
 * Both gate tables were blaming a request that "did not come back" for a 402 the index answered
 * immediately, twenty lines above the same page's own correct account of it. The panel has to
 * name the refusal, keep the claim about the contract, and stay distinct from the three states
 * that were already here.
 */
describe('a gate table the index refused', () => {
  const refusal = new IndexUnavailable(
    'unkeyed',
    'api.blockscout.com',
    'The history is not available on this console yet.',
    'Balances and limits come from the contracts and are unaffected.',
    402,
    'api.blockscout.com charges for the index and answered HTTP 402. Set BLOCKSCOUT_API_KEY on the server that serves this app.',
  );

  const REFUSED = listState(readingOf(true, refusal), 0);

  function refused(subject: GateSubject): string {
    return renderToStaticMarkup(
      <GateEmpty state={REFUSED} subject={subject} refusal={refusal} onRetry={() => undefined} />,
    );
  }

  it.each<GateSubject>(['payees', 'capabilities'])('names the refusal rather than a network fault, for %s', (subject) => {
    const shown = refused(subject);
    expect(shown).toContain('The history is not available on this console yet.');
    expect(shown).not.toContain('did not come back');
  });

  it.each<GateSubject>(['payees', 'capabilities'])('still refuses to call the list empty, for %s', (subject) => {
    const shown = refused(subject);
    expect(shown).toContain('The mandate still refuses');
    expect(shown).not.toMatch(/No (payees|kinds of work)/);
  });

  it('keeps the server setting off the reader\'s screen', () => {
    expect(refused('payees')).not.toContain('BLOCKSCOUT_API_KEY');
    expect(refused('payees')).not.toContain('HTTP 402');
  });

  it('is a fifth rendering, not a repeat of one of the four', () => {
    const shown = [
      render('payees', LOADING),
      render('payees', UNREADABLE),
      render('payees', EMPTY),
      render('payees', FILLED),
      refused('payees'),
    ];
    expect(new Set(shown).size).toBe(5);
  });

  it('falls back to the plain failure when there is no refusal to name', () => {
    const shown = renderToStaticMarkup(<GateEmpty state={REFUSED} subject="payees" onRetry={() => undefined} />);
    expect(shown).toContain('could not be loaded');
    expect(shown).not.toMatch(/No (payees|kinds of work)/);
  });
});
