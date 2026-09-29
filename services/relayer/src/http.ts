import { createServer, type IncomingMessage, type Server } from 'node:http';

import { RelayRefusal, type Relayer } from './relay.js';

export const MAX_BODY_BYTES = 64 * 1_024;

type Reply = { readonly status: number; readonly body: unknown };

export async function handle(relayer: Relayer, method: string, path: string, body: () => Promise<unknown>, health: () => Promise<unknown>): Promise<Reply> {
  if (method === 'GET' && path === '/health') return { status: 200, body: await health() };
  if (method === 'GET' && path === '/v1/quote') return { status: 200, body: relayer.quote() };
  if (method === 'POST' && path === '/v1/relay') {
    try {
      return { status: 200, body: await relayer.relay(await body()) };
    } catch (error) {
      if (error instanceof RelayRefusal) return { status: error.status, body: { error: error.code, detail: error.message } };
      throw error;
    }
  }
  return { status: 404, body: { error: 'not_found', detail: 'Unknown path.' } };
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RelayRefusal(413, 'too_large', 'The request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new RelayRefusal(400, 'bad_json', 'The body is not JSON.'));
      }
    });
    request.on('error', reject);
  });
}

export function serve(relayer: Relayer, port: number, health: () => Promise<unknown>): Server {
  const server = createServer((request, response) => {
    const headers = {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    const url = new URL(request.url ?? '/', 'http://relayer');
    handle(relayer, request.method ?? 'GET', url.pathname, () => readJson(request), health)
      .catch((error: unknown) =>
        error instanceof RelayRefusal
          ? { status: error.status, body: { error: error.code, detail: error.message } }
          : { status: 500, body: { error: 'internal', detail: error instanceof Error ? error.message : String(error) } },
      )
      .then(({ status, body }) => {
        response.writeHead(status, headers);
        response.end(JSON.stringify(body));
      });
  });
  server.listen(port);
  return server;
}
