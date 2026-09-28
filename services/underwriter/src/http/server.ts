import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { type ApiRequest, type ApiResponse, bearer, failure, readBody, send, tokenMatches } from './io.js';
import { errorResponse } from './routes.js';
import type { Router } from './routes.js';

/*
 * Adapts node's HTTP server to the router and guards every route with the bearer token.
 *
 * The guard covers health too. This process reads a principal's mandate and takes decisions
 * against it, so there is no route worth answering for a stranger who found the port. A loopback
 * listener runs without a token because the operating system is the boundary there.
 */

export type HttpServerOptions = {
  readonly router: Router;
  readonly host: string;
  readonly authToken: string | null;
  readonly onError?: (error: unknown) => void;
};

export type RunningServer = {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
};

export function createHttpServer(options: HttpServerOptions): Server {
  return createServer((incoming, outgoing) => {
    void (async () => {
      try {
        if (options.authToken && !tokenMatches(bearer(incoming.headers), options.authToken)) {
          send(
            outgoing,
            failure(
              401,
              'unauthorized',
              'Every route on this listener needs the bearer token set in UNDERWRITER_AUTH_TOKEN. Send it as Authorization: Bearer <token>.',
            ),
          );
          return;
        }

        const url = new URL(incoming.url ?? '/', `http://${options.host}`);
        const request: ApiRequest = {
          method: incoming.method ?? 'GET',
          path: url.pathname.replace(/\/+$/, '') || '/',
          query: url.searchParams,
          body: await readBody(incoming),
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
