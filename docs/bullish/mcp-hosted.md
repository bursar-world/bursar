# Bullish build 4 · ChatGPT, Claude and Gemini spend from a mandate

**The sentence:** give ChatGPT, Claude or Gemini a budget, and it pays for work inside your limits.

Branch `bullish/mcp-hosted`, cut from `main` at `7f8d6e8`. Chain 4663, record `rhc-mainnet-v6`.

## What is live and what is prepared

Live on the branch, run end to end against mainnet on 2026-10-10:

- `services/mcp-host`: the hosted form of `@bursar/mcp`. Streamable HTTP from `@modelcontextprotocol/sdk` 1.32, one
  bearer token per connection, each token bound to one mandate and one agent key the host generated for it. Keys are
  sealed with AES-256-GCM under an operator-held key-encryption key (`MCP_HOST_KEK`), with the chain, mandate and
  agent address bound in as associated data. Tokens are stored as SHA-256 only and never logged. Rate limits per
  token (120 a minute by default) and per owner (20 new connections an hour). `/healthz` and `/readyz`. Postgres
  with its own migration journal, so it can share an instance with the facilitator or have its own.
- The ownership proof: the console builds a plain message (`assistantConnectMessage` in `@bursar/sdk`), the wallet
  signs it, the host rebuilds the text, recovers the signer and checks it against the mandate's `principal` on chain.
  One signature opens one connection; a signature older than ten minutes is refused.
- The console: on a mandate's page, **Assistants**. Create a connection (one signature, no transaction), seat the agent
  the host made (the existing `setAgent` transaction), give it a little ETH for fees, copy the token once, and the
  connector settings for ChatGPT, Claude, Claude Code and Gemini CLI with the endpoint and token filled in. Disconnect
  from the same panel. The panel says who holds the key and what bounds it.
- `/demo/assistants`: the three connector setups with exact steps, and the real run below with its transactions.
- The stdio server is unchanged: `packages/mcp` keeps its 524 tests green; one export was added (`checkMandate`).

Prepared, not yet exercised:

- The public endpoint `mcp.bursar.world`. The run below used a host on this Mac against mainnet. ChatGPT's and
  Claude's connector forms need a public HTTPS address, so those two were not driven end to end; Claude Code was,
  through the same transport and the same token. The settings shown for ChatGPT and Claude follow their current
  connector forms (a URL, no header), with the token in the URL path and the panel saying so.

## The demo

Mandate `0x47F1f569F84fe0806846AD578FF1E85cfAFd3F34`, owned by the film owner key, created with 0.50 USDG a
payment, 1.00 a day, 5.00 a month, approvals from 0.50, services only, provider
`0x5210D8df060A9D5ce4c1305045ED5c9548fca374` and capability `gpu.render:1` allowed, funded with 0.30 USDG.

1. The owner signed the connection message; the host made agent `0x5EC462dc794fffB2B7bbd888174Ce237D056F10B`,
   sealed its key, and answered the token once.
2. The owner seated that agent (`0x418a957c…c6f7c3e4`) and sent it 0.0001 ETH for fees (`0x96c370cd…9f84ad07`).
3. Claude Code was connected with `claude mcp add --transport http bursar http://127.0.0.1:8410/mcp --header
   "Authorization: Bearer …"` and asked: *Pay 0.25 USDG to 0x5210…a374 for gpu.render:1, with a day to deliver.
   Quote it first, then pay.* It called `mandate_quote_spend` (allowed, no approval needed), then
   `mandate_pay_provider`. Settlement 39, held in escrow until the provider delivers or the day runs out.
4. The payment: `0x09d2d3717c3f169de1ab6016d9e94cce515b7b00a80b83da7fd59238963e56c5`, block 85282502, sent by
   the hosted agent to the mandate, which locked 0.25 USDG in the escrow for the provider. The console's Recent
   activity shows "Payment 39: $0.25 to 0x5210…a374 for gpu.render:1" fifteen seconds later (`demo.webm`).

Spent: 0.30 USDG from the payer key into the mandate (0.25 of it locked for the provider, 0.05 left in the mandate),
and about 0.0003 ETH in all across creation, two gates, seating, the fee float and the payment.

### Running it yourself

A Postgres on this Mac, the chain through Chainstack, the host on 8410, the console on 4310:

