# Agents sell and rebalance Robinhood stocks back to USDG on Uniswap, inside the budget

A mandate's agent can now sell a Robinhood stock token the mandate holds back to USDG, through the
same Uniswap v4 pool on Robinhood Chain it was bought in, under the same price guard, with the USDG
landing in the mandate. Selling one stock and buying another is a rebalance inside the budget the
owner set: the purchase counts against the limits, the sale puts spendable USDG back.

## What is live and what is prepared

**Prepared on this branch, waiting for the operator to deploy and publish:**

- `StockSpendRouter` with a sell path. The mandate account lets only its owner move a token out, so
  the owner releases what the agent may sell into the mandate's custody on the router (one
  transaction, the account's own `withdraw` to `custodyOf(mandate)`). From there the agent, or the
  owner, sells any part of it with `sell`; anything not sold goes back with `recall`. The sale is
  held to the purchase guard: the Chainlink feed inside its 26-hour trade bound, the pinned pool
  inside the asset's 1% band of the feed before and after the swap, the caller's quote inside that
  band, the $25 per-trade cap at the feed, and the mandate's slippage limit. Proceeds are delivered
  to the mandate's USDG balance. The owner's sale policy allows or refuses sales per asset,
  separately from the purchase list. A sale is recorded as `StockSold(mandate, asset, amountIn,
  usdgOut, feedPriceE8)`, the mirror of `StockBought`.
- A deploy script, `DeployStockRouter.s.sol`, that lands the router against the live registry,
  guard and pool manager, records both routers, and moves the example mandate onto it from the
  payer's key; the runbook is `contracts/script/SELL-ROUTER.md`.
- SDK: `rwa(mandate).sell('SPY')`, `release`, `recall`, `sellQuote`, `sellable`, `custody`,
  `setSalePolicy`, `salePolicy`, with the router's refusals in words.
- MCP: `mandate_sell_stock`, which sells everything released or a named count of raw units, and
  names the owner's step when nothing is released.
- Console: a "Sell a stock" form beside "Buy a stock" with the floor the sale holds ("You receive
  at least $0.49, or the sale is refused", to the cent, never rounded up), a "May sell" list in
  the trading policy, "Release for sale" and "Return to the mandate", a "Released for sale" column,
  a prompt to switch a mandate still on the earlier router, and activity lines such as
  "Sold 0.00064055 SPY for $0.50".

**Live today:** the sixth contract set, where purchases are final and a holding leaves a mandate
only through its owner's withdrawal. The example mandate on mainnet points at the earlier router
until the runbook runs.

## The demo

On a copy of Robinhood Chain at block 85106897 (a Saturday afternoon: the SPY feed 21 hours old,
inside its trade bound, the market closed), the example mandate
`0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c`, whose owner and agent are one key:

1. Bought $0.50 of SPY at the feed price of $780.06: 0.00064055 SPY delivered to the mandate.
2. Released the holding for sale: 0.00064055 SPY moved from the mandate into its custody.
3. Sold it: 0.499374 USDG delivered to the mandate against a floor of 0.494672, in one Uniswap v4
   swap, 418,528 gas, fork block 85106917. The round trip cost 0.000626 USDG, the pool's 0.05%
   fee each way and the spread.

The three transactions are in `uniswap-sell/fork-transactions.json`; the recording and the
screenshots are listed below. The same flow on mainnet is the runbook's last step, once the router
is live: the payer buys $0.50 of SPY under the example mandate, releases it, and sells it, and the
three transactions on `robinhoodchain.blockscout.com` go into this section.

**Run it yourself, on the fork.** With the Chainstack endpoint in `CHAINSTACK_RHC_RPC_URL`:

```sh
cd contracts
BURSAR_RHC_FORK_RPC="$CHAINSTACK_RHC_RPC_URL" forge test --match-path 'test/script/fork/SellFork.t.sol' -vv
```

Four tests: the purchase, release and sale above; the band, slippage and stale-feed refusals; the
after-hours fill on the last answer; and the sale policy refusing NVDA until the owner lists it.

**Run it yourself, on mainnet, once the router is live** (the SDK from npm, the payer's key, inside
the 24/5 session or within 26 hours of the last feed answer):

```ts
import { mandateAccount, rwa, usdg } from '@bursar/sdk';

const mandate = await mandateAccount('0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c', { account: process.env.PAYER_KEY });
const stocks = rwa(mandate);
const bought = await stocks.buy('SPY', usdg('0.50'));
await stocks.release('SPY', bought.amountOut);
const sold = await stocks.sell('SPY');
console.log(sold.usdgOut, sold.txHash);
```

Or from an assistant on the MCP server: `mandate_buy_stock` with `{ asset: "SPY", amount: "500000" }`,
the owner's release in the console, then `mandate_sell_stock` with `{ asset: "SPY" }`.

## What the operator must do

Everything is in `contracts/script/SELL-ROUTER.md`. In short:

1. Rehearse: the fork suite above and `forge test --match-path 'test/script/DeployStockRouter.t.sol'`.
2. Deploy: `DeployStockRouter.s.sol` from the deploy key. No timelock proposal: the router has no
   admin and no administered contract names it, so the 48-hour delay is not on the path.
3. Move the example mandate: `DeployStockRouter.s.sol --sig "repointExample()"` from the payer. It
   sets the router and both policies.
4. Publish: commit the record with `rwa.StockSpendRouter` and `rwa.previousStockRouter`, run the
   core package's codegen, deploy the console from that commit (no new environment variable: the
   console reads the router from the record), restart any MCP server with its own record copy, and
   publish `@bursar/core`, `@bursar/sdk` and `@bursar/mcp` from the same commit.
