import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { ADDRESS_ROUTES, addressSegment, readsAsAddress, unknownPage } from '@/lib/path';
import type { AddressRoute } from '@/lib/path';
import { config, middleware } from '@/middleware';

/**
 * A URL whose address does not parse answers not found, on the console and on the provider desk.
 *
 * It used to answer 200 and say the page did not exist. Both halves were wrong: the page is there,
 * the address in the URL is what could not be read, and a 200 tells a crawler, a monitor and a
 * status check that the reader found what they asked for.
 */
const REAL = '0x03fEbcEC31155466637d9958d4d15A1671E53a9D';

function route(prefix: string): AddressRoute {
  const found = ADDRESS_ROUTES.find((entry) => entry.prefix === prefix);
  if (!found) throw new Error(`${prefix} is not an address route`);
  return found;
}

const CONSOLE = route('console');
const PROVIDERS = route('providers');

function statusOf(path: string): number {
  return middleware(new NextRequest(new URL(path, 'https://mandate.example'))).status;
}

describe('addressSegment', () => {
  it('reads the text a URL puts where a mandate belongs', () => {
    expect(addressSegment('/console/not-an-address', CONSOLE)).toBe('not-an-address');
    expect(addressSegment(`/console/${REAL}`, CONSOLE)).toBe(REAL);
    expect(addressSegment(`/console/${REAL}/settlements`, CONSOLE)).toBe(REAL);
  });

  it('reads a payee the same way', () => {
    expect(addressSegment('/providers/not-an-address', PROVIDERS)).toBe('not-an-address');
    expect(addressSegment(`/providers/${REAL}`, PROVIDERS)).toBe(REAL);
  });

  it('leaves a surface’s own pages alone', () => {
    expect(addressSegment('/console', CONSOLE)).toBeUndefined();
    expect(addressSegment('/console/', CONSOLE)).toBeUndefined();
    expect(addressSegment('/console/new', CONSOLE)).toBeUndefined();
    expect(addressSegment('/status', CONSOLE)).toBeUndefined();
    expect(addressSegment('/providers', PROVIDERS)).toBeUndefined();
  });

  it('answers nothing for a route it was not asked about', () => {
    expect(addressSegment('/console/not-an-address', PROVIDERS)).toBeUndefined();
    expect(addressSegment('/providers/not-an-address', CONSOLE)).toBeUndefined();
  });

  it('quotes back what was typed, percent-encoded or not', () => {
    expect(addressSegment('/console/0x%20nope', CONSOLE)).toBe('0x nope');
  });
});

describe('readsAsAddress', () => {
  it('accepts an address in any case, because the checksum is applied where it is used', () => {
    expect(readsAsAddress(REAL)).toBe(true);
    expect(readsAsAddress(REAL.toLowerCase())).toBe(true);
  });

  it('refuses anything that is not one', () => {
    expect(readsAsAddress('not-an-address')).toBe(false);
    expect(readsAsAddress('0x1234')).toBe(false);
    expect(readsAsAddress(`${REAL}00`)).toBe(false);
  });
});

describe('the address middleware', () => {
  it('answers not found for an address that does not parse', () => {
    expect(statusOf('/console/not-an-address')).toBe(404);
    expect(statusOf('/console/not-an-address/approvals')).toBe(404);
    expect(statusOf('/providers/not-an-address')).toBe(404);
  });

  it('leaves a real mandate, the list and the create page alone', () => {
    expect(statusOf(`/console/${REAL}`)).toBe(200);
    expect(statusOf(`/console/${REAL}/settlements`)).toBe(200);
    expect(statusOf('/console')).toBe(200);
    expect(statusOf('/console/new')).toBe(200);
  });

  it('leaves a real payee and the provider surface alone', () => {
    expect(statusOf(`/providers/${REAL}`)).toBe(200);
    expect(statusOf('/providers')).toBe(200);
  });

  it('keeps the URL, so the page still knows what was typed', () => {
    const response = middleware(new NextRequest(new URL('/providers/not-an-address', 'https://mandate.example')));
    expect(response.headers.get('x-middleware-rewrite')).toContain('/providers/not-an-address');
  });

  it('runs on every route that names an address, and nowhere else', () => {
    expect(config.matcher.slice(0, ADDRESS_ROUTES.length)).toEqual(ADDRESS_ROUTES.map((entry) => `/${entry.prefix}/:path*`));
  });

  it('answers 404 for a first segment no page claims, and leaves every page alone', () => {
    expect(unknownPage('/does-not-exist')).toBe(true);
    expect(unknownPage('/console/nope/deeper')).toBe(false);
    for (const page of ['/', '/status', '/workspace/drafts/x', '/docs/haircuts', '/governance', '/demo/relay-funding', '/demo/assistants']) expect(unknownPage(page)).toBe(false);
  });
});

describe('the screen behind the refusal', () => {
  const screen = readFileSync(new URL('../src/app/(app)/console/[mandate]/unreadable-address.tsx', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('../src/app/(app)/console/[mandate]/layout.tsx', import.meta.url), 'utf8');
  const payee = readFileSync(new URL('../src/app/(app)/providers/[payee]/page.tsx', import.meta.url), 'utf8');

  it('reads a payee by that same rule, rather than a second copy of it', () => {
    expect(payee).toContain('readsAsAddress');
    expect(payee).not.toContain('isAddress');
  });

  it('blames the address, never the page', () => {
    expect(screen).toContain('This link does not contain a valid address.');
    expect(screen).toContain('is not a mandate address');
  });

  it('does not tell a reader the page is gone', () => {
    expect(screen).not.toContain('That page does not exist');
  });

  /**
   * The router's own boundary answers with the router's own sentence, and the one it has says the
   * page does not exist. Rendering the screen in the layout is what keeps the two halves of this
   * refusal agreeing with each other.
   */
  it('renders the screen itself and never hands the refusal to the router', () => {
    expect(layout).toContain('return <UnreadableAddress');
    expect(layout).not.toContain("from 'next/navigation'");
  });

  it('reads the address by the same rule the middleware does', () => {
    expect(layout).toContain('readsAsAddress');
  });
});
