import Link from 'next/link';

import { EmptyState } from '@/components/layout';

/** Long enough to recognise what was pasted, short enough not to run off the card. */
const QUOTE_LIMIT = 64;

/**
 * A desk URL that names something the escrow could never pay.
 *
 * The page is here and the chain is reading fine. What failed is the address in the URL, so that is
 * what the message names.
 */
export function UnreadablePayee({ typed }: { readonly typed: string }) {
  return (
    <EmptyState
      title="The address in this URL is not an address."
      action={
        <Link href="/providers" className="text-detail underline underline-offset-2">
          Open a desk by address
        </Link>
      }
    >
      <span className="tabular break-all">{quote(typed)}</span> sits where a payee address belongs, and an address is 42
      characters beginning 0x. Check what you pasted, or open the provider surface and type it there.
    </EmptyState>
  );
}

function quote(text: string): string {
  const shown = text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}…` : text;
  return `“${shown}”`;
}
