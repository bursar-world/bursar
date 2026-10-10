import type { ToolSpec } from './types.js';

export type StringProperty = { readonly type: 'string'; readonly description: string; readonly pattern?: string };

/** A tool's arguments as JSON Schema: every property a string, the required ones listed. */
export type JsonObjectSchema = {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, StringProperty>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
};

export function jsonSchemaFor(spec: ToolSpec): JsonObjectSchema {
  const properties: Record<string, StringProperty> = {};
  for (const p of spec.parameters) {
    properties[p.name] = p.pattern === undefined
      ? { type: 'string', description: p.description }
      : { type: 'string', description: p.description, pattern: p.pattern };
  }
  return {
    type: 'object',
    properties,
    required: spec.parameters.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  };
}
