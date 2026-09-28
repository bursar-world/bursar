import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Countdown, Instant } from '@/components/instant';

/**
 * A countdown rendered on the server has to say something the browser will still agree with.
 *
 * `formatRelative` answers from the current time, so a server that renders "in 4m" is already
 * wrong by the time the HTML lands, and React resolves a hydration mismatch by keeping the
 * server's answer. Countdowns run on four surfaces now, so every one of them would have held a
 * stale string until the first tick. The server renders the moment itself instead, in UTC, and
 * the browser swaps in the count after mount.
 */
const WHEN = new Date('2026-09-23T15:30:00.000Z');

describe('what the server sends for a time', () => {
  it('sends a countdown as the moment, not as a count that is already stale', () => {
    const markup = renderToStaticMarkup(<Countdown to={WHEN} />);

    expect(markup).toContain('2026-09-23 15:30Z');
    expect(markup).not.toMatch(/\bin \d/u);
    expect(markup).not.toContain('ago');
  });

  it('sends an instant the same way, which is the pattern the countdown now shares', () => {
    expect(renderToStaticMarkup(<Instant at={WHEN} />)).toContain('2026-09-23 15:30Z');
    expect(renderToStaticMarkup(<Instant at={WHEN} relative />)).toContain('2026-09-23 15:30Z');
  });

  it('carries the machine-readable moment either way, so the markup is never ambiguous', () => {
    expect(renderToStaticMarkup(<Countdown to={WHEN} />)).toMatch(/datetime="2026-09-23T15:30:00\.000Z"/iu);
  });

  it('says a time was never set rather than counting down to nothing', () => {
    expect(renderToStaticMarkup(<Countdown to={null} />)).toContain('Not set');
    expect(renderToStaticMarkup(<Instant at={undefined} />)).toContain('Not set');
  });
});
