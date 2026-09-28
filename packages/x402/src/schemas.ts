/**
 * Call shapes shared by the discovery document and the runtime 402.
 *
 * A resource server describes its paid call twice: once in whatever catalogue indexes it, once in
 * the challenge it returns to an unpaid request. When those two drift, a client integrates against
 * the catalogue and then fails against the endpoint, which looks like a client bug and is not one.
 * Declaring the shape once, here, keeps the two in step.
 */
export type JsonSchema = {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly (string | number)[];
  readonly const?: string | number | boolean;
  readonly description?: string;
  readonly minLength?: number;
  readonly pattern?: string;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly [key: string]: unknown;
};

export function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema {
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

/**
 * A literal receipt, for the discovery extension's `output.example`.
 *
 * The field takes a sample, not a schema. Putting a schema here parses as no example at all, and
 * the only symptom is a listing that never appears.
 */
export const settlementReceiptExample = Object.freeze({
  success: true,
  transaction: '0x1903a38b9f3621a8245a16a85be2f7c4135cb5f2047902bc848ed3ddc3b66b2b',
  network: 'eip155:4663',
  payer: '0xCC5f9c251Fc3C69c04ae2b860b41150282E6B618',
});
