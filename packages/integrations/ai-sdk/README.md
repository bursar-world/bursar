# @bursar/ai-sdk

Spend from a Bursar mandate inside Vercel's AI SDK. Four tools: inspect, quote, pay and
settlements. The mandate's limits are enforced by a contract on Robinhood Chain, so the agent
cannot be talked past them.

## Install

```
npm install @bursar/ai-sdk ai
```

Node 22 or newer. ESM only. Tested against `ai` 7.0.129.

## Use

```ts
import { bursarTools, createToolset, usdg } from '@bursar/ai-sdk';
import { openai } from '@ai-sdk/openai';
import { generateText, stepCountIs } from 'ai';

const toolset = createToolset({ mandate: MANDATE, account: process.env.BURSAR_AGENT_KEY, spendCap: { total: usdg('5') } });

const { text } = await generateText({
  model: openai('gpt-5'),
  tools: bursarTools(toolset),
  stopWhen: stepCountIs(6),
  prompt: 'Check what I can spend, then pay 0.25 USDG to 0x5210…fca374 for gpu.render:1.',
});
```

`bursarTools` returns the tools keyed by name, ready for `generateText` or `streamText`. Each
answers with a sentence the model can act on.

## Example

`examples/pay.ts` pays 0.25 USDG to the demo provider from the example mandate on mainnet, with
no model in the loop: each tool's `execute` runs the way `generateText` runs it.

```
BURSAR_AGENT_KEY=0x… npx tsx examples/pay.ts            # inspect, quote, pay, settlements
BURSAR_AGENT_KEY=0x… npx tsx examples/pay.ts --quote    # inspect and quote only
```

The toolset, its options and the environment variables are documented in
[`@bursar/toolset`](https://www.npmjs.com/package/@bursar/toolset).
