import Link from 'next/link';

import { EmptyState } from '@/components/layout';

/** Long enough to recognise what was pasted, short enough not to run off the card. */
const QUOTE_LIMIT = 64;

/**
 * A console URL that names a mandate this console cannot read.
 *
 * The page is here and the console is working. What failed is the address in the URL, so that is
 * what the message names: a reader who mistyped one thing should not be told the product is gone.
 * The status line is set in middleware, before the response starts, because a 404 raised while
 * the page is already streaming cannot correct the 200 that went out ahead of it.
 */
export function UnreadableAddress({ typed }: { readonly typed: string }) {
  return (
    <EmptyState
      title="The address in this URL is not an address."
      action={
        <Link href="/console" className="text-detail underline underline-offset-2">
          Open the console
        </Link>
      }
    >
      <span className="tabular break-all">{quote(typed)}</span> sits where the console expects a mandate account, and an
      account address is 42 characters beginning 0x. The page is here and reading fine. Check the address you pasted, or
      open the console to list the mandates a wallet owns.
    </EmptyState>
  );
}

function quote(text: string): string {
  const shown = text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}…` : text;
  return `“${shown}”`;
}
