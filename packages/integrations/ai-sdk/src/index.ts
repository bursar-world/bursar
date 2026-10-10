import { jsonSchemaFor } from '@bursar/toolset';
import type { BursarToolset, ToolArgs, ToolSpec } from '@bursar/toolset';
import { jsonSchema, tool } from 'ai';
import type { Tool } from 'ai';

export { createToolset, toolsetFromEnv, usdg } from '@bursar/toolset';
export type { BursarToolset, SpendCap, ToolSpec, ToolsetOptions } from '@bursar/toolset';

/**
 * The four Bursar tools for the AI SDK, keyed by name: inspect, quote, pay and settlements. Pass
 * the object as `tools` to `generateText` or `streamText`. Each answers with a sentence the model
 * can act on.
 */
export function bursarTools(source: BursarToolset | readonly ToolSpec[]): Record<string, Tool<ToolArgs, string>> {
  const specs = Array.isArray(source) ? (source as readonly ToolSpec[]) : (source as BursarToolset).tools();
  const tools: Record<string, Tool<ToolArgs, string>> = {};
  for (const spec of specs) {
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema<ToolArgs>(jsonSchemaFor(spec)),
      execute: async (input) => spec.call(input ?? {}),
    });
  }
  return tools;
}
