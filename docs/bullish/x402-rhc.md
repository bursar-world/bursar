# x402 on Robinhood Chain, Bursar as the facilitator

**Any x402 agent can pay for Robinhood Chain services in USDG, settled by Bursar.**

x402 is the open payment standard where an API answers `402 Payment Required` with a price and the
client's retry carries a signed payment. Its reference packages (`@x402/core`, `@x402/evm`,
`@x402/fetch`, `@x402/express`, and the Go and Python SDKs) carry a table of networks and their
dollar stablecoins, and a client or server built on them can only pay or charge on a chain in that
table through a facilitator that settles there. Robinhood Chain (chain 4663) was in no table and
had no facilitator anyone could call. This update supplies both.

## What is live, what is prepared

| Piece | State |
|---|---|
| The `exact` scheme's standard profile in `@bursar/x402` | Built and tested on the branch. |
| Keyless routes `/x402/supported`, `/x402/verify`, `/x402/settle` on the facilitator | Built and tested on the branch. Verified against mainnet from a local run of the branch. Opens on `facilitator.bursar.world` when the operator sets one variable and deploys (below). Today the live service answers 401 to a keyless call. |
| Robinhood Chain for the reference SDKs, exported from `@bursar/x402` | Built and tested. The package is marked publishable; the operator publishes it. |
| The upstream change to the x402 default-asset tables | Written as `docs/bullish/x402-rhc.patch`, applies cleanly to x402-foundation/x402 main `f8f8330`. The operator opens the pull request. |
| The demo: a stock x402 client pays a Robinhood Chain endpoint in USDG | Ran on mainnet. One cent, settled in 1.08 s: [0xb29f…49ab](https://robinhoodchain.blockscout.com/tx/0xb29f4548ae08e4618aa85aeb71516b7ca9e34358d5b04ecd502e964bd3ed49ab). |

## The facts, read on 2026-10-10

USDG on Robinhood Chain, `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (from
`contracts/deployments/rhc-mainnet-v6.json`, `settlementAsset`), read through `robinhood.drpc.org`
at block 85,100,686:

- `name()` answers `Global Dollar`, `symbol()` `USDG`, `decimals()` 6. `version()` and
  `eip712Domain()` revert `FacetNotFound`: the token is a diamond and publishes no version.
- `DOMAIN_SEPARATOR()` answers `0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036`.
  The EIP-712 domain `{ name: "Global Dollar", version: "1", chainId: 4663, verifyingContract }`
  hashes to exactly that value; the same domain without a version does not. So the entry the
  reference tables need is name `Global Dollar`, version `1`.
- EIP-3009 is implemented on both overloads. `transferWithAuthorization` with `v, r, s`
  (selector `0xe3ee160e`, the one the reference facilitator calls for a 65-byte signature) and
  with `bytes signature` (selector `0xcf092995`, the one Bursar calls) each revert `InvalidSignature`
  on a dummy call, where a selector the token does not route reverts `FacetNotFound`.
  `receiveWithAuthorization`, `cancelAuthorization`, `authorizationState`, `permit`, `nonces`,
  `paused` and `isFrozen` route as well. The comment in `packages/x402/src/eip3009.ts` said USDG
  took only the bytes overload; it was wrong and is corrected on the branch.
- The settlement below went through the bytes overload and used 86,011 gas at 0.02004 gwei, a
  little under 0.0000018 ETH.

The reference implementation, read from x402-foundation/x402 at `f8f8330` (2026-10-10). The
coinbase/x402 repository is a development fork whose README sends issues and pull requests to the
foundation, and its last sync is from April; the patch targets the foundation.

- A client needs nothing per chain. `ExactEvmScheme` registered on `eip155:*` accepts an offer on
  `eip155:4663`, signs under `extra.name` and `extra.version` from the offer, and sets
  `validBefore` to the moment it signed plus the offer's `maxTimeoutSeconds`. One rule stands in
  the way: its spend controls refuse any asset outside the default table unless the client lists
  it under `allowedAssets`. One line, until the table carries USDG.
- A resource server needs the chain in the default table to price in dollars, or a money parser
  for the chain. The facilitator client calls `GET /supported`, `POST /verify` and
  `POST /settle` under one base URL and parses the responses with a schema; `extensions` and
  `signers` default when absent, `transaction` and `network` must be strings.
- The reference facilitator verifies the signature under the offer's domain, requires `validBefore`
  at least six seconds past the check, `validAfter` not in the future, and the value equal to the
  price. Bursar's provider routes require more: a payment bound to its request, and an
  authorisation that outlives the quoted work budget. A stock client can satisfy neither, which is
  why the keyless routes run a second profile.

## What was built

**`packages/x402`.** `createExactEvm` now carries a policy (`requireBinding`, `outlive`) and every
scheme has `standard()`: the same networks, assets and relayer under the protocol's rules, no
request binding and the six-second margin. `ROBINHOOD_CHAIN` exports the network and the asset in
the shape the reference tables keep; `usdgPrice("$0.01")` is an `AssetAmount` with the signing
domain; `robinhoodChainMoneyParser` plugs into `ExactEvmScheme.registerMoneyParser` on the
reference server; `usdgSpendControl("$1")` is the `allowedAssets` line a stock client needs. The
package is no longer private and has a public `publishConfig`. 195 tests.

**`services/facilitator`.** Three routes under `/x402` take no token and answer in the reference
shapes (`invalidMessage` and `errorMessage` for Bursar's `detail`; `extensions`; `signers` naming
the relayer). Behind them is a second `Facilitator` over the standard profile that shares the
provider routes' budget, ledger, fee and replay guard: a payment settled through either door cannot
be settled again through the other, and one relayer has one daily limit. A meter allows
`FACILITATOR_PUBLIC_RATE_PER_MINUTE` requests a minute per caller (120 unless set), the caller
being the first `x-forwarded-for` address or the socket's peer. The routes exist only while
`FACILITATOR_PUBLIC_EXACT=true`; otherwise they answer 404 naming the switch. The provider and
admin routes are unchanged, and a startup with the switch on and a scheme without a standard
profile refuses to start. 357 tests, plus the route table in the README held to the router.

**`examples/x402-rhc`.** A stock Express endpoint (`@x402/express`, `@x402/evm`, `@x402/core`
2.28.0) charging `$0.01` for `GET /quote`, with two Robinhood Chain lines: the facilitator URL and
the money parser. A stock client (`@x402/fetch`, `@x402/evm`) paying it. The example is a
workspace package.

**`docs/bullish/x402-rhc.patch`.** USDG for `eip155:4663` in the TypeScript, Go and Python default
asset tables, the row in `docs/core-concepts/network-and-token-support.mdx`, and the three
changelog fragments, the same seven files the Arc entry (#3590) shipped with. No testnet entry and
no faucet line: USDG has no contract on chain 46630.

## The demo

What a stranger runs, once the facilitator is deployed with the switch on:

```
git clone https://github.com/bursar-world/bursar && cd bursar && pnpm install
pnpm --filter @bursar/x402 build
PAY_TO=0xYourAddress pnpm --filter @bursar/example-x402-rhc server
EVM_PRIVATE_KEY=0x... pnpm --filter @bursar/example-x402-rhc pay
```

The payer needs USDG on Robinhood Chain and no ETH. The client prints the paid body, the settlement
the facilitator reported in the `PAYMENT-RESPONSE` header, and the explorer link. Before the
deploy, `FACILITATOR_URL` points the server at a facilitator built from this branch.

What ran on 2026-10-10, against mainnet. The branch's facilitator was composed in-process the way
the binary composes it, with the keyless routes open, a demo relayer (`film-owner`,
`0x2176…5f99`) and the e2e database; the live service and its relayer were not touched. The
example server charged one cent payable to the `payee` wallet; the example client paid from the
`payer` wallet.

| Step | What happened |
|---|---|
| `GET /x402/supported` | `kinds` for `eip155:4663` on x402 v1 and v2, `extensions: []`, `signers: { "eip155:*": [relayer] }`. No token. |
| `GET /quote` unpaid | 402 with a `PAYMENT-REQUIRED` header naming `eip155:4663`, amount `10000`, the USDG address, `extra: { name: "Global Dollar", version: "1" }`. |
| The client's retry | Signed an EIP-3009 authorisation under that domain with a random nonce; the server verified and settled through `/x402/verify` and `/x402/settle`; 200 with the quote and the settlement header. 1,077 ms end to end. |
| On chain | [0xb29f4548…49ab](https://robinhoodchain.blockscout.com/tx/0xb29f4548ae08e4618aa85aeb71516b7ca9e34358d5b04ecd502e964bd3ed49ab), block 85,112,149 at 15:44:01 UTC, status success, `transferWithAuthorization` on USDG, one `Transfer` of 0.01 USDG from `0x877c…5c61` to `0x5210…a374`, 86,011 gas paid by the relayer. |

Screenshots, 1440×900, in `docs/bullish/x402-rhc/`: `01-offer.png` (the keyless `/supported`
answer and the 402 offer), `02-pay.png` (the stock client's output with the transaction),
`03-receipt.png` (the transaction on the explorer, with the one-cent transfer).

`demo.webm`, 25 seconds at 1440×900, is the flow run again in one take: the unpaid 402, the stock
client paying, and the receipt read back from the chain. That take settled
[0x3a7515ee…0307](https://robinhoodchain.blockscout.com/tx/0x3a7515ee4317b97df4a6b713cfcc07e4350ca6496c969e2ce93bfd0011cd0307)
at block 85,281,158 in 0.97 s, 85,945 gas. A first take whose last act fell below the frame settled
[0x7ac957e0…926a](https://robinhoodchain.blockscout.com/tx/0x7ac957e07e670205e078c145d91738e5a92afb8a81425c89ac256967fb7b926a).
Three cents of USDG moved from the payer to the payee across the three runs; the demo relayer spent
under 0.000006 ETH.

A console page was considered and not built: a page that paid through the browser would need the
keyless routes live first, and the runnable example is what a developer reaches for. If a page is
wanted after the deploy, the stock client runs in a browser against a wallet's `signTypedData`.

## Operator actions

1. **Render, the facilitator service** (`facilitator.bursar.world`). Add the environment variable
   `FACILITATOR_PUBLIC_EXACT=true`. Optionally `FACILITATOR_PUBLIC_RATE_PER_MINUTE` (120 unless
   set). Deploy the build from this branch. The start-up log prints `keyless x402 routes open
   under /x402`. Then `curl -s https://facilitator.bursar.world/x402/supported` answers without a
   token, and the example above runs with no `FACILITATOR_URL`. Settlements through `/x402` draw
   on the live relayer's ETH and the shared daily budget (`FACILITATOR_DAILY_SETTLEMENTS`, 2,000
   unless set).
