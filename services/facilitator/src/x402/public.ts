import { FACILITATOR_REASON } from './contract.js';
import type { Facilitator, FacilitatorSettleResponse, FacilitatorVerifyResponse } from './facilitator.js';
import { readRequest } from './facilitator.js';
import { failure, ok } from '../http/io.js';
import type { ApiRequest, ApiResponse } from '../http/io.js';

/**
 * The keyless surface: the standard `exact` scheme at `/x402/supported`, `/x402/verify` and
 * `/x402/settle`, answering in the shapes the reference implementation's clients parse.
 *
 * Behind it is a second `Facilitator` over the scheme's standard profile, sharing the provider
 * routes' budget, ledger and fee. So a payment settled here cannot be settled again there, the
 * relayer's daily limit is one number, and a payer's hourly allowance is one number. What this
 * file adds is the translation, since the reference shapes name a few things differently, and a
 * meter per caller, since a route with no token has nothing else standing in front of it.
 */

export type PublicSurfaceOptions = {
  /** Built on the standard profile with binding off; see `createFacilitatorService`. */
  readonly facilitator: Facilitator;
  /** The relayer, published under `signers` the way the reference facilitator publishes its own. */
  readonly signers: readonly string[];
  readonly ratePerMinute: number;
  readonly now?: () => number;
};

export type PublicSurface = {
  supported(request: ApiRequest): Promise<ApiResponse>;
  verify(request: ApiRequest): Promise<ApiResponse>;
  settle(request: ApiRequest): Promise<ApiResponse>;
};

/** The reason a metered caller gets. Not in the protocol, which has no word for it. */
export const RATE_LIMITED = 'rate_limited';

const MINUTE_MS = 60_000;

/**
 * A sliding minute per caller.
 *
 * Process-local, like the settlement budget: it bounds what one listener will do for one address
 * and does not need the database to do it. A caller is the first address in `x-forwarded-for`
 * where a proxy sets one, otherwise the socket's peer.
 */
export class RequestMeter {
  private readonly perCaller = new Map<string, number[]>();

  constructor(
    private readonly perMinute: number,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  take(caller: string): boolean {
    const now = this.clock();
    const recent = (this.perCaller.get(caller) ?? []).filter((at) => at > now - MINUTE_MS);
    if (recent.length >= this.perMinute) {
      this.perCaller.set(caller, recent);
      return false;
    }
    recent.push(now);
    this.perCaller.set(caller, recent);
    // Callers that went quiet are dropped on the way past, so the map stays the size of a minute.
    if (this.perCaller.size > 10_000) {
      for (const [key, hits] of this.perCaller) {
        if (hits.every((at) => at <= now - MINUTE_MS)) this.perCaller.delete(key);
      }
    }
    return true;
  }
}

export function callerOf(request: ApiRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || request.remoteAddress || 'unknown';
}

export function createPublicSurface(options: PublicSurfaceOptions): PublicSurface {
  const { facilitator, signers } = options;
  const meter = new RequestMeter(options.ratePerMinute, options.now);

  const metered = (request: ApiRequest): boolean => meter.take(callerOf(request));

  return {
    async supported(request) {
      if (!metered(request)) return failure(429, RATE_LIMITED, tooFast(options.ratePerMinute));
      const { kinds } = await facilitator.supported();
      return ok({ kinds, extensions: [], signers: { 'eip155:*': signers } });
    },

    async verify(request) {
      if (!metered(request)) {
        return { status: 429, body: { isValid: false, invalidReason: RATE_LIMITED, invalidMessage: tooFast(options.ratePerMinute) } };
      }
      const parsed = readRequest(request.body);
      if (!parsed.ok) return { status: 400, body: { isValid: false, invalidReason: parsed.reason } };
      // A digest the caller sent is dropped rather than honoured: this surface runs the standard
      // profile, where a payment is not bound to a request, and a verdict that depended on one
      // would differ from the settle that follows it without one.
      const { paymentPayload, paymentRequirements } = parsed.request;
      return ok(verifyShape(await facilitator.verify({ paymentPayload, paymentRequirements })));
    },

    async settle(request) {
      const network = networkOf(request.body);
      if (!metered(request)) {
        return {
          status: 429,
          body: { success: false, errorReason: RATE_LIMITED, errorMessage: tooFast(options.ratePerMinute), transaction: '', network },
        };
      }
      const parsed = readRequest(request.body);
      if (!parsed.ok) {
        return { status: 400, body: { success: false, errorReason: parsed.reason, transaction: '', network } };
      }
      const { paymentPayload, paymentRequirements } = parsed.request;
      const result = await facilitator.settle({ paymentPayload, paymentRequirements });
      const throttled =
        result.errorReason === FACILITATOR_REASON.dailyBudget || result.errorReason === FACILITATOR_REASON.payerRate;
      return { status: throttled ? 429 : 200, body: settleShape(result) };
    },
  };
}

function tooFast(perMinute: number): string {
  return `This caller has made more than ${perMinute} requests to the keyless routes in the last minute.`;
}

/** The reference `VerifyResponse`: `invalidMessage` is what this service calls `detail`. */
function verifyShape(result: FacilitatorVerifyResponse): Record<string, unknown> {
  if (result.isValid) return { isValid: true, payer: result.payer };
  return {
    isValid: false,
    invalidReason: result.invalidReason,
    ...(result.payer === undefined ? {} : { payer: result.payer }),
    ...(result.detail === undefined ? {} : { invalidMessage: result.detail }),
  };
}

/**
 * The reference `SettleResponse`, with this service's two extra facts left in. A stock client
 * ignores `settled` and `broadcast`; a client that knows them learns whether a failed settle may
 * still have moved the money, which `success: false` alone cannot say.
 */
function settleShape(result: FacilitatorSettleResponse): Record<string, unknown> {
  return {
    success: result.success,
    settled: result.settled,
    broadcast: result.broadcast,
    ...(result.errorReason === undefined ? {} : { errorReason: result.errorReason }),
    ...(result.detail === undefined ? {} : { errorMessage: result.detail }),
    ...(result.payer === '' ? {} : { payer: result.payer }),
    transaction: result.transaction,
    network: result.network,
  };
}

function networkOf(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const requirements = (body as { paymentRequirements?: unknown }).paymentRequirements;
  if (!requirements || typeof requirements !== 'object') return '';
  const network = (requirements as { network?: unknown }).network;
  return typeof network === 'string' ? network : '';
}
