import { invalidArguments } from './errors.js';

/**
 * The JSON Schema subset the tools advertise and then enforce themselves.
 *
 * Advertising a schema and validating against something else is how an agent ends up reading a
 * revert instead of a sentence, so there is exactly one description of every argument and it is
 * this one.
 */
export type Schema = ScalarSchema | ObjectSchema | ArraySchema;

/**
 * A sharper sentence for one way of failing `pattern`.
 *
 * One regex covers several mistakes at once, and the sentence written for the common one is wrong
 * about the others: "-500000" is not a decimal point. The first `when` that matches the value the
 * caller sent decides, so hints run from the most specific mistake to the least.
 */
export type PatternHint = {
  readonly when: string;
  readonly message: string;
};

export type ScalarSchema = {
  readonly type: 'string' | 'integer' | 'number' | 'boolean' | readonly ['string', 'integer'];
  readonly description: string;
  readonly pattern?: string;
  /** Said in words when `pattern` fails, because a regex is not an instruction. */
  readonly patternMessage?: string;
  /** Read before `patternMessage`, to name the mistake the caller actually made. */
  readonly patternHints?: readonly PatternHint[];
  readonly minimum?: number;
  readonly maximum?: number;
};

export type ObjectSchema = {
  readonly type: 'object';
  readonly description?: string;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly additionalProperties?: boolean;
};

export type ArraySchema = {
  readonly type: 'array';
  readonly description: string;
  readonly items: Schema;
  readonly maxItems?: number;
};

/** What the protocol carries for a tool's arguments: always an object schema, never a scalar. */
export type JsonObjectSchema = {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required?: string[];
  readonly description?: string;
  readonly additionalProperties?: boolean;
};

export function toToolSchema(schema: ObjectSchema): JsonObjectSchema {
  const properties = Object.entries(schema.properties ?? {}).map(
    ([name, property]) => [name, toJsonSchema(property)] as const,
  );

  return {
    type: 'object',
    properties: Object.fromEntries(properties),
    ...(schema.required === undefined ? {} : { required: [...schema.required] }),
    ...(schema.description === undefined ? {} : { description: schema.description }),
    ...(schema.additionalProperties === undefined ? {} : { additionalProperties: schema.additionalProperties }),
  };
}

/**
 * The form advertised over the protocol. `patternMessage` and `patternHints` are this server's own
 * vocabulary and are dropped here, so what a client validates against is plain JSON Schema.
 */
export function toJsonSchema(schema: Schema): Record<string, unknown> {
  if (schema.type === 'object') return { ...toToolSchema(schema) };

  if (schema.type === 'array') {
    return {
      type: 'array',
      description: schema.description,
      items: toJsonSchema(schema.items),
      ...(schema.maxItems === undefined ? {} : { maxItems: schema.maxItems }),
    };
  }

  return {
    type: typeof schema.type === 'string' ? schema.type : [...schema.type],
    description: schema.description,
    ...(schema.pattern === undefined ? {} : { pattern: schema.pattern }),
    ...(schema.minimum === undefined ? {} : { minimum: schema.minimum }),
    ...(schema.maximum === undefined ? {} : { maximum: schema.maximum }),
  };
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validate(schema: ObjectSchema, args: unknown, path = 'arguments'): Record<string, unknown> {
  if (!isJsonObject(args)) throw invalidArguments(`${path} must be a JSON object`);

  for (const name of schema.required ?? []) {
    if (args[name] === undefined) throw invalidArguments(`${name} is required`);
  }

  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const value = args[name];

    if (value !== undefined) check(property, value, path === 'arguments' ? name : `${path}.${name}`);
  }

  return args;
}

function check(schema: Schema, value: unknown, path: string): void {
  if (schema.type === 'object') {
    validate(schema, value, path);

    return;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw invalidArguments(`${path} must be an array`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw invalidArguments(`${path} must hold at most ${schema.maxItems} entries`);
    }

    value.forEach((item, index) => {
      check(schema.items, item, `${path}[${index}]`);
    });

    return;
  }

  checkScalar(schema, value, path);
}

function checkScalar(schema: ScalarSchema, value: unknown, path: string): void {
  const types = typeof schema.type === 'string' ? [schema.type] : schema.type;

  if (!types.some((type) => matches(type, value))) {
    throw invalidArguments(`${path} must be ${types.map(word).join(' or ')}`);
  }

  if (typeof value === 'string' && schema.pattern !== undefined) {
    if (!new RegExp(schema.pattern, 'u').test(value)) {
      throw invalidArguments(hintFor(schema, value) ?? schema.patternMessage ?? `${path} must match ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw invalidArguments(`${path} must be at least ${schema.minimum}`);
    }

    if (schema.maximum !== undefined && value > schema.maximum) {
      throw invalidArguments(`${path} must be at most ${schema.maximum}`);
    }
  }
}

/** The sentence written for the mistake this value actually made, when one was written. */
function hintFor(schema: ScalarSchema, value: string): string | undefined {
  return schema.patternHints?.find((hint) => new RegExp(hint.when, 'u').test(value))?.message;
}

/** The error a caller reads, not the word a schema uses. */
function word(type: string): string {
  switch (type) {
    case 'integer':
      return 'a whole number';
    case 'boolean':
      return 'true or false';
    case 'number':
      return 'a number';
    default:
      return 'a string';
  }
}

function matches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}
