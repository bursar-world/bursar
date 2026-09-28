import { readAddress, readMicro } from './payload.js';
import { REASON, type InvalidReason } from './reasons.js';
import {
  isTransferMethod,
  type PaymentPayload,
  type PaymentRequirements,
  type RemoteVerifyResult,
  type SettleResult,
  type SupportedResponse,
} from './types.js';

/**
 * The client half of the facilitator interface: verify and settle, over HTTP, on someone else's
 * behalf.
 *
 * The public facilitators are testnet-only and none of them knows Robinhood Chain, so BURSAR
 * runs its own. This is what a resource server talks to. The service that answers these routes is
 * a separate deployment; what lives here is the caller and the one judgement that matters on this
 * side.
 *
 * That judgement: a settle request that times out has not failed. The facilitator broadcasts
 * before it answers, so a dropped connection leaves a transaction that may well be mining.
 * Reporting it as a failure serves the resource for free against a payment the payer was charged
 * for. Unconfirmed is the honest answer, and the caller retries the read rather than the payment.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** An answer larger than this is not one this client can use, and reading it on is a free DoS. */
const MAX_RESPONSE_BYTES = 32 * 1024;

export type FacilitatorClientOptions = {
  readonly baseUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  /** Sent on every request. A self-hosted facilitator is usually behind an auth header. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxResponseBytes?: number;
};

export type FacilitatorClient = {
  supported(): Promise<SupportedResponse>;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<RemoteVerifyResult>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResult>;
};

export function createFacilitatorClient(options: FacilitatorClientOptions): FacilitatorClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;

  /**
   * The parsed body and the status it came with.
   *
   * The status is kept because a body alone cannot say whether it was the facilitator that wrote
   * it. A gateway 504 in front of a settle that already broadcast, or a 401 from an auth proxy, can
   * carry JSON too, and reading either as the facilitator's verdict turns a maybe-paid call into a
   * refusal.
   */
  async function call(path: string, init: RequestInit): Promise<{ readonly status: number; readonly body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${base}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...options.headers, ...init.headers },
      });
      const text = await readCapped(response, maxBytes);
      // A 4xx or 5xx with a well-formed body is still an answer: the budget refusals arrive as
      // 429 and carry the reason the caller has to act on.
      if (text.length === 0) {
        throw new Error(`facilitator answered ${response.status} with an empty body`);
      }
      return { status: response.status, body: JSON.parse(text) as unknown };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async supported(): Promise<SupportedResponse> {
      const { body } = await call('/supported', { method: 'GET' });
      const kinds = isRecord(body) ? body['kinds'] : undefined;
      return { kinds: Array.isArray(kinds) ? (kinds as SupportedResponse['kinds']) : [] };
    },

    async verify(payload, requirements): Promise<RemoteVerifyResult> {
      let status: number;
      let body: unknown;
      try {
        ({ status, body } = await call('/verify', {
          method: 'POST',
          body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements }),
        }));
      } catch (error) {
        // Verification writes nothing, so a failed call means only that the answer is not known yet.
        return { isValid: false, invalidReason: REASON.facilitator, detail: message(error, timeoutMs) };
      }

      // A non-2xx that is not a verdict came from something in front of the facilitator, or from
      // the facilitator failing, and neither says anything about the payment itself.
      if (!ok(status) && !(isRecord(body) && typeof body['isValid'] === 'boolean')) {
        return {
          isValid: false,
          invalidReason: REASON.facilitator,
          detail: `facilitator answered ${status} without a verdict`,
        };
      }

      const payer = payerOf(body);
      if (!isRecord(body) || body['isValid'] !== true) {
        return {
          isValid: false,
          invalidReason: reasonOf(body) ?? REASON.payload,
          ...(payer === null ? {} : { payer }),
        };
      }

      // Every settle and every budget is keyed on the payer, so a valid verdict that names nobody
      // is not one a resource server can act on.
      if (payer === null) {
        return {
          isValid: false,
          invalidReason: REASON.facilitator,
          detail: 'facilitator reported the payment valid without naming a payer',
        };
      }

      const method = body['method'];
      const amount = readMicro(body['amount']);
      return {
        isValid: true,
        payer,
        ...(isTransferMethod(method) ? { method } : {}),
        ...(amount === null ? {} : { amount }),
      };
    },

    async settle(payload, requirements): Promise<SettleResult> {
      const network = String(requirements.network ?? '');
      let status: number;
      let body: unknown;
      try {
        ({ status, body } = await call('/settle', {
          method: 'POST',
          body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements }),
        }));
      } catch (error) {
        return unconfirmed(network, message(error, timeoutMs));
      }

      if (!isRecord(body)) {
        return unconfirmed(network, 'facilitator answered with something other than a settlement');
      }
      // Only the facilitator knows whether it broadcast. A non-2xx that does not say so explicitly
      // may be a gateway timing out on a settle that is mining, so it is unconfirmed, never refused.
      if (!ok(status) && typeof body['broadcast'] !== 'boolean') {
        return unconfirmed(network, `facilitator answered ${status} without saying whether it broadcast`);
      }

      const success = body['success'] === true;
      const reason = reasonOf(body);
      const payer = payerOf(body);
      return {
        success,
        settled: readSettled(body['settled'], success),
        broadcast: body['broadcast'] === undefined ? success : body['broadcast'] === true,
        ...(reason === null ? {} : { errorReason: reason }),
        payer: payer ?? '',
        transaction: typeof body['transaction'] === 'string' ? body['transaction'] : '',
        network: typeof body['network'] === 'string' ? body['network'] : network,
        ...(typeof body['detail'] === 'string' ? { detail: body['detail'] } : {}),
      };
    },
  };
}

/**
 * Reads the answer under a byte budget, rejecting a declared length over it and cancelling the
 * stream on the first byte past it.
 *
 * Buffering first and measuring afterwards is not a cap: the memory is already spent by the time
 * the check runs. The budget counts bytes rather than string length, because a limit written in
 * bytes and enforced in UTF-16 units lets a multibyte body through at three times its size.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    // Cancelled rather than abandoned, so the connection is not held open for a body nobody reads.
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`facilitator declared ${declared} bytes, over the ${maxBytes} limit`);
  }

  const body = response.body;
  if (body === null) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;

      total += chunk.value.byteLength;
      if (total > maxBytes) {
        throw new Error(`facilitator answered over the ${maxBytes} limit`);
      }

      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
}

/**
 * An older facilitator has no `settled` field, so success is the only signal. A newer one may send
 * null, which means broadcast and unread and must survive the trip intact.
 */
function readSettled(value: unknown, success: boolean): boolean | null {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  return success;
}

function unconfirmed(network: string, detail: string): SettleResult {
  return {
    success: false,
    settled: null,
    broadcast: true,
    errorReason: REASON.unconfirmed,
    payer: '',
    transaction: '',
    network,
    detail,
  };
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reasonOf(body: unknown): InvalidReason | null {
  if (!isRecord(body)) return null;
  const reason = body['invalidReason'] ?? body['errorReason'];
  return typeof reason === 'string' ? (reason as InvalidReason) : null;
}

function payerOf(body: unknown): `0x${string}` | null {
  if (!isRecord(body)) return null;
  return readAddress(body['payer']);
}

function message(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? `facilitator did not answer within ${timeoutMs}ms` : error.message;
  }
  return String(error);
}