```
createdb bursar_mcp_host
cat > ~/.config/bursar/mcp-host.local.env <<'ENV'
MCP_HOST_KEK=<node -e "console.log('0x'+require('node:crypto').randomBytes(32).toString('hex'))">
MCP_HOST_PORT=8410
MCP_HOST_PUBLIC_URL=http://127.0.0.1:8410
DATABASE_URL=postgres://<you>@127.0.0.1:5432/bursar_mcp_host
RHC_RPC_FALLBACK=https://robinhood.drpc.org
ENV
pnpm --filter @bursar/mcp-host... build
set -a; source ~/.config/bursar/mcp-host.local.env; source ~/.config/bursar/chainstack.env; set +a
RHC_RPC_PRIMARY=$CHAINSTACK_RHC_RPC_URL node services/mcp-host/dist/main.js
```

The owner's side from a terminal (creates the mandate, allows the provider and the capability, funds it, opens the
connection, seats the agent, sends the fee float, writes the token to `BURSAR_DEMO_OUT`):

```
source ~/Projects/bursar-ops/ops/rhc-env.sh
cd services/mcp-host
BURSAR_DEMO_OWNER_KEYSTORE=~/.config/bursar/keystore/film-owner \
BURSAR_DEMO_FUNDER_KEYSTORE=~/.config/bursar/keystore/payer \
MCP_HOST_URL=http://127.0.0.1:8410 RHC_RPC_PRIMARY=$CHAINSTACK_RHC_RPC_URL \
BURSAR_DEMO_OUT=~/.config/bursar/mcp-hosted-demo.json npx tsx scripts/demo.ts
```

Or from the console: `BURSAR_MCP_HOST_URL=http://127.0.0.1:8410 pnpm --filter @bursar/web dev`, open the mandate,
**Assistants**, **Create connection**. Then the assistant:

```
claude mcp add --transport http bursar http://127.0.0.1:8410/mcp --header "Authorization: Bearer <token>"
claude -p "Pay 0.25 USDG to 0x5210D8df060A9D5ce4c1305045ED5c9548fca374 for gpu.render:1, with a day to deliver. Quote it first, then pay."
```

Tests: `pnpm --filter @bursar/mcp-host test` (21, the store against a real Postgres when
`BURSAR_TEST_DATABASE_URL` is set), `pnpm --filter @bursar/sdk test` (the message builder), `pnpm --filter
@bursar/mcp test` (stdio unchanged), `pnpm --filter @bursar/web test` (the panel, the connector settings, the route).

## What the operator must do

Provisioning on Render, in this order:

1. **Database.** Either a new database on the existing Postgres instance (the host writes `bursar_mcp_connections`
   and its own journal `bursar_mcp_migrations`, nothing the facilitator touches) or a new Render Postgres. Put its
   URL in `DATABASE_URL` with `sslmode=require`.
2. **The key-encryption key.** Generate 32 bytes: `node -e "console.log('0x'+require('node:crypto').randomBytes(32).toString('hex'))"`.
   Store it in the ops keystore beside the signing keys, then paste it into the service's environment as
   `MCP_HOST_KEK`. It seals every agent key the host makes. Losing it makes every connection unreadable, so it is
   backed up like a key; leaking it opens every agent key in the database, so it is held like one. Rotation is a
   re-seal of every row under the new key, which this build does not ship (see limits): until it does, a rotation
   means owners reconnect their assistants.
3. **The service.** A Render web service from the monorepo: build `pnpm install --frozen-lockfile && pnpm --filter
   @bursar/mcp-host... build`, start `node services/mcp-host/dist/main.js`, health check `/healthz`, one instance.
   Environment: `MCP_HOST_HOST=0.0.0.0`, `MCP_HOST_PORT=10000`, `MCP_HOST_PUBLIC_URL=https://mcp.bursar.world`,
   `MCP_HOST_MIGRATE=on-start`, `RHC_RPC_PRIMARY` (Chainstack), `RHC_RPC_FALLBACK=https://robinhood.drpc.org`,
   `BLOCKSCOUT_API_KEY`, `DATABASE_URL`, `MCP_HOST_KEK`. Nothing else: the host refuses a key or a relay URL in
   its environment.
4. **The domain.** `mcp.bursar.world` as a custom domain on that service (CNAME to the Render hostname; Render
   issues the certificate).
5. **The console.** Set `BURSAR_MCP_HOST_URL=https://mcp.bursar.world` on the console's service and redeploy. Until
   it is set the Assistants panel says hosted connections are not available on this deployment.
