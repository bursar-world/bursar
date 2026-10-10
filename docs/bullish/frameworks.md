# Bullish update 5 · Bursar inside the agent frameworks

**The sentence:** agents built with Coinbase's AgentKit, LangChain, the OpenAI Agents SDK or Vercel's AI SDK can spend
from a Bursar mandate with one import.

Outside roots, named honestly: built and tested against the published packages `@coinbase/agentkit` 0.10.4,
`@langchain/core` 1.2.17, `@openai/agents` 0.19.0 and `ai` 7.0.129. Each framework's public tool interface is the
seam; none of the four companies endorses or lists Bursar, and the AgentKit contribution is a patch the operator
opens as a pull request.

## What is live and what is prepared

Live on the branch, tests green, examples run on mainnet:

| Package | What it is | Framework pin |
| --- | --- | --- |
| `@bursar/toolset` | Four tools over one mandate, strings in and out: `inspect`, `quote`, `pay`, `settlements`. One job table per instance, a per-agent spend cap (`perCall`, `total`), built on `@bursar/sdk`. 20 tests. | none |
| `@bursar/agentkit` | An AgentKit `ActionProvider`. The wallet provider AgentKit holds is the mandate's agent: spends go out through its own `sendTransaction`, so a CDP, Privy or viem wallet works and no key is copied. 5 tests. | `@coinbase/agentkit` 0.10.4 |
| `@bursar/langchain` | `bursarTools(toolset)` returns LangChain tools with JSON Schema arguments. 4 tests. | `@langchain/core` 1.2.17 |
| `@bursar/openai-agents` | `bursarTools(toolset)` returns strict function tools; optional arguments are nullable. 2 tests. | `@openai/agents` 0.19.0 |
| `@bursar/ai-sdk` | `bursarTools(toolset)` returns tools keyed by name for `generateText` and `streamText`. 2 tests. | `ai` 7.0.129 |

Every adapter is a thin wrapper: the toolset decides, the framework carries. A tool answers with a sentence the
model can act on; a refusal names the limit and, for a window, when it resets. Amounts are USDG in six-decimal
units as digit strings (`"250000"` is 0.25 USDG); a decimal point is refused with the fix in the answer. `pay`
quotes first, so a spend the mandate would refuse is never sent. The agent cap is checked before the chain is
asked.

