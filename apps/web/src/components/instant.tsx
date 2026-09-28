'use client';

import { useEffect, useState } from 'react';
import { formatInstant, formatRelative } from '../lib/time';

/**
 * A time the reader can trust.
 *
 * The server has no idea what zone the reader is in, so it renders the ISO form and the browser
 * swaps in the local reading after mount. Formatting on the server instead produces a hydration
 * mismatch, and React resolves those by keeping the server's answer, which is the wrong one.
 */
export function Instant({ at, relative = false }: { readonly at: Date | null | undefined; readonly relative?: boolean }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!at) return <NotSet />;
  if (!mounted) return <Utc at={at} />;

  return (
    <time dateTime={at.toISOString()} title={at.toISOString()}>
      {relative ? formatRelative(at) : formatInstant(at)}
    </time>
  );
}

/**
 * Ticks. For a countdown to a window rolling, where a static string goes wrong within a minute.
 *
 * The same mounted guard as `Instant`, for the same reason and one more: a relative string
 * rendered on the server is already stale by the time it reaches the browser, so hydrating against
 * it mismatches on every countdown on the page until the first tick a second later.
 */
export function Countdown({ to }: { readonly to: Date | null | undefined }) {
  const [mounted, setMounted] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    setMounted(true);
    const timer = setInterval(() => tick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  if (!to) return <NotSet />;
  if (!mounted) return <Utc at={to} />;

  return (
    <time dateTime={to.toISOString()} title={to.toISOString()}>
      {formatRelative(to)}
    </time>
  );
}

function NotSet() {
  return <span className="text-[color:var(--color-muted)]">Not set</span>;
}

/** What the server can say about a moment without knowing the reader's zone or the current time. */
function Utc({ at }: { readonly at: Date }) {
  return <time dateTime={at.toISOString()}>{at.toISOString().replace('T', ' ').slice(0, 16)}Z</time>;
}