6. **Push and merge.** Push `bullish/mcp-hosted`, open the pull request against `main` with the links below. No
   governance action, no new contract, no registry entry.

Funds: none beyond what a demo owner funds their own mandate with. The host holds no money.

## Honest limits

- Rate limits are counted in each process. Two instances double the ceiling; the mandate's own limits are what
  bound spending, so this is a ceiling on abuse, not a quota.
- No key-encryption key rotation tool yet. A `reseal` command that opens every row under the old key and seals it
  under the new one is the next piece of work on this service.
- ChatGPT's and Claude's connector forms take a URL and no header, so for them the token travels in the URL. The
  panel says so and offers the bearer form for Claude Code and Gemini CLI. OAuth for those two connectors is not
  built; both accept a connector with no authentication.
- ChatGPT and Claude (the apps) were not driven end to end: they need a public endpoint, which exists once the
  operator provisions `mcp.bursar.world`. Claude Code was, over the same transport.
- The endpoint is stateless: one MCP server per request, JSON responses, no server-initiated notifications and no
  stream resumption. Every client named here works that way.
- The agent address needs ETH for fees. The panel offers a 0.0005 ETH top-up from the owner's wallet; nothing
  tops it up on its own.
- An assistant can read the limits, quote, pay, hire, follow and contest, as the stdio server allows; it cannot
  change limits or withdraw, because the agent key cannot. Payments at or above the approval threshold still need
  the owner's signed approval, as for any agent.

## Links

Files on the branch:

- https://github.com/bursar-world/bursar/blob/bullish/mcp-hosted/services/mcp-host/src/http.ts (the listener and the MCP endpoint)
- https://github.com/bursar-world/bursar/blob/bullish/mcp-hosted/services/mcp-host/src/connections.ts (opening, answering and cutting connections)
- https://github.com/bursar-world/bursar/blob/bullish/mcp-hosted/services/mcp-host/src/crypto.ts (tokens and sealing)
- https://github.com/bursar-world/bursar/blob/bullish/mcp-hosted/services/mcp-host/src/proof.ts (the ownership proof)
- https://github.com/bursar-world/bursar/blob/bullish/mcp-hosted/services/mcp-host/src/store.ts
- https://github.com/bursar-world/bursar/blob/bullish/mcp-hosted/services/mcp-host/migrations/0001_connections.sql
- https://github.com/bursar-world/bursar/blob/bullish/mcp-hosted/services/mcp-host/README.md
- https://github.com/bursar-world/bursar/blob/bullish/mcp-hosted/services/mcp-host/scripts/demo.ts
- https://github.com/bursar-world/bursar/blob/bullish/mcp-hosted/packages/sdk/src/assistant.ts (the signed message)
- https://github.com/bursar-world/bursar/blob/bullish/mcp-hosted/apps/web/src/app/(app)/console/%5Bmandate%5D/assistant-panel.tsx
- https://github.com/bursar-world/bursar/blob/bullish/mcp-hosted/apps/web/src/app/(app)/console/%5Bmandate%5D/connector-settings.tsx
- https://github.com/bursar-world/bursar/blob/bullish/mcp-hosted/apps/web/src/app/(app)/console/lib/assistants.ts
- https://github.com/bursar-world/bursar/blob/bullish/mcp-hosted/apps/web/src/app/api/assistants/route.ts
- https://github.com/bursar-world/bursar/blob/bullish/mcp-hosted/apps/web/src/app/(app)/demo/assistants/page.tsx
- Branch diff: https://github.com/bursar-world/bursar/compare/main...bullish/mcp-hosted

The live thing, once merged and provisioned: `https://app.bursar.world/demo/assistants` and `https://mcp.bursar.world`.
The published stdio server stays at https://www.npmjs.com/package/@bursar/mcp.

On chain:

