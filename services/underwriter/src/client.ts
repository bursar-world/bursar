import { toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';

import { ChainUnavailableError, RequestError } from './errors.js';
import type { SpendDecision, SpendQuoteView, UnderwriterLookup, UnderwriterPort } from './service.js';

/*
 * The underwriter over HTTP, behind the same lookup the facilitator uses in process, so the two
 * deployments differ by one environment variable and nothing else. Amounts cross as decimal strings and are read back as
 * bigints here: JSON has one number type and it is a double, and a spending limit silently rounded
 * in transit is the failure this system exists to prevent.
 *
 * A request this client cannot complete raises. There is no default answer to "can this agent
 * spend": an underwriter that cannot be reached has not permitted anything, and the route above
 * turns that into a refusal.
 */

export type UnderwriterClientOptions = {
  readonly baseUrl: string;
  readonly token?: string | undefined;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export function createUnderwriterClient(options: UnderwriterClientOptions): UnderwriterLookup {
  const base = options.baseUrl.replace(/\/+$/, '');
  const call = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const request = async (path: string, init: RequestInit): Promise<{ status: number; body: unknown }> => {
    const abort = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await call(`${base}${path}`, {
        ...init,
        signal: abort,
        headers: {
          'content-type': 'application/json',
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
      });
    } catch (cause) {
      throw new ChainUnavailableError(`the underwriter at ${base} did not answer`, { path }, cause);
    }

    const text = await response.text();
    let body: unknown = {};
    if (text !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new ChainUnavailableError(`the underwriter at ${base} answered ${response.status} with something that is not JSON`, {
          path,
          status: response.status,
        });
      }
    }
    return { status: response.status, body };
  };

  return async (agentId: string): Promise<UnderwriterPort | null> => {
    const found = await request(`/v1/mandates/${encodeURIComponent(agentId)}`, { method: 'GET' });
    if (found.status === 404) return null;
    if (found.status !== 200) throw remoteFailure(base, found);

    const mandate = record(found.body);
    const account = string(mandate, 'account');

    return {
      account,
      async authorize(spend) {
        const answered = await request('/v1/underwrite', {
          method: 'POST',
          body: JSON.stringify({
            subject: spend.subject,
            requestId: spend.requestId,
            action: spend.action,
            amountMicro: spend.amountMicros.toString(10),
            at: spend.at,
            ...(spend.merchant === undefined ? {} : { merchant: spend.merchant }),
            ...(spend.capabilityId === undefined ? {} : { capabilityId: spend.capabilityId }),
            ...(spend.merchantProof === undefined ? {} : { merchantProof: spend.merchantProof }),
          }),
        });

        if (answered.status !== 200) throw remoteFailure(base, answered);

        const body = record(answered.body);
        return {
          decision: decision(body['decision']),
          quote: quote(body['quote']),
          idempotent: body['idempotent'] === true,
        };
      },
    };
  };
}

/**
 * Asks a remote underwriter whether it can take a decision now.
 *
 * The facilitator's own readiness answers for its dependencies, and its source of spend decisions
 * is one of them. A facilitator reporting itself ready while the process that decides every spend
 * is refusing them is the same lie this probe exists to stop telling.
 */
export function createUnderwriterProbe(
  options: UnderwriterClientOptions,
): () => Promise<{ ready: boolean } & Record<string, unknown>> {
  const base = options.baseUrl.replace(/\/+$/, '');
  const call = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async () => {
    let response: Response;
    try {
      response = await call(`${base}/readyz`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
      });
    } catch (cause) {
      return {
        ready: false,
        reachable: false,
        detail: `the underwriter at ${base} did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }

    const text = await response.text();
    let body: unknown = {};
    try {
      if (text !== '') body = JSON.parse(text) as unknown;
    } catch {
      return { ready: false, reachable: true, detail: `the underwriter at ${base} answered ${response.status} with something that is not JSON` };
    }

    const reported = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    return { ...reported, ready: response.status === 200 && reported['ready'] === true, reachable: true };
  };
}

function remoteFailure(base: string, answer: { status: number; body: unknown }): Error {
  const body = answer.body as { error?: unknown; detail?: unknown } | null;
  const code = typeof body?.error === 'string' ? body.error : 'unknown_error';
  const detail = typeof body?.detail === 'string' ? `: ${body.detail}` : '';
  return new RequestError(`the underwriter at ${base} answered ${answer.status} ${code}${detail}`, {
    status: answer.status,
    code,
  });
}

function decision(raw: unknown): SpendDecision {
  const body = record(raw);
  switch (body['decision']) {
    case 'allow':
      return { decision: 'allow' };
    case 'hold':
      return { decision: 'hold', threshold_micros: money(body['threshold_micros']) };
    case 'refuse':
      return { decision: 'refuse', reason: string(body, 'reason') };
    default:
      throw new RequestError(`the underwriter answered with an unrecognised decision "${String(body['decision'])}"`);
  }
}

function quote(raw: unknown): SpendQuoteView | null {
  if (raw === null || raw === undefined) return null;
  const body = record(raw);
  const headroom = body['headroom'];

  return {
    decision: decision(body['decision']),
    bucket: typeof body['bucket'] === 'string' ? body['bucket'] : null,
    documentHash: string(body, 'documentHash'),
    accountVersion: body['accountVersion'] === null || body['accountVersion'] === undefined ? null : BigInt(String(body['accountVersion'])),
    headroom:
      headroom === null || headroom === undefined
        ? null
        : {
            perCall: money(record(headroom)['perCall']),
            daily: money(record(headroom)['daily']),
            monthly: money(record(headroom)['monthly']),
            balance: money(record(headroom)['balance']),
          },
  };
}

function record(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RequestError('the underwriter answered with something that is not an object');
  }
  return raw as Record<string, unknown>;
}

function string(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') {
    throw new RequestError(`the underwriter's answer has no ${field}`, { field });
  }
  return value;
}

function money(raw: unknown): Micro {
  if (typeof raw !== 'string' && typeof raw !== 'bigint') {
    throw new RequestError('an amount in the underwriter\'s answer is not an atomic micro-USD string', {
      value: String(raw),
    });
  }
  return toMicro(raw);
}