5. Sell once on mainnet in cents, as the runbook's last step, and put the transactions here.
6. Push this branch so the links below resolve, and open no pull request upstream: nothing in
   Uniswap changes.

## Limits

- **Which stocks.** The three stocks the registry lists, SPY, NVDA and AAPL, each with one pinned
  hookless Uniswap v4 pool against USDG on Robinhood Chain (SPY at fee 500 and spacing 5, NVDA at
  100 and 1, AAPL at 3000 and 60). SGOV is a treasury token and is parked and unparked, never sold
  here. Other Robinhood stock tokens join when the registry lists them with a pool.
- **Size.** $25 per trade at the feed price, the registry's cap for these assets. The pools are
  shallow, and a sale that would push one outside its 1% band of the feed is refused, before and
  after the swap.
- **Slippage.** The mandate's slippage limit from the purchase policy, 1% by default (each stock's
  band), caps how far under the feed a fill may land. The floor the console quotes is that figure
  at the feed price now; the swap is refused under it.
- **Hours.** Stocks trade 24/5 and the feeds stand at the last answer between sessions. A sale fills
  on that answer until it is 26 hours old, then is refused until the feed moves again. Weekends
  past that bound refuse every trade, purchase and sale alike.
- **Two steps.** A sale needs the owner's release first, and the owner's sale policy. The agent sells
  only what is in custody. This is what the account contract allows without a new account version;
  a later account can carry its own `sell`.
- **Budget.** A purchase counts against the mandate's limits and a sale credits nothing back; the
  USDG a sale returns is spendable again. Limits are the owner's to raise.
- **Prices.** Every figure is the Chainlink feed's answer or the pool's fill. Nothing here projects a
  return.

## Links

- Router: https://github.com/bursar-world/bursar/blob/bullish/uniswap-sell/contracts/src/rwa/StockSpendRouter.sol
- Unit tests: https://github.com/bursar-world/bursar/blob/bullish/uniswap-sell/contracts/test/rwa/Sell.t.sol
- Fork tests: https://github.com/bursar-world/bursar/blob/bullish/uniswap-sell/contracts/test/script/fork/SellFork.t.sol
- Deploy script: https://github.com/bursar-world/bursar/blob/bullish/uniswap-sell/contracts/script/DeployStockRouter.s.sol
- Runbook: https://github.com/bursar-world/bursar/blob/bullish/uniswap-sell/contracts/script/SELL-ROUTER.md
- SDK: https://github.com/bursar-world/bursar/blob/bullish/uniswap-sell/packages/sdk/src/rwa.ts
- MCP tool: https://github.com/bursar-world/bursar/blob/bullish/uniswap-sell/packages/mcp/src/tools.ts
- Console: https://github.com/bursar-world/bursar/blob/bullish/uniswap-sell/apps/web/src/app/%28app%29/console/%5Bmandate%5D/stock-panel.tsx
- Branch diff: https://github.com/bursar-world/bursar/compare/main...bullish/uniswap-sell
- The example mandate in the console: https://app.bursar.world/console/0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c
- The router it replaces: https://robinhoodchain.blockscout.com/address/0xBF6bC24d44f5A432a5682De650981A1885D31660
- Uniswap v4 on Robinhood Chain, the pool manager every trade settles in: https://robinhoodchain.blockscout.com/address/0x8366a39CC670B4001A1121B8F6A443A643e40951
- Upstream: no pull request; nothing in Uniswap changes.

