import { toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';

import { ConfigError } from './errors.js';

export type PricedRoute = {
  /** An HTTP method, or `*` for every method. */
  readonly method: string;
  /** A pathname, or a prefix ending in `*`. */
  readonly path: string;
  readonly amount: Micro;
};

export type PriceTable = {
  readonly routes: readonly PricedRoute[];
  match(method: string, pathname: string): PricedRoute | undefined;
};

const ENTRY = /^(\*|[A-Za-z]+)\s+(\/\S*)\s*=\s*([0-9]+(?:\.[0-9]{1,6})?)$/;

/**
 * The price list, from one variable.
 *
 * `BURSAR_PRICES` holds `METHOD /path=price` entries separated by commas or newlines, prices in
 * USDG with up to six decimals: `POST /render=0.01, GET /quote=0.001`. `*` as the method prices
 * every method, and a path ending in `*` prices everything under it. The first entry that matches
 * a request wins, so list the specific paths before the prefixes.
 */
export function readPrices(source: string): PriceTable {
  const routes = source
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(parseEntry);

  if (routes.length === 0) {
    throw new ConfigError('BURSAR_PRICES names no route. Example: POST /render=0.01');
  }

  return {
    routes,
    match(method, pathname) {
      const upper = method.toUpperCase();
      return routes.find((route) => (route.method === '*' || route.method === upper) && pathMatches(route.path, pathname));
    },
  };
}

function parseEntry(entry: string): PricedRoute {
  const found = ENTRY.exec(entry);
  if (!found) {
    throw new ConfigError(`BURSAR_PRICES entry "${entry}" is not METHOD /path=price. Example: POST /render=0.01`);
  }
  const [, method, path, price] = found as unknown as [string, string, string, string];
  const amount = toMicro(usdToMicro(price));
  if (amount <= 0n) throw new ConfigError(`BURSAR_PRICES entry "${entry}" prices the route at nothing.`);
  return { method: method.toUpperCase(), path, amount };
}

function usdToMicro(price: string): string {
  const [whole, fraction = ''] = price.split('.');
  return `${whole}${fraction.padEnd(6, '0')}`.replace(/^0+(?=\d)/, '');
}

function pathMatches(pattern: string, pathname: string): boolean {
  if (pattern.endsWith('*')) return pathname.startsWith(pattern.slice(0, -1));
  return pathname === pattern || (pattern.endsWith('/') ? pathname === pattern.slice(0, -1) : pathname === `${pattern}/`);
}
