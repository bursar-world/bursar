'use client';

import Link from 'next/link';

import { ErrorSurface } from '@/components/error-surface';

/**
 * The boundary every route under /app falls back to.
 *
 * A read that throws during render used to reach Next's own screen, which is unstyled, says
 * nothing about this product and offers no way back. The failure is rendered here the same way
 * every other failure in the console is, because a reader cannot tell the difference between a
 * page that crashed and a network that went away, and the error itself usually can.
 */
export default function AppError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-4 py-8">
      <ErrorSurface error={error} heading="This page did not load" onRetry={reset} retryLabel="Load it again">
        {error.digest && (
          <p className="mt-2 text-note text-[color:var(--color-muted)]">
            Support reference <span className="tabular">{error.digest}</span>
          </p>
        )}
      </ErrorSurface>

      <p className="text-detail text-[color:var(--color-muted)]">
        If it fails again,{' '}
        <Link href="/status" className="underline underline-offset-2">
          current conditions
        </Link>{' '}
        reports whether the chain is reachable from here, and{' '}
        <Link href="/console" className="underline underline-offset-2">
          the console
        </Link>{' '}
        is still reachable on its own.
      </p>
    </div>
  );
}