## Screenshots and recording

All 1440×900, from the fork run, in `docs/bullish/uniswap-sell/`:

- `01-stocks.png`: the Stocks section with the feed prices, the Buy and Sell badges, the Held and
  Released for sale columns.
- `02-buy-quote.png`: $0.50 entered, with the least SPY the purchase delivers.
- `03-bought.png`: the purchase confirmed; "Release for sale" offering the holding.
- `04-released.png`: the holding in custody; the sell form quoting the floor.
- `05-sell-quote.png`: "You receive at least $0.49, or the sale is refused", with "Return the SPY to
  the mandate" beside "Sell SPY".
- `06-sold.png`: the sale confirmed.
- `07-activity.png`: "Sold 0.00064055 SPY for $0.50" above the release and the purchase, with the
  transaction hashes.
- `demo.webm`: 33 seconds, the three steps as the owner and agent see them.
- `fork-transactions.json`: the three transactions, with gas.

## The announcement

**One line.** Agents on Bursar can now sell Robinhood stock tokens back to USDG through Uniswap v4
on Robinhood Chain, inside the mandate's budget.

**One paragraph.** A Bursar mandate lets an agent buy Robinhood stock tokens with USDG under limits
its owner set. From this release the agent can sell them back too: the owner releases a holding for
sale, the agent sells any part of it through the stock's Uniswap v4 pool on Robinhood Chain, and the
USDG lands in the mandate, ready to spend or to put into another stock. Every sale is checked the
way a purchase is, against the Chainlink price, the pool's distance from it, the per-trade cap and
the owner's slippage limit. The console quotes the least the sale can bring in before you sign, the
SDK and the MCP tool do the same for an agent, and the activity shows each sale next to the purchase
it unwinds.

**One post.** Agents on Bursar can now sell Robinhood stocks back to USDG on Uniswap, inside the
budget.

A mandate on Bursar gives an agent a USDG budget with limits its owner wrote: per payment, per day,
per month, and which stocks it may buy. Until now a stock bought under a mandate stayed where it
was. Now the owner can release a holding for sale, and the agent can sell any part of it back to
USDG through the stock's Uniswap v4 pool on Robinhood Chain. The USDG lands in the mandate, where
the agent can spend it or buy another stock with it. That is a rebalance inside the budget.

A sale clears the same checks as a purchase. The Chainlink feed has to be inside its trade bound,
the pool has to sit inside the stock's band of the feed before and after the swap, the sale has to
be under the per-trade cap at the feed price, and the fill has to land inside the owner's slippage
limit. The console shows the least the sale can bring in, to the cent, before you sign. Agents get
the same floor from `rwa(mandate).sell('SPY')` in the SDK and from `mandate_sell_stock` on the MCP
server.

The owner stays in charge: which stocks the agent may sell is a policy of its own, what it may sell
is what the owner has released, and anything not sold comes back to the mandate on request.

SPY, NVDA and AAPL are listed today, with more as Robinhood's stock tokens get pools on the chain.

## Progress

- 2026-10-10 15:30 UTC: read the lane. A mandate account lets only its principal move a token out, so a
  sale needs an owner-released custody; the router gains `sell`, `recall`, `custodyOf`, `sellable`,
  `minUsdgFor` and a per-asset sale policy.
- 16:30 UTC: router written and compiling; 21 unit tests on the RWA fixture green; four fork tests green on
  a pinned mainnet fork (block 85106897) through the Chainstack endpoint: buy $0.50 SPY, release, sell for
  0.499374 USDG; band, stale-feed, slippage, after-hours and sale-policy refusals.
- 17:10 UTC: deploy script and its world test green; full offline contract suite green (1119 tests).
- 22:30 UTC: SDK `sell`, `release`, `recall`, `sellQuote`, `setSalePolicy`, `salePolicy` with offline tests,
  766 SDK tests green.
- 22:35 UTC: MCP `mandate_sell_stock` through the local signer and the HTTP relay seam, 529 tests green.
- 22:40 UTC: console sell form, trading policy with a sale list, release and return, activity lines,
  router prompt; 891 tests green, typecheck clean.
- 22:52 UTC: fork session with the router deployed and the example mandate repointed; the recorded
  demo ran end to end in the console; assets copied; runbook written.
