import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isLoopback } from '../config.js';
import type { ApiRequest, ApiResponse } from './io.js';
import { bearer, failure, readBody, send, tokenMatches } from './io.js';
import { errorResponse, routeClass } from './routes.js';
import type { Router } from './routes.js';

/**
 * Adapts node's HTTP server to the router, and guards every route with one of two bearer tokens.
 *
 * The provider token opens the x402 surface and the probes, health included: this service
 * broadcasts transactions and reads a principal's balances, so there is no route here worth
 * answering for a stranger who found the port. The admin token opens the ledger, and only it does;
 * a provider that can settle must not be able to fund an account or mark a batch paid. A loopback
 * listener with neither token runs open, because the operating system is the boundary there. Once
 * a provider token is set the listener is taken to be reachable, and the ledger stays shut until an
 * admin token is set too.
 */

export type HttpServerOptions = {
  readonly router: Router;
  readonly host: string;
  readonly port: number;
  readonly authToken: string | null;
  readonly adminToken: string | null;
  readonly onError?: (error: unknown) => void;
};

function refusal(options: HttpServerOptions, path: string, presented: string | null): ApiResponse | null {
  const kind = routeClass(path);
  if (kind === 'public') return null;
  if (kind === 'provider') {
    if (options.authToken === null || tokenMatches(presented, options.authToken)) return null;
    return failure(
      401,
      'unauthorized',
      'This route needs the bearer token set in FACILITATOR_AUTH_TOKEN. Send it as Authorization: Bearer <token>.',
    );
  }
  if (options.adminToken === null) {
    if (options.authToken === null && isLoopback(options.host)) return null;
    return failure(
      403,
      'admin_token_unset',
      'The ledger routes need FACILITATOR_ADMIN_TOKEN, which this deployment has not set. Set it, then send it as Authorization: Bearer <token>.',
    );
  }
  if (tokenMatches(presented, options.adminToken)) return null;
  return failure(
    401,
    'unauthorized',
    'The ledger routes need the bearer token set in FACILITATOR_ADMIN_TOKEN. Send it as Authorization: Bearer <token>.',
  );
}

/**
 * What a connection is allowed to hold, and for how long.
 *
 * Node's own defaults let a request take five minutes and a socket sit idle for five seconds past
 * its last byte, which is long enough that a handful of connections that never finish their headers
 * hold the listener open against everything else.
 *
 * `requestTimeout` bounds receiving the request, headers and body, from the client. It does not
 * bound the handler, so a `/settle` waiting on a receipt after its body has arrived is unaffected
 * by it; that wait is bounded by the scheme. Two minutes is generous for a body capped at
 * `MAX_BODY_BYTES` and short enough that a client trickling one in cannot hold a socket for long.
 */
const HEADERS_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 120_000;
const KEEP_ALIVE_TIMEOUT_MS = 10_000;

export type RunningServer = {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
};

export function createHttpServer(options: HttpServerOptions): Server {
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const url = new URL(incoming.url ?? '/', `http://${options.host}`);
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const refused = refusal(options, path, bearer(incoming.headers));
        if (refused) {
          send(outgoing, refused);
          return;
        }

        const { body, bytes } = await readBody(incoming);
        const request: ApiRequest = {
          method: incoming.method ?? 'GET',
          path,
          query: url.searchParams,
          headers: incoming.headers,
          body,
          bytes,
        };

        send(outgoing, await options.router(request));
      } catch (error) {
        const result: ApiResponse = errorResponse(error);
        if (result.status >= 500) options.onError?.(error);
        if (!outgoing.headersSent) send(outgoing, result);
        else outgoing.destroy();
      }
    })();
  });

  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  return server;
}

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
            // Idle keep-alive sockets would otherwise hold the close open for their full timeout.
            server.closeIdleConnections();
          }),
      });
    });
  });
}
