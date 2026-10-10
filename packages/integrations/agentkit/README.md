# @bursar/agentkit

Spend from a Bursar mandate inside Coinbase AgentKit. An action provider with four actions:
inspect, quote, pay and settlements. The mandate's limits are enforced by a contract on Robinhood
Chain, so the agent cannot be talked past them.

The wallet AgentKit holds is the mandate's agent. It signs; the mandate pays. A CDP wallet, a
Privy wallet or a viem account all work, and no key is copied.

## Install

```
npm install @bursar/agentkit @coinbase/agentkit viem
```

Node 22 or newer. ESM only. Tested against `@coinbase/agentkit` 0.10.4.

## Use

```ts
import { bursarActionProvider, usdg } from '@bursar/agentkit';
import { AgentKit, ViemWalletProvider } from '@coinbase/agentkit';
import { getLangChainTools } from '@coinbase/agentkit-langchain';

const agentKit = await AgentKit.from({
  walletProvider: new ViemWalletProvider(walletClient),   // on chain 4663, as the mandate's agent
  actionProviders: [bursarActionProvider({ mandate: MANDATE, spendCap: { total: usdg('5') } })],
});

const tools = await getLangChainTools(agentKit);          // or getVercelAITools(agentKit)
```

The actions are `bursar_inspect`, `bursar_quote`, `bursar_pay` and `bursar_settlements`. Each
answers with a sentence the model can act on. Amounts are USDG in six-decimal units, `"250000"`
for 0.25 USDG.

## Example

`examples/pay.ts` pays 0.25 USDG to the demo provider from the example mandate on mainnet, with
no model in the loop: the actions are invoked the way an agent invokes them.

```
BURSAR_AGENT_KEY=0x… npx tsx examples/pay.ts            # inspect, quote, pay, settlements
BURSAR_AGENT_KEY=0x… npx tsx examples/pay.ts --quote    # inspect and quote only
```

The toolset, its options and the environment variables are documented in
[`@bursar/toolset`](https://www.npmjs.com/package/@bursar/toolset).
