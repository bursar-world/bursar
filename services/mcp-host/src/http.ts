import { createServer as createNodeServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { isBursarError } from '@bursar/core';
import { createServer as createMcpServer } from '@bursar/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getAddress, isAddress } from 'viem';

import type { ConnectionService } from './connections.js';
import { TOKEN_PATTERN } from './crypto.js';
import { ProofError, readConnectRequest, readDisconnectRequest } from './proof.js';
import { createRateLimiter } from './rate-limit.js';
import { DuplicateProofError } from './store.js';

/**
 * The listener.
 *
 * Five things answer here: the two probes, the connection routes the console calls, and the MCP
 * endpoint itself, reached with a bearer token or with the token in the path. Every request is
 * answered by one MCP server built for that request and dropped with it, bound to the one mandate
 * the token names. There is no session, so any instance can answer any request.
 */

const MAX_BODY_BYTES = 64 * 1_024;
const MAX_MCP_BODY_BYTES = 256 * 1_024;
const HEADERS_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 120_000;
const KEEP_ALIVE_TIMEOUT_MS = 10_000;

export type HttpOptions = {
  readonly service: ConnectionService;
  readonly chainId: number;
  readonly publicUrl: string;
  readonly tokenRpm: number;
  readonly health: () => Promise<Record<string, unknown>>;
  readonly ready: () => Promise<{ ready: boolean; checks: Record<string, unknown> }>;
  readonly log: (line: string) => void;
};

type Reply = { readonly status: number; readonly body: unknown; readonly headers?: Record<string, string> };

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

export function createHttpServer(options: HttpOptions): Server {
  const tokens = createRateLimiter(options.tokenRpm, 60_000);
  // Opening a connection costs a signature check and two chain reads, so a stranger hammering the
  // route is bounded per address on top of the per-owner count the service keeps.
  const openers = createRateLimiter(30, 60_000);

  const server = createNodeServer((incoming, outgoing) => {
    void handle(incoming, outgoing).catch((error: unknown) => {
      const reply = errorReply(error);
      if (reply.status >= 500) options.log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!outgoing.headersSent) send(outgoing, reply);
      else outgoing.destroy();
    });
  });

  async function handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const url = new URL(incoming.url ?? '/', `http://${options.publicUrl.replace(/^https?:\/\//u, '')}`);
    const path = url.pathname.replace(/\/+$/u, '') || '/';
    const method = incoming.method ?? 'GET';

    if (path === '/healthz' && method === 'GET') return send(outgoing, { status: 200, body: await options.health() });
    if (path === '/readyz' && method === 'GET') {
      const readiness = await options.ready();
      return send(outgoing, { status: readiness.ready ? 200 : 503, body: { ready: readiness.ready, ...readiness.checks } });
    }

    const mcp = /^\/mcp(?:\/([^/]+))?$/u.exec(path);
    if (mcp) return serveMcp(incoming, outgoing, mcp[1], method);

    if (path === '/connections' && method === 'POST') {
      if (!openers.take(peer(incoming))) throw new RequestError(429, 'rate_limited', 'Too many connection requests from this address. Try again in a minute.');
      const created = await options.service.create(readConnectRequest(await readJson(incoming)));
      options.log(`connection ${created.connection.id} opened on mandate ${created.connection.mandate} as agent ${created.connection.agent}`);
      return send(outgoing, { status: 201, body: created });
    }

    if (path === '/connections' && method === 'GET') {
      const mandate = url.searchParams.get('mandate') ?? '';
      if (!isAddress(mandate, { strict: false })) throw new RequestError(400, 'bad_request', 'mandate is a 0x address.');
      return send(outgoing, { status: 200, body: { connections: await options.service.list(getAddress(mandate)) } });
    }

    const revoke = /^\/connections\/([0-9a-f-]{36})\/revoke$/u.exec(path);
    if (revoke && method === 'POST') {
      const body = await readJson(incoming);
      const request = readDisconnectRequest({ ...(typeof body === 'object' && body !== null ? body : {}), connection: revoke[1] });
      const revoked = await options.service.revoke(request);
      options.log(`connection ${revoked.id} revoked`);
      return send(outgoing, { status: 200, body: { connection: revoked } });
    }

    throw new RequestError(404, 'not_found', `Nothing answers at ${method} ${path}.`);
  }

  async function serveMcp(incoming: IncomingMessage, outgoing: ServerResponse, inPath: string | undefined, method: string): Promise<void> {
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') throw new RequestError(405, 'method_not_allowed', 'The MCP endpoint takes POST, GET and DELETE.');

    const token = inPath ?? bearer(incoming);
    if (token === null) {
      return send(outgoing, {
        status: 401,
        body: { error: 'unauthorized', detail: 'Send the connection token as Authorization: Bearer <token>, or in the path the console gave you.' },
        headers: { 'www-authenticate': 'Bearer realm="bursar-mcp"' },
      });
    }
    if (!TOKEN_PATTERN.test(token)) throw new RequestError(401, 'unauthorized', 'This token opens no connection.');

    const answer = await options.service.answer(token);
    if (!answer.ok) {
      const status = answer.code === 'key_unreadable' ? 503 : 401;
      return send(outgoing, { status, body: { error: answer.code, detail: answer.message } });
    }

    if (!tokens.take(answer.connection.id)) {
      const retry = tokens.retryAfter(answer.connection.id);
      return send(outgoing, {
        status: 429,
        body: { error: 'rate_limited', detail: `This connection may make ${options.tokenRpm} requests a minute. Try again in ${retry} seconds.` },
        headers: { 'retry-after': String(retry) },
      });
    }

    // Stateless on purpose: one server per request, nothing kept between requests except the
    // opened context. A GET then has no stream to offer and the transport answers 405.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_MCP_BODY_BYTES,
    });
    const mcp = createMcpServer(answer.context);
    outgoing.on('close', () => {
      void mcp.close().catch(() => undefined);
    });
    await mcp.connect(transport);
    await transport.handleRequest(incoming, outgoing);
  }

  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  return server;
}

