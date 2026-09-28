import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The README and the router, held to the same list.
 *
 * `GET /config` and `GET /supported` were the only discovery this service had, and neither of them
 * names a route. A newcomer had thirty of them to find by reading the source. The table is the fix,
 * and a table that falls behind the router is worse than none, so both are read here from the thing
 * that defines them: the patterns in the route table, and the paths in the document.
 */

const ROUTES = fileURLToPath(new URL('../src/http/routes.ts', import.meta.url));
const README = fileURLToPath(new URL('../README.md', import.meta.url));

/** `/^\/accounts\/([^/]+)\/status$/` is the same route as `POST /accounts/:agentId/status`. */
function fromPattern(source: string): string[] {
  const declared = [...source.matchAll(/method: '([A-Z]+)',\s*\n\s*pattern: \/\^(.+?)\$\//g)];
  return declared.map(([, method, pattern]) => {
    const path = (pattern ?? '')
      .replace(/\(\[\^\/\]\+\)/g, ':')
      .replace(/\\\//g, '/');
    return `${method ?? ''} ${path}`;
  });
}

/** Every `METHOD /path` the README writes in backticks, with parameter names taken out. */
function fromReadme(document: string): Set<string> {
  const written = [...document.matchAll(/`([A-Z]+) (\/[^`]*)`/g)];
  return new Set(written.map(([, method, path]) => `${method ?? ''} ${(path ?? '').replace(/:[A-Za-z]+/g, ':')}`));
}

describe('the route table in the README', () => {
  it('names every route the router answers', async () => {
    const [source, document] = await Promise.all([readFile(ROUTES, 'utf8'), readFile(README, 'utf8')]);

    const answered = fromPattern(source);
    const documented = fromReadme(document);

    expect(answered.length).toBeGreaterThan(25);
    for (const route of answered) expect(documented, `${route} is not in the README`).toContain(route);
  });

  it('lets every route be reached ahead of the patterns before it', async () => {
    const source = await readFile(ROUTES, 'utf8');
    const declared = [...source.matchAll(/method: '([A-Z]+)',\s*\n\s*pattern: \/(.+?)\/,/g)].map(
      ([, method, pattern]) => ({ method: method ?? '', pattern: new RegExp(pattern ?? '') }),
    );
    expect(declared.length).toBeGreaterThan(25);

    // A sample path for each route, with every parameter filled by a word no fixed segment uses.
    // The first route of the same method to match it is the one the router dispatches to.
    for (const [index, route] of declared.entries()) {
      const sample = route.pattern.source
        .replace(/^\^|\$$/g, '')
        .replace(/\(\[\^\/\]\+\)/g, 'sample')
        .replace(/\\\//g, '/');
      const first = declared.findIndex((other) => other.method === route.method && other.pattern.test(sample));
      expect(first, `${route.method} ${sample} is answered by an earlier route`).toBe(index);
    }
  });

  it('puts the two routes nothing works without before the one that needs them', async () => {
    const document = await readFile(README, 'utf8');
    const table = document.slice(document.indexOf('## Routes'));

    // `POST /underwrite` answers 404 until an account and a pool exist, and nothing said so.
    expect(table.indexOf('| `POST /accounts`')).toBeLessThan(table.indexOf('| `POST /underwrite`'));
    expect(table.indexOf('| `POST /pools`')).toBeLessThan(table.indexOf('| `POST /underwrite`'));
    expect(table).toContain('answers `account_not_found` or `pool_not_found` until they do');
  });
});