- The mandate: https://robinhoodchain.blockscout.com/address/0x47F1f569F84fe0806846AD578FF1E85cfAFd3F34
- Created: https://robinhoodchain.blockscout.com/tx/0x60bd51796cf4390a01c9979c98578585e4857b6cb018e11084bbc69e3050e0cf
- Provider allowed: https://robinhoodchain.blockscout.com/tx/0x2361c9121ceeeb2b408691c8555405556f261aa5324e4851b7f3a1e163eed708
- Capability allowed: https://robinhoodchain.blockscout.com/tx/0x57e49b4bc045f9d362001e7d8205a928eae3968580aabf286ed627338df1afe5
- Funded: https://robinhoodchain.blockscout.com/tx/0xa522aed0de5647138dd30be7f13d5131d4952c40ef4b1fc4acf317a93431342f
- Agent seated: https://robinhoodchain.blockscout.com/tx/0x418a957c134ba373da90e3b64eb74721dabef9df86778b9bd77c767bc6f7c3e4
- Fee float: https://robinhoodchain.blockscout.com/tx/0x96c370cd0a46d7f87460c4ae8434b3a57ed523aaba731d0620422d9a7f84ad07
- The assistant's payment: https://robinhoodchain.blockscout.com/tx/0x09d2d3717c3f169de1ab6016d9e94cce515b7b00a80b83da7fd59238963e56c5

## Screenshots and recording

In `docs/bullish/mcp-hosted/`, 1440×900, from the console on this Mac as the film owner, tokens masked:

- `01-connect.png`: the Assistants panel on the mandate, with Claude Code seated and the form to connect another.
- `02-created.png`: a connection just made: the agent the host made, the seat transaction, the fee float.
- `03-connector-chatgpt.png`: the token shown once and the ChatGPT connector settings.
- `04-connector-claude-code.png`: the Claude Code command.
- `05-disconnected.png`: the connection cut from the same panel.
- `06-assistant-pays.png`: the Claude Code session that quoted and paid through the hosted endpoint, rendered from
  its transcript: the prompt, the two tool calls with their real values, and its reply word for word.
- `07-receipt.png`: the payment on the explorer.
- `demo.webm`: 56 seconds of the mandate page while the assistant pays; "Payment 39: $0.25 to 0x5210…a374 for
  gpu.render:1" lands in Recent activity.

## The announcement

**One line.** Give ChatGPT, Claude or Gemini a budget: connect it from a mandate's page and it pays for work inside
your limits.

**One paragraph.** Bursar mandates now take assistants. From a mandate's page, sign once, seat the agent the host
makes for your assistant, and paste one setting into ChatGPT, Claude or Gemini. From then on it can pay providers
from that budget. The mandate account on Robinhood Chain enforces the limits: the most per payment, per day and
per month, who may be paid and for what. A payment outside them does not settle, whatever the assistant was told.
Pause or revoke from the console and it spends nothing.

**One post.** Give ChatGPT, Claude or Gemini a budget, and it pays for work inside your limits.

Bursar's MCP server now runs hosted, so an assistant with no machine of its own can use it. From a mandate's page
in the console you sign one message, seat the agent the host makes for your assistant, and paste one setting into
ChatGPT, Claude or Gemini CLI. The assistant can then read what is left, quote a payment, and pay a provider from
that budget.

The host holds that agent's key and nothing else. Your limits live in the mandate account on Robinhood Chain: the
most per payment, per day and per month, who may be paid and for what. A payment outside them does not settle,
whatever the assistant was asked. Pause the mandate or revoke the agent and it spends nothing. Disconnect the
assistant and its token stops answering.

Here is one run on mainnet: a mandate with 0.30 USDG and a 0.50 cap per payment, Claude Code connected to it, asked
to pay 0.25 USDG for a render. It quoted the payment, paid it, and the escrow holds the amount for the provider
until the work is delivered. The transaction: robinhoodchain.blockscout.com/tx/0x09d2d371…63e56c5. The setup, with
the steps for each assistant: app.bursar.world/demo/assistants.

## Progress

- 15:30Z · Read the rules and the code. Decided on a new service (`services/mcp-host`) over an HTTP mode inside
  `packages/mcp`: the published package stays a stdio server with no database or key store in it, and the host
  reuses its `createContext` per connection.
- 15:40Z · Host written and green: 21 tests, the store against the local Postgres 16.
- 15:44Z · Console panel, API routes and tests; 891 console tests green. Committed both.
- 15:46Z · Host up on this Mac against mainnet; demo mandate created, funded, connected and seated from the
  terminal script; Claude Code read the mandate over HTTP.
- Paused by an API limit; resumed 20:28Z.
- 20:35Z · Claude Code paid 0.25 USDG through the host (settlement 39). Recording and screenshots taken.
- 20:45Z · Demo page, docs, assets committed.
