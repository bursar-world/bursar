import { jsonSchemaFor } from '@bursar/toolset';
import type { BursarToolset, ToolArgs, ToolSpec } from '@bursar/toolset';
import { tool } from '@langchain/core/tools';

export { createToolset, toolsetFromEnv, usdg } from '@bursar/toolset';
export type { BursarToolset, SpendCap, ToolSpec, ToolsetOptions } from '@bursar/toolset';

/**
 * The four Bursar tools as LangChain tools: inspect, quote, pay and settlements. Hand them to
 * `createAgent` or any tool-calling model. Each answers with a sentence the model can act on.
 */
export function bursarTools(source: BursarToolset | readonly ToolSpec[]) {
  const specs = Array.isArray(source) ? (source as readonly ToolSpec[]) : (source as BursarToolset).tools();
  return specs.map((spec) =>
    tool(async (input: unknown) => spec.call((input ?? {}) as ToolArgs), {
      name: spec.name,
      description: spec.description,
      schema: jsonSchemaFor(spec),
    }),
  );
}
