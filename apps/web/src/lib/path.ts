import { isAddress } from 'viem';

/**
 * Reading a URL that names an address, in one place.
 *
 * The middleware decides the status line before a byte is sent and the route renders the screen
 * afterwards. Both have to agree on what counts as an address, so neither of them holds the rule.
 *
 * Two surfaces put an address in the same position: the console names a mandate account and the
 * provider desk names a payee. A rule that lives on one of them is a rule the other answers 200
 * without.
 */

/** A route whose second segment is an address, with the pages it keeps for itself. */
export type AddressRoute = { readonly prefix: string; readonly reserved: ReadonlySet<string> };

/**
 * `/console/new` is a page of its own and the router prefers it over the dynamic segment. The
 * provider desk has no such page, so nothing is held back from it.
 *
 * `middleware.ts` repeats these prefixes in its matcher, which Next reads statically and cannot
 * take from here. The test pins the two lists to each other.
 */
export const ADDRESS_ROUTES: readonly AddressRoute[] = [
  { prefix: 'console', reserved: new Set(['new']) },
  { prefix: 'providers', reserved: new Set() },
];

/** The text this route puts where an address belongs, or nothing when the URL names none. */
export function addressSegment(pathname: string, route: AddressRoute): string | undefined {
  const parts = pathname.split('/').filter((part) => part !== '');
  if (parts[0] !== route.prefix) return undefined;

  const segment = parts[1];
  if (segment === undefined || route.reserved.has(segment)) return undefined;

  try {
    return decodeURIComponent(segment);
  } catch {
    // A percent sign that decodes to nothing is not an address either, and it is still worth
    // quoting back to whoever pasted it.
    return segment;
  }
}

/** Checksum is not demanded of whoever typed it. It is applied where the address is used. */
export function readsAsAddress(segment: string): boolean {
  return isAddress(segment, { strict: false });
}
