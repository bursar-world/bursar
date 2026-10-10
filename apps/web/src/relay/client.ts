import type { Hex } from 'viem';

import { parseQuote, quoteBody, quoteRefusal, RelayQuoteError } from './quote';
import type { FundingQuote, QuoteInput } from './quote';
import { parseStatus } from './status';
import type { RelayStatus } from './status';

/**
 * The two calls this product makes to Relay.
 *
 * In the browser `base` is this app's own `/api/relay`, which forwards to Relay with the
 * deployment's key and the same paths. From a terminal it is `https://api.relay.link` directly.
 * Either way the bodies are the ones Relay documents, unchanged.
 */
export type RelayApi = {
  readonly quote: (input: QuoteInput, signal?: AbortSignal) => Promise<FundingQuote>;
  readonly status: (requestId: Hex, signal?: AbortSignal) => Promise<RelayStatus>;
};

export const RELAY_API = 'https://api.relay.link';

export function relayApi(options: { readonly base: string; readonly fetch?: typeof fetch; readonly apiKey?: string }): RelayApi {
  const call = options.fetch ?? ((input, init) => fetch(input, init));
  const base = options.base.replace(/\/+$/, '');
  const headers = { accept: 'application/json', ...(options.apiKey === undefined ? {} : { 'x-api-key': options.apiKey }) };

  return {
    async quote(input, signal) {
      const response = await call(`${base}/quote`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(quoteBody(input)),
        ...(signal === undefined ? {} : { signal }),
      });
      const body = await bodyOf(response);
      if (!response.ok) throw quoteRefusal(body, response.status);
      return parseQuote(body);
    },
    async status(requestId, signal) {
      const response = await call(`${base}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, {
        method: 'GET',
        headers,
        ...(signal === undefined ? {} : { signal }),
      });
      const body = await bodyOf(response);
      if (!response.ok) throw new RelayQuoteError(`Relay answered ${response.status} to a status check.`, { status: response.status });
      return parseStatus(body);
    },
  };
}

async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 200) };
  }
}
