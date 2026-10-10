import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { Request as MfRequest, Response as MfResponse } from 'miniflare';

import { decodeBase64Json, encodeBase64Json } from '../src/x402.js';

/**
 * The worker runs on workerd, the runtime Cloudflare deploys to, with its outbound fetch handed
 * to the test. The facilitator and the chain are stand-ins answering from here, so a test can say
 * what each answered and read what the worker sent them.
 */
export type Outbound = (request: MfRequest) => Promise<MfResponse | Response>;

let bundled: string | undefined;

export async function bundle(): Promise<string> {
  if (bundled) return bundled;
  const result = await build({
    entryPoints: [new URL('./worker.ts', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['browser', 'module', 'main'],
    external: ['node:*', 'cloudflare:*'],
    logLevel: 'silent',
  });
  bundled = result.outputFiles[0]!.text;
  return bundled;
}

export async function worker(bindings: Record<string, string>, outbound: Outbound): Promise<Miniflare> {
  return new Miniflare({
    modulesRoot: '/',
    modules: [{ type: 'ESModule', path: '/worker.mjs', contents: await bundle() }],
    compatibilityDate: '2025-09-01',
    compatibilityFlags: ['nodejs_compat'],
    bindings,
    outboundService: outbound as never,
  });
}

export const PROVIDER = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374';
export const MANDATE = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c';
export const ESCROW = '0x1111111111111111111111111111111111111111';
export const LOCK_TX = `0x${'ab'.repeat(32)}`;
export const INPUT_COMMIT = `0x${'cd'.repeat(32)}`;

export const ENV = {
  BURSAR_PROVIDER: PROVIDER,
  BURSAR_CAPABILITY: 'service:render:1',
  BURSAR_PRICES: 'POST /render=0.01, POST /fail=0.01',
  BURSAR_FACILITATOR_URL: 'https://facilitator.test',
  BURSAR_FACILITATOR_TOKEN: 'token-under-test',
};

export type Offer = Record<string, unknown>;

export async function offerOf(response: Response | MfResponse, scheme: string): Promise<Offer> {
  const header = response.headers.get('payment-required');
  if (!header) throw new Error('no payment-required header');
  const decoded = decodeBase64Json(header) as { accepts: Offer[] };
  const offer = decoded.accepts.find((entry) => entry['scheme'] === scheme);
  if (!offer) throw new Error(`no ${scheme} offer`);
  return offer;
}

export function escrowPayment(accepted: Offer, requestHash: string, over: Record<string, unknown> = {}): string {
  return encodeBase64Json({
    x402Version: 2,
    accepted,
    payload: {
      lock: { escrow: ESCROW, id: '7', mandate: MANDATE, transaction: LOCK_TX, inputCommit: INPUT_COMMIT },
      binding: { requestHash, salt: `0x${'ef'.repeat(32)}` },
    },
    ...over,
  });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type FacilitatorScript = {
  verify: (body: Record<string, unknown>, call: number) => Record<string, unknown>;
  settle?: (body: Record<string, unknown>) => Record<string, unknown>;
};

/** A facilitator that answers from a script and keeps what it was asked. */
export function facilitatorStub(script: FacilitatorScript) {
  const calls: { path: string; body: Record<string, unknown>; authorization: string | null }[] = [];
  let verifies = 0;
  const handle: Outbound = async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'facilitator.test') return new Response('unexpected host', { status: 599 });
    const body = (await request.json()) as Record<string, unknown>;
    calls.push({ path: url.pathname, body, authorization: request.headers.get('authorization') });
    if (url.pathname === '/verify') return Response.json(script.verify(body, verifies++));
    if (url.pathname === '/settle') {
      return Response.json(script.settle ? script.settle(body) : { success: true, transaction: LOCK_TX, network: 'eip155:4663', payer: MANDATE });
    }
    return new Response('not found', { status: 404 });
  };
  return { calls, handle };
}

export const VALID = { isValid: true, payer: MANDATE, method: 'escrow', amount: '10000' };
