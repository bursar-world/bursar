import type { JsonSchema } from './schemas.js';
import type { PaymentPayload, PaymentRequirements, SchemePayload, SettleResult, X402Version } from './types.js';

/**
 * Translation between the two live shapes of the protocol and the one internal form the verifier
 * works in.
 *
 * Version 1 puts requirements in a JSON body with an `accepts` array and carries the payment in
 * `X-PAYMENT`. Version 2 moves both into headers (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`,
 * `PAYMENT-RESPONSE`). Underneath they carry the same authorisation. The difference is packaging,
 * and packaging belongs in one file.
 */
function decode(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export type DetectedPayment = {
  readonly version: X402Version;
  readonly header: string;
};

/**
 * Which version a request speaks, from its headers alone. Neither header present means an unpaid
 * first request, which gets a 402.
 */
export function detect(headers: Readonly<Record<string, unknown>> | null | undefined): DetectedPayment | null {
  const lower = new Map<string, unknown>();
  for (const [key, value] of Object.entries(headers ?? {})) lower.set(key.toLowerCase(), value);

  const v2 = lower.get('payment-signature');
  if (typeof v2 === 'string' && v2.length > 0) return { version: 2, header: v2 };

  const v1 = lower.get('x-payment');
  if (typeof v1 === 'string' && v1.length > 0) return { version: 1, header: v1 };

  return null;
}

/**
 * A payment header in the internal payload shape.
 *
 * Returns null when the header does not decode. The caller reports that as `invalid_payload`: a
 * malformed payment is a failed payment, and answering 402 to one invites a client to pay twice.
 */
export function parsePayment(header: string): PaymentPayload | null {
  let decoded: unknown;
  try {
    decoded = decode(header);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;

  const record = decoded as Record<string, unknown>;
  const payload = record['payload'];

  // v1 nests the scheme fields at the top level, v2 groups them under `accepted`. Normalising here
  // keeps the verifier free of version checks.
  const accepted = isRecord(record['accepted'])
    ? (record['accepted'] as PaymentRequirements)
    : ({
        scheme: record['scheme'],
        network: record['network'],
        asset: record['asset'],
        payTo: record['payTo'],
      } as PaymentRequirements);

  return {
    x402Version: record['x402Version'] ?? 1,
    accepted,
    payload: isRecord(payload) ? (payload as SchemePayload) : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Version 2 keeps an accepts entry to payment terms alone. Everything describing the resource
 * moved up a level, and sending the v1 spelling alongside makes the entry fail schema validation
 * rather than being ignored.
 */
const V2_ENTRY_FIELDS = ['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds', 'extra'] as const;

/**
 * Requirements in the shape a given version expects.
 *
 * Entries are always authored in v2 terms, with `amount` in atomic units. This renames for v1 and
 * strips the v1-only fields for v2. The network is not renamed: Robinhood Chain has one
 * spelling, the CAIP-2 one, for both versions.
 */
export function requirementsFor(version: X402Version, requirements: PaymentRequirements): PaymentRequirements {
  if (version === 2) {
    const entry: Record<string, unknown> = {};
    for (const field of V2_ENTRY_FIELDS) {
      if (requirements[field] !== undefined) entry[field] = requirements[field];
    }
    return entry as PaymentRequirements;
  }

  const { amount, ...rest } = requirements;
  return { ...rest, maxAmountRequired: String(amount ?? requirements['maxAmountRequired'] ?? '') } as PaymentRequirements;
}

export type BazaarOptions = {
  /** JSON Schema for the request body. */
  readonly input: JsonSchema;
  readonly output?: JsonSchema;
  /** A sample response. `output` is its schema. */
  readonly example?: unknown;
  /** A sample request. `input` is its schema. */
  readonly inputExample?: unknown;
  readonly method?: 'POST' | 'PUT' | 'PATCH';
};

export type BazaarExtension = {
  readonly bazaar: {
    readonly info: Record<string, unknown>;
    readonly schema: Record<string, unknown>;
  };
};

/**
 * The discovery extension a v2 challenge carries to say what the call looks like.
 *
 * The nesting is not obvious and is not in the prose spec. Readers descend to
 * `schema.properties.input.properties.body` for the request and to
 * `schema.properties.output.properties.example` for the response, and an indexer validates the
 * extension field for field. `bodyType` is what marks the declaration as a body call rather than
 * a query one, and the four required input keys are all checked. Omitting them produces a parse
 * failure that names a field you are already sending.
 */
export function bazaar(options: BazaarOptions): BazaarExtension {
  const { input, output, example, inputExample, method = 'POST' } = options;
  const hasOutput = example !== undefined || output !== undefined;

  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      input: {
        type: 'object',
        properties: {
          type: { type: 'string', const: 'http' },
          method: { type: 'string', enum: ['POST', 'PUT', 'PATCH'] },
          bodyType: { type: 'string', enum: ['json', 'form-data', 'text'] },
          body: input,
        },
        required: ['type', 'method', 'bodyType', 'body'],
        additionalProperties: false,
      },
      ...(hasOutput
        ? {
            output: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                example: { type: 'object', ...(output ?? {}) },
              },
              required: ['type'],
            },
          }
        : {}),
    },
    required: ['input'],
  };

  // `schema` describes the call and `info` is an instance of it: `info` carries samples where
  // `schema` carries types, and an indexer checks both.
  return {
    bazaar: {
      info: {
        input: { type: 'http', method, bodyType: 'json', body: inputExample ?? input },
        ...(hasOutput ? { output: { type: 'json', example: example ?? output } } : {}),
      },
      schema,
    },
  };
}

