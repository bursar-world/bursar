# Cloudflare provider

**Any Cloudflare Worker charges agents through Bursar, one command to deploy.**

A Worker wraps its fetch handler in `withBursar`, names a price per route, and deploys with
`wrangler`. An agent that calls a priced route without paying gets a 402 with the price in USDG on
Robinhood Chain. One that pays from its Bursar mandate gets the result, the payment lands in escrow
for the provider, and the mandate's limits hold on chain. The demo Worker is deployed at
<https://bursar-provider.bursar.workers.dev>; the first paid calls against it ran on 2026-10-11 for
0.01 USDG each, after a day of the same calls under `wrangler dev`.

Cloudflare is named as the hosting the Worker runs on. There is no partnership, listing or
endorsement, and the copy says none.

## What is live and what is prepared

Live on the branch, tests green:

- `packages/provider-worker`, published as `@bursar/provider-worker` 0.1.0 on npm. `withBursar(handler)` answers 402 with the offer (both x402 versions), verifies a
  presented payment with the facilitator, serves the route, settles, reports the settlement in the
  response headers, and with the provider's key as a secret releases the escrow lock after the
  response is sent. Configuration is by environment: `BURSAR_PROVIDER`, `BURSAR_CAPABILITY`,
  `BURSAR_PRICES`, `BURSAR_FACILITATOR_URL`, `BURSAR_FACILITATOR_TOKEN`, `BURSAR_PROVIDER_KEY`,
  `BURSAR_RPC_URL`, `BURSAR_SCHEMES`. Sixteen tests run the bundled worker on `workerd` through
  Miniflare with the facilitator and the chain standing in, including the release transaction
  decoded back to `release(lockId, keccak256(served bytes), '')` on the lock's escrow.
- `templates/cloudflare-worker`: a wrangler project with one priced route, `POST /render` at
  0.01 USDG, a README, and `scripts/pay.ts`, the agent side, which pays the Worker once from a
  mandate with `@bursar/sdk`.
- `packages/create-provider`, published as `@bursar/create-provider` 0.1.0 on npm: `npm create @bursar/provider
  my-api` (or `npx @bursar/create-provider my-api`) copies the template, names the Worker after the
  directory and prints the next commands. Its build copies the template in and pins the published
  versions.
- The console: a "Charge from a Cloudflare Worker" card on the Developers page under Charging
  agents, on the provider desk for a connected provider, and on the providers page for a visitor.
  `apps/web` typechecks, its tests pass, and `next build` completes.

Deployed on 2026-10-11:

- The demo Worker, `bursar-provider`, on the account's `bursar.workers.dev` subdomain (registered the
  same day; the first TLS certificate for the subdomain took about ninety seconds to arrive). One
  `wrangler deploy` from `templates/cloudflare-worker`, then the facilitator token as a Workers
  secret. The Worker holds no provider key: the demo releases each lock from the ops script, which
  is also what the sidecar does.

## The demo

Real payments from the live example mandate `0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c` to the
demo provider `0x5210D8df060A9D5ce4c1305045ED5c9548fca374`, through the hosted facilitator, each
0.01 USDG, each released by the provider. Against the deployed Worker on 2026-10-11:

| Step | Transaction |
|---|---|
| Lock 57 opened by the mandate's `spend` for the first call to the public URL | [`0x74b1d3ae…6c1499`](https://robinhoodchain.blockscout.com/tx/0x74b1d3ae19feb591fdfdd8ee2120a58bf6fd674edf69018814fac465c26c1499) |
| Lock 57 released by the provider, block 85918921 | [`0x1558f06b…36d2ac`](https://robinhoodchain.blockscout.com/tx/0x1558f06b2ca64b00c6880293dcdeaef586a8d9f71e9dd6aff859c286d636d2ac) |
| Lock 59 opened for the filmed call | [`0x372a1edf…f74a2e`](https://robinhoodchain.blockscout.com/tx/0x372a1edfa91a13fd8bda7ded93a0f9ef785ddb859a6d84932375cee501f74a2e) |
| Lock 59 released, block 85921425 | [`0x69f14705…b5fb65`](https://robinhoodchain.blockscout.com/tx/0x69f14705589215df0554bab280826bd0b71812b9839b2f53345f83ba31b5fb65) |

A day earlier, against the same Worker under `wrangler dev` on the build machine:

| Step | Transaction |
|---|---|
| The principal allows `service:render:1` on the example mandate | [`0x370cb271…9412c9`](https://robinhoodchain.blockscout.com/tx/0x370cb271ff08ddcbe9de250837ff1fc26a269c5c4f40b859f221edd37d9412c9) |
| Lock 32 opened by the mandate's `spend` for the first paid call | [`0x47930b5c…31bf40`](https://robinhoodchain.blockscout.com/tx/0x47930b5ce9111a0c7cc8746afabb97aed93d8ada93fd93deafaacad4f431bf40) |
| Lock 32 released by the provider, block 85109401 | [`0x4b038d25…1a34c4`](https://robinhoodchain.blockscout.com/tx/0x4b038d25583ecc2201c9baac1b43b9ea8d2dddce3f4f2d6051afdaf9ef1a34c4) |
| Lock 35 opened for the filmed call | [`0x0d2ed14e…d47074`](https://robinhoodchain.blockscout.com/tx/0x0d2ed14efd468ba606b67f63f3d4b06b4d58ac37cd20c1aea9e077a012d47074) |
| Lock 35 released, block 85111713 | [`0x0ee26117…bc7ded`](https://robinhoodchain.blockscout.com/tx/0x0ee261177d37f3bec9279474fadc973250c04d57d51798db7b60d926f9bc7ded) |

The facilitator's `/verify` read each lock and answered valid with the mandate as payer; `/settle`
recorded each once and broadcast nothing, which is how the escrow scheme settles. The mandate's
balance and its daily window each moved by exactly 0.01 per call (2.434620 to 2.424620 USDG on the
first; 2.17 to 2.16 on the filmed one, other demos having spent from the same mandate in between).
The provider received 0.0099 USDG per call after the escrow's fee. The public calls moved the
mandate from 1.849749 to 1.839749 USDG on the first and 1.84 to 1.83 on the filmed one. Spend for the
build and the deployment: 0.05 USDG and about 0.0001 ETH in fees, inside the limits.

Every lock shows on the public desk at
<https://app.bursar.world/providers/0x5210D8df060A9D5ce4c1305045ED5c9548fca374> as paid.

### Running it

Against the deployed Worker, an unpaid call and then the paid one:

```
curl -i -X POST https://bursar-provider.bursar.workers.dev/render -H 'content-type: application/json' -d '{"prompt":"a koi"}'
cd ~/Projects/bursar-ops/ops/e2e && npx tsx src/cloudflare-pay.ts https://bursar-provider.bursar.workers.dev/render
```

The Worker, locally:

```
cd templates/cloudflare-worker
printf 'BURSAR_FACILITATOR_TOKEN=%s\n' "$FACILITATOR_AUTH_TOKEN" > .dev.vars
npx wrangler dev
curl -i -X POST http://127.0.0.1:8787/render -H 'content-type: application/json' -d '{"prompt":"a koi"}'
```

The agent, from a mandate whose principal allows the capability:

```
MANDATE=0x… AGENT_KEY=0x… npx tsx scripts/pay.ts http://127.0.0.1:8787/render
```

The proof above used the keystore wrapper in the ops checkout, which pays the same way and then
releases the lock with the payee key, the sidecar's job when the Worker runs without one:
`cd ~/Projects/bursar-ops/ops/e2e && npx tsx src/cloudflare-pay.ts http://127.0.0.1:8787/render`.
The film came from `npx tsx film/cloudflare-film.ts <url> <out dir>` in the same place.

## What the operator must do

1. **Done 2026-10-10:** both packages are on npm (`@bursar/provider-worker` 0.1.0, `@bursar/create-provider`
   0.1.0). The commands that published them:
   ```
   pnpm --filter "@bursar/provider-worker..." build && pnpm --filter @bursar/provider-worker test
   cd packages/provider-worker && pnpm publish --access public --no-git-checks
   cd ../create-provider && pnpm build && pnpm publish --access public --no-git-checks
   ```
   `create-provider`'s `prepack` copies the template in and pins `@bursar/provider-worker` to the
   version just published. Publish the worker package first.
2. **Done 2026-10-11: the demo Worker is deployed.** The Cloudflare token now carries Workers
   Scripts: Edit on the account (`c84ce11d1231d37151f0c11619349a14`, the one that owns
   `bursar.world`). The account had no `workers.dev` subdomain, so `bursar` was registered through
   the API (`PUT /accounts/{id}/workers/subdomain`), then from `templates/cloudflare-worker`:
   ```
   npx wrangler deploy                                  # https://bursar-provider.bursar.workers.dev
   npx wrangler secret put BURSAR_FACILITATOR_TOKEN     # the hosted facilitator's provider token
   ```
   The Worker holds no `BURSAR_PROVIDER_KEY`; put the payee key there to have it release each lock
   itself, and keep a little ETH at the payee address for fees. For a custom route such as
   `api.bursar.world`, add a Workers Route on the zone; the token covers the record.
3. **Done 2026-10-11: paid once against the public URL** (lock 57, then lock 59 for the film), with
   `npx tsx src/cloudflare-pay.ts https://bursar-provider.bursar.workers.dev/render` from
   `~/Projects/bursar-ops/ops/e2e`. The transactions are in the table above.
4. **Done:** the branch is merged into `main` and the console is deployed from it.
5. **Facilitator tokens.** The hosted facilitator answers providers that hold the one provider
   token. A third party who deploys this needs one; decide whether to hand out the shared token, run
   a token per provider, or open `/verify` and `/settle` to the public.

No governance action: the registry entry and the capability were already in place or sent from
the demo keys.

## Honest limits

- The deployed Worker is a demo: a stub render at 0.01 USDG, on the shared `workers.dev` subdomain,
  with no provider key, so a payment to it is released from the ops script rather than by the
  Worker itself.
- The hosted facilitator requires a bearer token on `/verify` and `/settle`. Until that changes, a
  stranger who deploys the template cannot settle without asking for a token.
- Releasing the lock is what pays the provider. In the Worker that needs the provider's key as a
  Workers secret; the demo kept the key out of Cloudflare and released from the ops script instead,
  which is also what the sidecar does. Release fees are ETH from the provider's address.
- Prices are a static table per method and path. A price that depends on the request body is not
  supported.
- To commit to what it served, the Worker reads the response body in full before releasing, so a
  large or streaming response is buffered once.
- A settle the facilitator does not answer is reported to the agent as `settlement_unconfirmed`,
  and the agent's SDK treats that as a failed payment. On the escrow scheme nothing was broadcast
  at settle, so a retry opens a second lock; the first returns at its deadline.
- The payee's record on the desk counts these calls as "paid, still contestable" for the dispute
  window and "not yet recorded" after it; recording is a separate call anyone can make.

## Links

- Package: <https://github.com/bursar-world/bursar/blob/bullish/cloudflare-provider/packages/provider-worker/README.md>
  (`packages/provider-worker/src/middleware.ts` is the handler)
- Scaffolder: <https://github.com/bursar-world/bursar/blob/bullish/cloudflare-provider/packages/create-provider/src/cli.ts>
- Template: <https://github.com/bursar-world/bursar/blob/bullish/cloudflare-provider/templates/cloudflare-worker/README.md>
- Console copy: <https://github.com/bursar-world/bursar/blob/bullish/cloudflare-provider/apps/web/src/components/worker-quickstart.tsx>
- Branch diff: <https://github.com/bursar-world/bursar/compare/main...bullish/cloudflare-provider>
- Merged into `main`; the console on app.bursar.world is deployed from it.
- npm: https://www.npmjs.com/package/@bursar/provider-worker · https://www.npmjs.com/package/@bursar/create-provider
- Worker URL: <https://bursar-provider.bursar.workers.dev> (`POST /render`, 0.01 USDG)
- Provider desk: <https://app.bursar.world/providers/0x5210D8df060A9D5ce4c1305045ED5c9548fca374>
- Transactions: the five in the table above, on robinhoodchain.blockscout.com

## Screenshots and recording

Under `docs/bullish/cloudflare-provider/`, 1440×900, no keys in frame:

- `01-deploy.png`: the real `wrangler deploy`, the secret going in, and the deployed Worker
  answering 402 to an unpaid `curl`.
- `02-402.png`: the agent's terminal reading the 402 from the public URL: 0.01 USDG, the provider,
  the capability, the two schemes.
- `03-paid.png`: the mandate pays, lock 59 opens, the Worker answers 200, the settlement reports
  the payer, the provider releases, the mandate's balance and window move by 0.01.
- `04-desk.png`: the provider desk listing locks 59, 58 and 57 as paid.
- `05-receipt.png`: the release transaction on the explorer, 0.0099 USDG from the escrow to the
  provider.
- `demo.webm`: 44 seconds, the filmed call against the deployed Worker from 402 to release, then
  the desk and the receipt.

![The mandate pays the Worker and the provider releases](cloudflare-provider/03-paid.png)

A Cloudflare Worker can now charge agents for a route. Install `@bursar/provider-worker`, wrap the
fetch handler, put a price on the route in `wrangler.toml` and deploy. An agent that calls the route
without paying gets a 402 with the price in USDG. One that pays from its Bursar mandate gets the
result, the payment lands in escrow for the provider on Robinhood Chain, and the mandate's limits
hold on chain. The first paid calls to a deployed Worker ran today at $0.01 each, lock, settlement
and release on the chain. `npm create @bursar/provider my-api` writes the whole project.

## Announcement

**One line.** Any Cloudflare Worker can now charge AI agents per call through Bursar: add one
package, set a price, deploy with wrangler.

**One paragraph.** A Cloudflare Worker can now charge agents for a route. Install
`@bursar/provider-worker`, wrap the fetch handler, put a price on the route in `wrangler.toml` and
deploy. An agent that calls the route without paying gets a 402 with the price in USDG. One that
pays from its Bursar mandate gets the result, the payment lands in escrow for the provider on
Robinhood Chain, and the mandate's limits hold on chain. The first paid calls to a deployed Worker
ran today at $0.01 each, lock, settlement and release on the chain. `npm create @bursar/provider
my-api` writes the whole project.

**One post.**

Charge agents from a Cloudflare Worker.

Workers are where a lot of small APIs live. From today one of them can take payment from an AI
agent per call, settled through Bursar on Robinhood Chain.

```
npm create @bursar/provider my-api
cd my-api && npm install
npx wrangler secret put BURSAR_FACILITATOR_TOKEN
npx wrangler deploy
```

That gives you a Worker with one priced route, `POST /render` at 0.01 USDG. Set your provider
address, the capability and the prices in `wrangler.toml`. An existing Worker takes the same
route: install `@bursar/provider-worker`, wrap the fetch handler in `withBursar`, and price routes
with `BURSAR_PRICES`. Routes without a price pass through as before.

What an agent sees: a 402 with the price, payable from its mandate. The mandate pays by locking
the amount in escrow for you, inside the limits its principal set, and the call goes through. You
are paid when the lock is released, which the Worker does itself once it holds your key.

Today's first calls, against a Worker on workers.dev: an agent paid 0.01 USDG for a render, the
Worker answered, the payment settled and the provider released. Lock, settlement and release are on
the chain: robinhoodchain.blockscout.com/tx/0x69f14705589215df0554bab280826bd0b71812b9839b2f53345f83ba31b5fb65.

Docs and the template: app.bursar.world/docs.

## Progress

- 15:20 UTC. Read the rules, the x402 package, the facilitator's escrow lane and the mainnet proof.
  Tested the Cloudflare token against the API: DNS only; Workers upload refused. Decided to build
  the Worker library self-contained on `@bursar/core` and `viem`, test on `workerd` through
  Miniflare, and run the demo under `wrangler dev`.
- 16:35 UTC. Library written and built. Sixteen tests on `workerd` green, including the decoded
  release transaction. Bundle 463 KB, 136 KB compressed.
- 17:40 UTC. Template under `wrangler dev` answered 402; first real payment from the example
  mandate settled through the hosted facilitator and the provider released lock 32. Scaffolder and
  its tests green. First commit.
- 17:45 UTC. Console copy on the Developers page, the provider desk and the providers page, with a
  test. Filmed the second call (lock 35) with the desk and the receipt; screenshots taken.
- 2026-10-11 15:00 UTC. The Cloudflare token gained Workers Scripts: Edit; registered the `bursar` workers.dev subdomain, deployed the template Worker, set the facilitator token, paid it from the example mandate (lock 57) and refilmed the flow against the public URL (lock 59). Frames and film replaced; the receipt frame now waits for the explorer's transfer row.
