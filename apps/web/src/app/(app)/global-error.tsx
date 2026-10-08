'use client';

import { Button } from '@/components/button';

import './globals.css';

/**
 * The last boundary: the root layout itself failed, so the header, the wallet and every provider
 * are gone with it and this file renders the document on its own. It keeps to the product's own
 * type and colour and to one control, because whatever broke is upstream of everything else here.
 */
export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-3 px-6">
          <p className="text-xl font-semibold tracking-[-1.3px]">BURSAR</p>
          <h1 className="page-title">The console did not load</h1>
          <p className="text-detail text-[color:var(--color-muted)]">
            This is a problem in the browser. Your mandates, balances and limits are held by contracts on Robinhood
            Chain and are unaffected.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button tone="primary" onClick={reset}>
              Load it again
            </Button>
            <a href="/status" className="text-detail underline underline-offset-2">
              Current conditions
            </a>
          </div>
          {error.digest && (
            <p className="pt-2 text-note text-[color:var(--color-muted)]">
              Support reference <span className="tabular">{error.digest}</span>
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