export type ResourceDescriptor = {
  readonly url: string;
  readonly description?: string;
  readonly mimeType?: string;
};

export type PaymentRequiredOptions = {
  readonly accepts: readonly PaymentRequirements[];
  readonly error?: string;
  /** Required by v2, as an object where v1 took a path string. */
  readonly resource?: ResourceDescriptor;
  readonly schemas?: BazaarOptions;
  readonly extra?: Readonly<Record<string, unknown>>;
};

export type PaymentRequiredResponse = {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
};

/**
 * The 402 a server sends. Version 1 answers in a JSON body; version 2 answers with a base64
 * `PAYMENT-REQUIRED` header and leaves the body to the application.
 */
export function paymentRequired(
  version: X402Version,
  options: PaymentRequiredOptions,
): PaymentRequiredResponse {
  const { accepts, error, resource, schemas, extra = {} } = options;

  if (version === 2) {
    const body: Record<string, unknown> = {
      x402Version: 2,
      ...(error !== undefined ? { error } : {}),
      ...(resource !== undefined ? { resource } : {}),
      accepts: accepts.map((entry) => requirementsFor(2, entry)),
      ...(schemas !== undefined ? { extensions: bazaar(schemas) } : {}),
      ...extra,
    };
    return { headers: { 'PAYMENT-REQUIRED': encode(body) }, body };
  }

  return {
    headers: {},
    body: {
      x402Version: 1,
      ...(error !== undefined ? { error } : {}),
      accepts: accepts.map((entry) => requirementsFor(1, entry)),
      ...extra,
    },
  };
}

/**
 * The settlement result a server returns alongside a paid response. Version 2 defines a
 * `PAYMENT-RESPONSE` header for it; version 1 has no equivalent, so a v1 server that wants to
 * report it puts it in the body itself.
 */
export function paymentResponse(
  version: X402Version,
  settlement: SettleResult,
): { readonly headers: Readonly<Record<string, string>> } {
  if (version !== 2) return { headers: {} };
  return {
    headers: {
      'PAYMENT-RESPONSE': encode({
        success: settlement.success,
        transaction: settlement.transaction,
        network: settlement.network,
        payer: settlement.payer,
        ...(settlement.errorReason !== undefined ? { errorReason: settlement.errorReason } : {}),
      }),
    },
  };
}

/** A payment payload in the header form a client sends. */
export function encodePayment(payload: PaymentPayload): string {
  return encode(payload);
}

/** The header name a given version carries its payment in. */
export function paymentHeaderName(version: X402Version): 'PAYMENT-SIGNATURE' | 'X-PAYMENT' {
  return version === 2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT';
}