2. **Publish `@bursar/x402`** so the example and the announcement resolve from npm:
   `pnpm --filter @bursar/x402 build && pnpm --filter @bursar/x402 publish --access public` (the
   package depends on `@bursar/core` 0.1.0, already published).
3. **Open the upstream pull request** at https://github.com/x402-foundation/x402. Fork it, then:

   ```
   git checkout -b add-robinhood-chain-default-stablecoin
   git apply <bursar>/docs/bullish/x402-rhc.patch
   git commit -S -am "feat: add Robinhood Chain (eip155:4663) with USDG as the default stablecoin"
   ```

   The repository requires signed commits. Title: `Add Robinhood Chain (eip155:4663) with USDG as
   the default stablecoin`. Body, per `DEFAULT_ASSETS.md`:

   > Adds Robinhood Chain mainnet (`eip155:4663`) to the EVM default asset tables with Global
   > Dollar (USDG, `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals) as the default
   > stablecoin, in the TypeScript, Go and Python SDKs, the network support doc, and the changelog
   > fragments. USDG is the dollar stablecoin Robinhood Chain's applications settle in. It
   > implements EIP-3009 `transferWithAuthorization` (both the `v,r,s` and `bytes` overloads) and
   > `authorizationState`; its EIP-712 domain is name `Global Dollar`, version `1`, which reproduces
   > the on-chain `DOMAIN_SEPARATOR` (`0x7a3d…2036`). The token publishes no `version()`. A
   > facilitator for this network is live at `https://facilitator.bursar.world/x402`; a settlement
   > made through it with the reference client: `0xb29f4548…49ab`. No testnet entry: USDG has no
   > contract on chain 46630. Decimals are 6, so no paywall regeneration.

   Paste the live URL claim only after step 1 is done. Record the PR URL in the Links section.
4. **Push the branch** so the links below resolve, and merge or open the Bursar pull request as
   usual.

Nothing on chain changes: no governance action, no new contract, no funds to move beyond the
relayer's ordinary gas.

## Limits

- Until step 1 deploys, a keyless call to `facilitator.bursar.world` answers 401. The verification
  above ran the branch locally against mainnet.
- The keyless routes run the standard profile: a payment is not bound to its request. Whoever holds
  a payment header can submit it, and the funds still go only to the payee the payer signed for.
  That is the protocol's own property; Bursar's provider routes keep binding.
- The meter is per process and reads `x-forwarded-for`, which is as good as the proxy in front of
  it. Behind Render it names the client; on a bare listener it names the peer.
- The daily settlement budget and the per-payer hourly allowance are shared with the provider
  routes, so a flood of valid keyless payments can spend the day's budget. The fee floor
  (`FACILITATOR_FEE_FLOOR_MICRO`, 1,900 micro) refuses a payment at or under $0.0019, as on the
  provider routes; the facilitator's fee is recorded against the payee in Bursar's ledger, and the
  on-chain transfer carries the full amount to the payee.
- Until the upstream table carries USDG, a stock client lists it once:
  `client.setSpendControls({ allowedAssets: [usdgSpendControl('$1')] })` (or the equivalent object
  by hand), and a stock server prices Robinhood Chain through `robinhoodChainMoneyParser` or an
  explicit `AssetAmount`. The patch is written; the pull request is not yet opened.
- Robinhood Chain has no x402 v1 network name and gets none here. Both protocol versions use
  `eip155:4663`.
- Only the `exact` scheme with EIP-3009 is served keylessly. The escrow lane needs a mandate, and
  the permit paths stay off unless a deployment opts in.
- One relayer, one process: the keyless routes settle from the same relayer key as the provider
  routes and must run in that process.

## Links

- Files on the branch:
  - https://github.com/bursar-world/bursar/blob/bullish/x402-rhc/packages/x402/src/exact-evm.ts
  - https://github.com/bursar-world/bursar/blob/bullish/x402-rhc/packages/x402/src/robinhood-chain.ts
  - https://github.com/bursar-world/bursar/blob/bullish/x402-rhc/services/facilitator/src/x402/public.ts
  - https://github.com/bursar-world/bursar/blob/bullish/x402-rhc/services/facilitator/src/http/routes.ts
  - https://github.com/bursar-world/bursar/blob/bullish/x402-rhc/services/facilitator/README.md
  - https://github.com/bursar-world/bursar/blob/bullish/x402-rhc/examples/x402-rhc/server.ts
  - https://github.com/bursar-world/bursar/blob/bullish/x402-rhc/examples/x402-rhc/pay.ts
  - https://github.com/bursar-world/bursar/blob/bullish/x402-rhc/docs/bullish/x402-rhc.patch
- Branch diff: https://github.com/bursar-world/bursar/compare/main...bullish/x402-rhc
- The live thing: https://facilitator.bursar.world/x402/supported (after the deploy)
- The settlement: https://robinhoodchain.blockscout.com/tx/0xb29f4548ae08e4618aa85aeb71516b7ca9e34358d5b04ecd502e964bd3ed49ab
- Upstream: the pull request URL once opened; until then `docs/bullish/x402-rhc.patch`, against
  https://github.com/x402-foundation/x402 at `f8f83309`.
- Screenshots and recording: `docs/bullish/x402-rhc/01-offer.png`, `02-pay.png`, `03-receipt.png`,
  `demo.webm`
- The two further settlements: https://robinhoodchain.blockscout.com/tx/0x7ac957e07e670205e078c145d91738e5a92afb8a81425c89ac256967fb7b926a
  and https://robinhoodchain.blockscout.com/tx/0x3a7515ee4317b97df4a6b713cfcc07e4350ca6496c969e2ce93bfd0011cd0307

## Announcement

Publish after the deploy and the npm publish.

**One line.** Any x402 agent can now pay for Robinhood Chain services in USDG, settled by Bursar.

**One paragraph.** x402 is the open standard where an API answers 402 with a price and the
client's retry carries a signed payment. Bursar now runs a keyless x402 facilitator for Robinhood
Chain. A stock x402 client pays a Robinhood Chain endpoint in USDG, and Bursar settles the transfer
on chain and pays the gas. A server built on the reference packages adds Robinhood Chain with two
lines, and the client signs it like any other chain. The first payment, one cent of USDG for a
quote, settled in just over a second: https://robinhoodchain.blockscout.com/tx/0xb29f4548ae08e4618aa85aeb71516b7ca9e34358d5b04ecd502e964bd3ed49ab

**One post.**

Robinhood Chain services can now be paid by any x402 agent, in USDG, settled by Bursar.

x402 is the open payment standard for APIs: a server answers 402 with a price, the client's retry
carries a signed payment, and a facilitator settles it on chain. The reference packages knew
nothing about Robinhood Chain and no facilitator settled there. Both are fixed.

Bursar's facilitator now has a keyless surface at facilitator.bursar.world/x402 that speaks the
standard `exact` scheme. A resource server on `@x402/express` names it as the facilitator and
prices in USDG through `@bursar/x402`; that is the whole integration. A client on `@x402/fetch`
pays with no change beyond allowing USDG. The payer holds USDG and no ETH; Bursar's relayer pays the
gas, and every settlement runs under the same replay guard and daily limits as Bursar's own
payments.

The first payment on mainnet: a stock client paid one cent of USDG for a quote and had its answer
in 1.08 seconds. The transfer is on the explorer:
https://robinhoodchain.blockscout.com/tx/0xb29f4548ae08e4618aa85aeb71516b7ca9e34358d5b04ecd502e964bd3ed49ab

The change that puts Robinhood Chain in the x402 default asset tables is on its way upstream, so a
server will price in dollars on Robinhood Chain with no package of ours at all. Until then,
`@bursar/x402` carries the network, the asset and its signing domain.

Run it yourself: github.com/bursar-world/bursar, `examples/x402-rhc`.

## Progress

- 15:13 UTC. Rules read. Facts gathered: USDG's domain and both EIP-3009 overloads confirmed on
  chain; the reference client, server and facilitator read from x402-foundation/x402 at `f8f8330`;
  the live facilitator refuses keyless calls; the reference client's expiry rule found incompatible
  with Bursar's bound profile.
- 15:35 UTC. `@bursar/x402`: standard profile, Robinhood Chain export, tests green (194).
- 15:40 UTC. Facilitator: keyless routes, shared budget and ledger, meter, docs, tests green (357).
- 15:44 UTC. Upstream patch written and checked against the foundation's main. Example package
  installed. First attempt refused by the reference client's spend controls; `usdgSpendControl`
  added. Payment settled on mainnet, `0xb29f…49ab`.
- 15:50 UTC. Screenshots rendered, console typecheck clean, doc written.
- 20:33 UTC. The overload comment in `eip3009.ts` corrected to what the chain says. Recording made
  in two takes, each a real settlement (`0x7ac9…926a`, `0x3a75…0307`); the second is `demo.webm`.
  Suites rerun, everything committed.