export type RunningServer = { readonly server: Server; readonly port: number; close(): Promise<void> };

export function listen(server: Server, host: string, port: number): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const address = server.address() as AddressInfo;
      resolve({
        server,
        port: address.port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeIdleConnections();
          }),
      });
    });
  });
}

function peer(incoming: IncomingMessage): string {
  const forwarded = incoming.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || incoming.socket.remoteAddress || 'unknown';
}

function bearer(incoming: IncomingMessage): string | null {
  const raw = incoming.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.toLowerCase().startsWith('bearer ')) return null;
  return value.slice(7).trim();
}

async function readJson(incoming: IncomingMessage): Promise<unknown> {
  const declared = Number(incoming.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new RequestError(413, 'body_too_large', `The request body is limited to ${MAX_BODY_BYTES} bytes.`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of incoming) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      incoming.pause();
      throw new RequestError(413, 'body_too_large', `The request body is limited to ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) return {};
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new RequestError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

function send(response: ServerResponse, reply: Reply): void {
  const payload = JSON.stringify(reply.body ?? {}, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
  response.writeHead(reply.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store', ...reply.headers });
  response.end(payload);
}

function errorReply(error: unknown): Reply {
  if (error instanceof RequestError) return { status: error.status, body: { error: error.code, detail: error.message } };
  if (error instanceof ProofError) return { status: error.status, body: { error: error.code, detail: error.message } };
  if (error instanceof DuplicateProofError) return { status: 409, body: { error: 'proof_reused', detail: error.message } };
  if (error instanceof URIError) return { status: 400, body: { error: 'path_invalid', detail: 'The request path is not valid percent-encoding.' } };
  // The mcp package's own refusals: an address that is not a mandate, a record mismatch.
  if (isBursarError(error)) return { status: error.code === 'no_mandate_account' || error.code === 'config_mismatch' ? 400 : 409, body: { error: error.code, detail: error.message } };
  return { status: 500, body: { error: 'internal_error' } };
}
