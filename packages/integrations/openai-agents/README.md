# @bursar/openai-agents

Spend from a Bursar mandate inside the OpenAI Agents SDK. Four function tools: inspect, quote, pay
and settlements. The mandate's limits are enforced by a contract on Robinhood Chain, so the agent
cannot be talked past them.

## Install

```
npm install @bursar/openai-agents @openai/agents
```

Node 22 or newer. ESM only. Tested against `@openai/agents` 0.19.0.

## Use

```ts
import { bursarTools, createToolset, usdg } from '@bursar/openai-agents';
import { Agent, run } from '@openai/agents';

const toolset = createToolset({ mandate: MANDATE, account: process.env.BURSAR_AGENT_KEY, spendCap: { total: usdg('5') } });
const agent = new Agent({
  name: 'Buyer',
  instructions: 'Quote before you pay. Amounts are USDG in six-decimal units.',
  tools: bursarTools(toolset),
});

const result = await run(agent, 'Pay 0.25 USDG to 0x5210…fca374 for gpu.render:1, then show the settlement.');
```

The tools run in strict mode: every argument is listed, and the optional ones are nullable. Each
answers with a sentence the model can act on.

## Example

`examples/pay.ts` pays 0.25 USDG to the demo provider from the example mandate on mainnet, with
no model in the loop: each tool is invoked the way the agent runner invokes it.

```
BURSAR_AGENT_KEY=0x… npx tsx examples/pay.ts            # inspect, quote, pay, settlements
BURSAR_AGENT_KEY=0x… npx tsx examples/pay.ts --quote    # inspect and quote only
```

The toolset, its options and the environment variables are documented in
[`@bursar/toolset`](https://www.npmjs.com/package/@bursar/toolset).
