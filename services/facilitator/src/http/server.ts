import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApiRequest, ApiResponse } from './io.js';
import { bearer, failure, readBody, send, tokenMatches } from './io.js';
import { errorResponse } from './routes.js';
import type { Router } from './routes.js';

/**
 * Adapts node's HTTP server to the router, and guards every route with the bearer token.
 *
 * The guard covers health as well. This service broadcasts transactions and reads a principal's
 * balances, so there is no route here worth answering for a stranger who found the port. A
 * loopback listener runs without a token because the operating system is the boundary there.
 */

export type HttpServerOptions = {
  readonly router: Router;
  readonly host: string;
  readonly port: number;
  readonly authToken: string | null;
  readonly onError?: (error: unknown) => void;
};

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
        if (options.authToken && !tokenMatches(bearer(incoming.headers), options.authToken)) {
          send(
            outgoing,
            failure(
              401,
              'unauthorized',
              'Every route on this listener needs the bearer token set in FACILITATOR_AUTH_TOKEN. Send it as Authorization: Bearer <token>.',
            ),
          );
          return;
        }

        const url = new URL(incoming.url ?? '/', `http://${options.host}`);
        const { body, bytes } = await readBody(incoming);
        const request: ApiRequest = {
          method: incoming.method ?? 'GET',
          path: url.pathname.replace(/\/+$/, '') || '/',
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
