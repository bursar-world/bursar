import { jsonSchemaFor } from '@bursar/toolset';
import type { BursarToolset, ToolArgs, ToolSpec } from '@bursar/toolset';
import { tool } from '@openai/agents';

export { createToolset, toolsetFromEnv, usdg } from '@bursar/toolset';
export type { BursarToolset, SpendCap, ToolSpec, ToolsetOptions } from '@bursar/toolset';

type Property = { type: 'string' | ['string', 'null']; description: string; pattern?: string };

/**
 * The OpenAI Agents SDK runs function tools in strict mode, where every property is required.
 * An optional argument is carried as nullable instead, and a null is dropped before the call.
 */
function strictSchema(spec: ToolSpec) {
  const schema = jsonSchemaFor(spec);
  const properties: Record<string, Property> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    properties[name] = schema.required.includes(name) ? property : { ...property, type: ['string', 'null'] };
  }
  return { type: 'object' as const, properties, required: Object.keys(properties), additionalProperties: false as const };
}

function withoutNulls(input: unknown): ToolArgs {
  const args: Record<string, string> = {};
  if (input && typeof input === 'object') {
    for (const [name, value] of Object.entries(input)) if (typeof value === 'string') args[name] = value;
  }
  return args;
}

/**
 * The four Bursar tools as OpenAI Agents SDK function tools: inspect, quote, pay and settlements.
 * Hand them to an `Agent`. Each answers with a sentence the model can act on.
 */
export function bursarTools(source: BursarToolset | readonly ToolSpec[]) {
  const specs = Array.isArray(source) ? (source as readonly ToolSpec[]) : (source as BursarToolset).tools();
  return specs.map((spec) =>
    tool({
      name: spec.name,
      description: spec.description,
      parameters: strictSchema(spec),
      execute: async (input: unknown) => spec.call(withoutNulls(input)),
    }),
  );
}