Prepared, for the operator: the npm publish of the five packages, and the AgentKit upstream patch at
`docs/bullish/frameworks-agentkit.patch` (provider, schemas, test, README, export, dependency, changeset in
`coinbase/agentkit`'s layout).

The pins are the newest releases older than the workspace's three-day install window on 2026-10-10;
`@openai/agents` 0.20.0 and `ai` 7.0.137 were published inside it.

## The demo

Each package has `examples/pay.ts`, which pays the demo provider `0x5210D8df060A9D5ce4c1305045ED5c9548fca374`
for `gpu.render:1` from the example mandate `0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c` on Robinhood Chain,
with no model in the loop: the four tools are invoked the way each framework's agent loop invokes them, and the
output is what the model would read.

```sh
cd packages/integrations/langchain        # or agentkit, openai-agents, ai-sdk
BURSAR_AGENT_KEY=0x… npx tsx examples/pay.ts            # inspect, quote, pay, settlements
BURSAR_AGENT_KEY=0x… npx tsx examples/pay.ts --quote    # inspect and quote only; nothing is sent
```

The key can come from a keystore instead: `BURSAR_KEYSTORE=~/.config/bursar/keystore/payer` with
`BURSAR_KEYSTORE_PASSWORD_FILE=$ETH_PASSWORD` after `source ~/Projects/bursar-ops/ops/rhc-env.sh`.
`BURSAR_RPC` takes a comma-separated list; `BURSAR_EXAMPLE_AMOUNT` overrides the 0.25 USDG.

Runs that happened for real, every one of them on mainnet:

| Framework | Amount | Settlement | Transaction |
| --- | --- | --- | --- |
| LangChain | 0.25 USDG | 34 | [0x3bae3a57…fca396a4](https://robinhoodchain.blockscout.com/tx/0x3bae3a57da56ad84f02475f082c807284728af0c2b11fc0240e3f09cfca396a4) |
| AgentKit | 0.02 USDG | 40 | [0xe1092315…f2f5cdfe8](https://robinhoodchain.blockscout.com/tx/0xe1092315d19a76975896dd1b997b61bfc0959347ddb53d4b5ad300fb2f5cdfe8) |
| OpenAI Agents SDK | 0.05 USDG | 41 | [0x33157099…7cd2789d](https://robinhoodchain.blockscout.com/tx/0x331570993e856070d5d425da50bc57d1acdf09c6ab8847c08fbb4add7cd2789d) |
| AI SDK | 0.05 USDG | 42 | [0x4f6dae01…724e1d36](https://robinhoodchain.blockscout.com/tx/0x4f6dae01af21bd03ab926118fd429882c4733d5a093729b9e4b9e685724e1d36) |

Two more spends of 0.02 USDG each were diagnostics while wiring the AgentKit signer: settlement 37
([0xaa95fa25…8d92424a](https://robinhoodchain.blockscout.com/tx/0xaa95fa25683049713ffacdd9667889ea66a31a7c940208cde2c6216a8d92424a),
the toolset through a JSON-RPC wallet client) and 38
([0x2d009778…6e25ac1](https://robinhoodchain.blockscout.com/tx/0x2d0097789ece1c66bec11f2c2bb7ca291cb80592f06b62dea5f2a929f6e25ac1),
the action provider through `ViemWalletProvider`). Total spend 0.41 USDG, 0.000049 ETH in gas, inside the
$0.50 and 0.0003 ETH the rules allow. The LangChain run paid the full 0.25; the other three were run smaller
so all four could run for real under the cap. The demo provider does not deliver, so each lock passes its
deadline ten minutes after the payment and the money returns to the mandate from the exceptions page.

The settlements land on the console at
[app.bursar.world/console/0x8605…/settlements](https://app.bursar.world/console/0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c/settlements),
which reads without a wallet.

## What the operator must do

1. **Push the branch** `bullish/frameworks` and open the compare link below.
2. **Publish to npm**, toolset first, with the npm token in `NPM_TOKEN` (or `npm login`):
   ```sh
   pnpm --filter "@bursar/ai-sdk..." --filter "@bursar/agentkit..." --filter "@bursar/langchain..." --filter "@bursar/openai-agents..." build
   for p in @bursar/toolset @bursar/agentkit @bursar/langchain @bursar/openai-agents @bursar/ai-sdk; do
     pnpm --filter "$p" publish --access public --no-git-checks
   done
   ```
   pnpm rewrites `workspace:*` to the versions in the tree: `@bursar/sdk` 0.1.2, which is what npm holds, and
   `@bursar/toolset` 0.1.0. Smoke test after the first publish: in an empty directory, `npm i @bursar/toolset`
   and run the read-only `inspect` on the example mandate (no key needed).
3. **Open the AgentKit pull request** once `@bursar/toolset` is on npm, since the patch adds it as a
   dependency: fork `coinbase/agentkit`, `git am docs/bullish/frameworks-agentkit.patch` on `master`, run
   `pnpm install && pnpm build && pnpm test` in `typescript/agentkit`, push, open the PR titled
   `feat(agentkit): add Bursar action provider`. The patch's author is `Bursar <hello@bursar.world>`; amend to
   the account that opens it. The PR body is below. AgentKit builds to CommonJS and the toolset is ESM, so the
   package needs Node 22.12 or newer, where `require()` loads it; say so in the PR, and if their CI runs older
   Node, switch the provider's import to a dynamic `import()`.
4. **Announce** after the publish, with `docs/bullish/frameworks/01-agentkit.png` or `04-ai-sdk.png` under the
   paragraph and `demo.webm` where motion plays.
5. Optional: return the four example locks from the mandate's exceptions page after their deadlines. No
   governance, no provisioning, no new services.

PR body:

> Adds a Bursar action provider. A Bursar mandate is a contract on Robinhood Chain (chain id 4663) that holds
> USDG and the limits an agent spends inside: per call, per day, per month, which providers, which capabilities,
> and the amount above which the principal has to sign. The provider exposes four actions over one mandate:
> `inspect`, `quote`, `pay` and `settlements`. The wallet provider AgentKit holds is the mandate's agent; spends
> go out through its `sendTransaction`, so CDP, Privy and viem wallets all work. The money is the mandate's,
> never the wallet's. Built on `@bursar/toolset`, which carries the SDK. Robinhood Chain only. Tests mock the
> toolset. Docs: https://bursar.world.

## Links

- Toolset: https://github.com/bursar-world/bursar/blob/bullish/frameworks/packages/integrations/toolset/src/toolset.ts ·
  https://github.com/bursar-world/bursar/blob/bullish/frameworks/packages/integrations/toolset/README.md
- AgentKit: https://github.com/bursar-world/bursar/blob/bullish/frameworks/packages/integrations/agentkit/src/index.ts ·
  https://github.com/bursar-world/bursar/blob/bullish/frameworks/packages/integrations/agentkit/examples/pay.ts ·
  https://github.com/bursar-world/bursar/blob/bullish/frameworks/packages/integrations/agentkit/README.md
- LangChain: https://github.com/bursar-world/bursar/blob/bullish/frameworks/packages/integrations/langchain/src/index.ts ·
  https://github.com/bursar-world/bursar/blob/bullish/frameworks/packages/integrations/langchain/examples/pay.ts
- OpenAI Agents SDK: https://github.com/bursar-world/bursar/blob/bullish/frameworks/packages/integrations/openai-agents/src/index.ts ·
  https://github.com/bursar-world/bursar/blob/bullish/frameworks/packages/integrations/openai-agents/examples/pay.ts
- AI SDK: https://github.com/bursar-world/bursar/blob/bullish/frameworks/packages/integrations/ai-sdk/src/index.ts ·
  https://github.com/bursar-world/bursar/blob/bullish/frameworks/packages/integrations/ai-sdk/examples/pay.ts
- Branch diff: https://github.com/bursar-world/bursar/compare/main...bullish/frameworks
- npm, after the publish: `@bursar/toolset`, `@bursar/agentkit`, `@bursar/langchain`, `@bursar/openai-agents`,
  `@bursar/ai-sdk`
- AgentKit contribution: `docs/bullish/frameworks-agentkit.patch` until the pull request is open
- Transactions: the four in the table above, on robinhoodchain.blockscout.com
- Console: https://app.bursar.world/console/0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c/settlements

## Post assets

Under `docs/bullish/frameworks/`, all 1440×900, no keys in frame, real figures:

- `01-agentkit.png`, `02-langchain.png`, `03-openai-agents.png`, `04-ai-sdk.png`: each example's terminal
  output paying for real (the key shows as `0x…` on the command line).
- `05-console-settlement.png`: the console's settlements page with the AI SDK payment as its newest row.
- `demo.webm`: 45 s, the settlements page while the AI SDK example pays 0.05 USDG, "Check again", and the row
  landing (Playwright `recordVideo`).

## Limits

- The examples invoke the tools directly; no model is in the loop and no model key was spent. The READMEs show
  the model wiring for each framework, and that wiring is the framework's own `tools` option.
- `settlements` lists what this toolset instance paid, read live from the escrow, or one id on request. It does
  not index the mandate's whole history; the MCP server does that through the Blockscout index.
- The per-agent cap lives in memory for the life of the toolset instance. A restart resets it, and refunds are
  not credited back. The mandate's limits in the contract are the hard ones.
- AgentKit 0.10.4 pins viem 2.38.3 and the toolset uses 2.56.3. The adapter never shares a viem account across
  the two; it hands the SDK a wallet client that sends through the wallet provider. The example casts the
  wallet client once where the two viem copies' types meet. AgentKit also reports wallet creation to Coinbase
  without awaiting the call; that endpoint answers 400 from here, so the example warns and carries on.
- The upstream patch compiles against the published 0.10.4 interface in the adapter but was not built inside
  the `coinbase/agentkit` monorepo on this machine (its install is large and the disk was tight). Upstream
  `master` is at 0.11.0 unreleased with the same `ActionProvider` and `CreateAction` shapes.
- During the AgentKit wiring, two spends (0.25 and 0.10 USDG) were refused in simulation with empty revert
  data, minutes apart from spends that settled through the same contracts. The tool returned the SDK's sentence
  and nothing was sent or charged. It did not recur in the runs above.
- The OpenAI Agents adapter runs tools in strict mode, so optional arguments are carried as nullable and a
  model sends `null` for the ones it leaves out.
- Nothing in the console changed, so `apps/web` was neither rebuilt nor typechecked.

## Announcement

**One line**

Agents built with Coinbase's AgentKit, LangChain, the OpenAI Agents SDK or Vercel's AI SDK can now spend from a
Bursar mandate with one import.

**One paragraph** (under the screenshot)

Bursar now ships as a tool for four agent frameworks: Coinbase's AgentKit, LangChain, the OpenAI Agents SDK and
Vercel's AI SDK. Install `@bursar/agentkit`, `@bursar/langchain`, `@bursar/openai-agents` or `@bursar/ai-sdk`,
point it at a mandate, and the agent gets four tools: inspect what it may spend, quote a payment before making
it, pay a provider into escrow, and follow the settlement. The limits live in a contract on Robinhood Chain, so a
payment past the per-call, daily or monthly cap fails on chain, however the agent was prompted. Every package
comes with an example that pays a real provider in cents; the four runs above settled on mainnet for 0.37 USDG
in total.

**One post**

Bursar inside AgentKit, LangChain, the OpenAI Agents SDK and Vercel's AI SDK

An agent that buys things needs a budget it cannot talk itself past. A Bursar mandate is that budget: a contract
on Robinhood Chain holding USDG and the limits the agent spends inside, per call, per day, per month, for named
providers and capabilities. The mandate is now one import away in four frameworks agents are commonly built with.

```
npm install @bursar/agentkit        # Coinbase AgentKit action provider
npm install @bursar/langchain       # LangChain.js tools
npm install @bursar/openai-agents   # OpenAI Agents SDK function tools
npm install @bursar/ai-sdk          # Vercel AI SDK tools
```

Each package gives the agent the same four tools. `inspect` reads the mandate: what is left today, what is left
this month, the amount above which a person has to sign. `quote` asks the mandate about one payment before making
it and names the limit that would stop it. `pay` locks the amount in escrow for the provider; the provider is
paid when it delivers by the deadline, and the money returns to the mandate if it does not. `settlements` follows
what the agent paid for. Every answer is a sentence the model can act on, and every refusal says why.

Two things set this apart from a spending rule in a prompt. The limits are enforced by the contract, so a payment
outside them fails on chain whatever the model was told. And each agent gets its own cap on top of the mandate,
set in code, so one runaway loop cannot drain what the rest of the team shares.

Every package ships an example that pays the demo provider from a live mandate. The four runs behind this post
settled on Robinhood Chain for 0.37 USDG in total, and the settlements are on the mandate's console page.

Docs and the console: bursar.world.

## Progress

- 15:20Z read the rules, the SDK README and `mandateAccount` API, the MCP tool semantics, upstream
  `coinbase/agentkit` (cloned to `/tmp/agentkit`), and the earlier AgentKit provider pattern.
- 15:30Z five packages scaffolded under `packages/integrations`, workspace and `.gitignore` updated, framework
  pins chosen under the three-day window, install done (five build scripts of AgentKit's dependencies listed
  as off in `pnpm-workspace.yaml`).
- 15:45Z toolset written: four tools, cap, job table, keystore reader; 20 tests green; built.
- 16:00Z four adapters written and typechecked against the real packages; tests against fake toolsets green.
- 16:15Z examples written; LangChain example paid 0.25 USDG on mainnet (settlement 34).
- 16:20Z to 16:50Z AgentKit signer moved from `toSigner()` to the wallet provider's `sendTransaction`;
  diagnostics 37 and 38 settled; READMEs written.
- Session cut by a rate limit; resumed 20:30Z. State checked, tests re-run green, two commits made.
- 20:35Z AgentKit (40), OpenAI Agents (41) and AI SDK (42) examples paid on mainnet; the AI SDK run recorded
  against the console.
- 20:45Z terminal and console screenshots rendered, upstream patch written and exported, this doc written.
