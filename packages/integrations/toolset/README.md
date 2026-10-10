# @bursar/toolset

Four tools over one Bursar mandate, for any agent framework: inspect, quote, pay and settlements.
Strings in, strings out. The adapters `@bursar/agentkit`, `@bursar/langchain`,
`@bursar/openai-agents` and `@bursar/ai-sdk` wrap this package; use it directly for a framework
that has no adapter yet.

A mandate is a contract on Robinhood Chain that holds USDG and the limits an agent spends inside:
per call, per day, per month, which providers, which capabilities, and the amount above which a
person has to sign. The tools read and spend through [`@bursar/sdk`](https://www.npmjs.com/package/@bursar/sdk),
and every refusal comes back as a sentence that names the limit.

## Install

```
npm install @bursar/toolset
```

Node 22 or newer. ESM only.

## Use

```ts
import { createToolset, usdg } from '@bursar/toolset';

const toolset = createToolset({
  mandate: '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c',
  account: process.env.BURSAR_AGENT_KEY,        // the mandate's agent key, or any viem account
  spendCap: { total: usdg('5') },               // this agent's own ceiling, on top of the mandate
});

for (const tool of toolset.tools()) console.log(tool.name, tool.parameters.map((p) => p.name));

console.log(await toolset.inspect());
console.log(await toolset.pay({ provider, capability: 'gpu.render:1', amount: '250000', input: 'render a koi' }));
```

`toolsetFromEnv()` reads the same from `BURSAR_MANDATE`, `BURSAR_AGENT_KEY` (or `BURSAR_KEYSTORE`
with `BURSAR_KEYSTORE_PASSWORD_FILE`, the format `cast wallet import` writes), `BURSAR_RPC` and
`BURSAR_SPEND_CAP`. Without a key the toolset reads and quotes but cannot pay.

## The tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `bursar_inspect` | none | The limits, what is left in each window, the balance, the escrow floor, this agent's cap. Nothing is spent. |
| `bursar_quote` | `provider`, `capability`, `amount` | What the mandate would decide, and which limit stops it. Nothing moves. |
| `bursar_pay` | `provider`, `capability`, `amount`, `input?`, `deliverWithinSeconds?` | Quotes first, then locks the amount in escrow for the provider. The reply carries the settlement id and the transaction. |
| `bursar_settlements` | `settlementId?` | This agent's payments, newest first, with where each stands on the escrow. Or one by id. |

Amounts are USDG in six-decimal units as digit strings: `"250000"` is 0.25 USDG. A decimal point
is refused with the fix in the answer. `input` is committed with the payment, so both sides can
prove what was asked.

`spendCap` is per toolset instance, which is per agent: `perCall` and `total`, in micro-USD via
`usdg('0.50')`. It is checked before the chain is asked, and refunds are not credited back to it.
The mandate's own limits are enforced by the contract whatever this cap says.

`jsonSchemaFor(tool)` gives a tool's arguments as JSON Schema, which is how the adapters hand them
to each framework.
