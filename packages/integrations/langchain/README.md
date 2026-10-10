# @bursar/langchain

Spend from a Bursar mandate inside LangChain.js. Four tools: inspect, quote, pay and settlements.
The mandate's limits are enforced by a contract on Robinhood Chain, so the agent cannot be talked
past them.

## Install

```
npm install @bursar/langchain @langchain/core
```

Node 22 or newer. ESM only. Tested against `@langchain/core` 1.2.17.

## Use

```ts
import { bursarTools, createToolset, usdg } from '@bursar/langchain';
import { createAgent } from 'langchain';

const toolset = createToolset({ mandate: MANDATE, account: process.env.BURSAR_AGENT_KEY, spendCap: { total: usdg('5') } });
const agent = createAgent({ model: 'openai:gpt-5', tools: bursarTools(toolset) });

const result = await agent.invoke({
  messages: [{ role: 'user', content: 'Check what I can spend, then pay 0.25 USDG to 0x5210…fca374 for gpu.render:1.' }],
});
```

Each tool answers with a sentence the model can act on: what is allowed, what was paid and its
settlement id, or which limit refused and when it resets. Amounts are USDG in six-decimal units,
`"250000"` for 0.25 USDG.

## Example

`examples/pay.ts` pays 0.25 USDG to the demo provider from the example mandate on mainnet, with
no model in the loop: each tool is invoked the way an agent invokes it.

```
BURSAR_AGENT_KEY=0x… npx tsx examples/pay.ts            # inspect, quote, pay, settlements
BURSAR_AGENT_KEY=0x… npx tsx examples/pay.ts --quote    # inspect and quote only
```

The toolset, its options and the environment variables are documented in
[`@bursar/toolset`](https://www.npmjs.com/package/@bursar/toolset).
