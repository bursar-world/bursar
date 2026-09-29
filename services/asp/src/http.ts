import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import type { PublishedSet } from './set.js';

/**
 * Every set this process has published, by CID. With a directory the sets survive a restart, so
 * a CID posted on chain keeps resolving; without one a restart recomputes the current set and
 * serves it once its root matches the chain again.
 */
export class SetStore {
  private readonly byCid = new Map<string, PublishedSet>();

  constructor(private readonly dir: string | null) {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const set = JSON.parse(readFileSync(join(dir, file), 'utf8')) as PublishedSet;
      this.byCid.set(set.cid, set);
    }
  }

  put(set: PublishedSet): void {
    if (this.byCid.has(set.cid)) return;
    this.byCid.set(set.cid, set);
    if (this.dir) writeFileSync(join(this.dir, `${set.cid}.json`), `${JSON.stringify(set, null, 2)}\n`);
  }

  byRoot(root: string): PublishedSet | undefined {
    let found: PublishedSet | undefined;
    for (const set of this.byCid.values()) {
      if (set.root === root && (!found || BigInt(set.throughBlock) > BigInt(found.throughBlock))) found = set;
    }
    return found;
  }

  get(cid: string): PublishedSet | undefined {
    return this.byCid.get(cid);
  }
}

type Reply = { readonly status: number; readonly body: unknown };

export type AspView = {
  readonly store: SetStore;
  /** The root the Entrypoint holds, or null before the first post. */
  readonly chainRoot: () => Promise<bigint | null>;
  readonly health: () => unknown;
};

export async function handle(view: AspView, method: string, path: string): Promise<Reply> {
  if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed', detail: 'This service only answers GET.' } };
  if (path === '/health') return { status: 200, body: view.health() };
  if (path === '/v1/association-set') {
    const root = await view.chainRoot();
    if (root === null) return { status: 404, body: { error: 'no_root', detail: 'No association set has been posted yet.' } };
    const set = view.store.byRoot(root.toString());
    if (!set) {
      return {
        status: 503,
        body: { error: 'set_unknown', detail: 'The posted root is not one this service has computed yet. Try again shortly.' },
      };
    }
    return { status: 200, body: set };
  }
  const match = /^\/v1\/association-set\/(b[a-z2-7]{20,100})$/.exec(path);
  if (match) {
    const set = view.store.get(match[1]!);
    return set
      ? { status: 200, body: set }
      : { status: 404, body: { error: 'not_found', detail: 'No set with that CID was published here.' } };
  }
  return { status: 404, body: { error: 'not_found', detail: 'Unknown path.' } };
}

export function serve(view: AspView, port: number): Server {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://asp');
    handle(view, request.method ?? 'GET', url.pathname)
      .catch((error: unknown) => ({
        status: 500,
        body: { error: 'internal', detail: error instanceof Error ? error.message : String(error) },
      }))
      .then(({ status, body }) => {
        response.writeHead(status, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'cache-control': status === 200 ? 'public, max-age=15' : 'no-store',
        });
        response.end(JSON.stringify(body));
      });
  });
  server.listen(port);
  return server;
}
