import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { ADDRESS_ROUTES, addressSegment, readsAsAddress, unknownPage } from './lib/path';

/**
 * The status line for a URL whose address cannot be read.
 *
 * `notFound()` inside the route renders the right screen and cannot correct the status: the root
 * layout reads request headers, so the response has begun streaming by the time the address is
 * parsed and a 200 has already gone out with it. The decision is taken here instead, before
 * anything is sent. The rewrite keeps the same URL, so the page underneath is the one the router
 * would have chosen anyway and the reader still sees the address they typed.
 *
 * Both the console and the provider desk name an address this way, and both are covered.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (unknownPage(pathname)) return NextResponse.rewrite(request.nextUrl, { status: 404 });

  for (const route of ADDRESS_ROUTES) {
    const segment = addressSegment(pathname, route);
    if (segment !== undefined && !readsAsAddress(segment)) {
      return NextResponse.rewrite(request.nextUrl, { status: 404 });
    }
  }

  return NextResponse.next();
}

/**
 * Next reads this statically, so the prefixes in `ADDRESS_ROUTES` are written out again here. The
 * last entry is every other page path: not the framework's files, the API or a file with an
 * extension.
 */
export const config = { matcher: ['/console/:path*', '/providers/:path*', '/((?!_next/|api/|console|providers)[^.]+)'] };
