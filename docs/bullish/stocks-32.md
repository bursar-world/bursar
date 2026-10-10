# Every Robinhood stock Chainlink prices, under a mandate

**The sentence:** an agent can buy any Robinhood stock or fund that Chainlink prices on Robinhood Chain, under a budget
you set. Sixteen of the thirty-five have a pool deep enough to trade today, and this build lists them.

## What is live and what is prepared

Live on `bullish/stocks-32`, nothing on mainnet changes until the operator sends the batch:

- **The inventory.** `contracts/script/stocks-inventory.mjs` reads every "Robinhood X / USD" feed in Chainlink's
  directory, finds the token Robinhood's StockFactory deployed under that ticker, every Uniswap v4 pool with USDG on
  one side from the PoolManager's `Initialize` logs (218,165 of them), and for each hookless pool under 1% fee its
  in-range liquidity, its mid against the feed and quotes for 0.90, 10 and 25 USDG through the V4Quoter. The result
  is `docs/bullish/stocks-32-inventory.json`, measured at block 85,281,230 on 2026-10-10 20:32 UTC. The table below
  is drawn from it.
- **The listing batch.** `contracts/script/ListStocks.s.sol` puts two proposals per stock to the 48-hour timelock,
  `AssetRegistry.setAsset` and `CollateralVault.setAssetTier`, for the thirteen stocks in
  `contracts/script/lib/StockListings.sol`. One `propose()` run proposes all twenty-six, one `approve()` approves
  them, one `execute()` lands them after the delay, with the tier calls waiting for their listings in the same run.
  Terms match the launch stocks: 26-hour trade bound, 100 bps band against the feed and the pinned pool, 25 USDG a
  purchase, never parked, single-stock collateral tier (30% in session, 50% after hours). Each stock's token, feed and
  pinned pool id are in the record under `external.assets`; the script refuses to propose when the pool the terms
  build does not hash to the recorded id, when the feed is not eight decimals, when the token is paused or when the
  pool has no price.
- **The console.** The stock table and the buy form read the registry, so a stock listed after the record was
  written appears with its own ticker and company name. The table groups by collateral tier (index funds, single
  stocks), shows a search box from eight stocks up, and the policy form has allow-all and allow-none. Eligibility and
  pool checks per asset are unchanged: the feed age, the issuer's pause flags, the pool's distance from the feed.
- **The SDK and the MCP server.** Both resolved tickers through the deployment record alone. Now a ticker the record
  does not know is looked up on the registry, so `rwa(mandate).buy('TSLA', …)` and `mandate_buy_stock` with
  `asset: "TSLA"` work the moment governance lists it, with no package release. The refusal for an unknown ticker
  names every stock the registry lists. Tests: `packages/sdk/test/rwa.test.ts` and `packages/mcp/test/record.test.ts`.
- **The verifier.** `VerifyRwa.s.sol` checks every listed stock's terms, pinned pool and tier, and reports a stock the
  record names and the registry does not hold yet as owed rather than wrong.

## The inventory

Thirty-five Chainlink feeds carry a "Robinhood" prefix on the chain today: the thirty-two the roadmap counted, SGOV
(the treasury asset, listed at launch) and two added since, DELL and USAR (marked *). Every one has a token from
Robinhood's StockFactory (`0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046`, verified as `StockFactory` behind an ERC1967
proxy), none is paused, and the access registry is not paused. Fee is the pool's; "band depth" is the USDG that can
be spent before the pool's mid sits 100 bps above the feed, with the in-range liquidity held constant, so a range that
ends inside the band makes it optimistic. "25 USDG purchase" is the quoter's fill against the feed, fee included.

A stock is in the batch when a 25 USDG purchase fills inside the band and leaves the mid inside it, and the pool
carries at least 500 USDG of band depth (twenty purchases at the cap). Where several pools qualify, the one with the
lowest cost at 25 USDG is pinned.

| Ticker | Token | Feed | Feed price | Pools with USDG | Pinned or best pool | Fee | In-range liquidity | Mid vs feed | 25 USDG purchase | Band depth | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| AAPL | `0xaF3D…93f9` | `0x6B22…2cD0` | 336.63 | 100 | `0xc748…8fdb` | 0.3% | 5.70e+17 | 16 bps | 20 bps over feed | 60,623 USDG | listed at launch |
| AMD | `0x8692…3fdC` | `0x943A…2C72` | 609.36 | 45 | `0xde9f…1274` | 1.0% | 2.81e+17 | 48 bps | 159 bps over feed | 18,393 USDG | no pool inside the band |
| AMZN | `0x12f1…bF54` | `0xD5a1…651C` | 261.87 | 55 | `0xefc9…8825` | 0.24% | 3.68e+16 | 7 bps | 35 bps over feed | 2,791 USDG | in this batch |
| ASML | `0x47F9…dAEA` | `0xB410…f87D` | 1780.84 | 48 | `0x95df…104f` | 0.7% | 1.18e+14 | 5 bps | 135 bps over feed | 24 USDG | no pool inside the band |
| BABA | `0xad25…a1c4` | `0x62Cc…E984` | 111.11 | 57 | `0x1791…c439` | 0.1% | 3.18e+16 | 43 bps | 30 bps over feed | 2,383 USDG | in this batch |
| CLSK | `0xcBB9…Cee3` | `0x810c…50eF` | 10.48 | 27 | none |  |  |  |  |  | no open pool |
| COIN | `0x6330…450b` | `0xA3a4…8Ef2` | 179.84 | 62 | `0xe2e1…c314` | 0.25% | 2.01e+16 | 53 bps | 83 bps over feed | 639 USDG | in this batch |
| CRCL | `0xdF09…1CB5` | `0x6652…482a` | 84.83 | 76 | `0x628c…1ea0` | 0.3% | 1.12e+17 | 97 bps | 132 bps over feed | 201 USDG | no pool inside the band |
| CRWV | `0x5f10…49C3` | `0xe1b3…487C` | 82.18 | 34 | `0x2370…9c4b` | 0.9% | 3.37e+16 | 31 bps | 71 bps over feed | 2,010 USDG | in this batch |
| DELL * | `0x941A…11Dd` | `0x1C6c…206b` | 585.72 | 54 | `0x7296…d3bb` | 0.5% | 4.06e+16 | 28 bps | 32 bps over feed | 6,282 USDG | in this batch |
| EWY | `0x7f0a…13Fc` | `0xEFdf…e1D1` | 177.44 | 73 | `0x3cba…dbbb` | 0.5% | 2.07e+15 | 30 bps | 39 bps over feed | 179 USDG | pool too thin, not listed |
| GME | `0x1b0E…153E` | `0x27C7…5B67` | 26.66 | 222 | `0x3d43…063b` | 1.0% | 1.07e+15 | 80 bps | 77 bps over feed | 50 USDG | pool too thin, not listed |
| GOOGL | `0x2e08…4FE3` | `0xF6f3…638b` | 352.61 | 89 | `0xd4ec…ac5e` | 0.3% | 3.81e+17 | 15 bps | 21 bps over feed | 40,939 USDG | in this batch |
| INTC | `0xc72b…9681` | `0x3f39…1913` | 104.38 | 58 | `0xf2e3…8c22` | 1.0% | 2.10e+17 | 94 bps | 206 bps over feed | 743 USDG | no pool inside the band |
| IONQ | `0x5583…0EfE` | `0x22Ef…71eb` | 39.84 | 34 | none |  |  |  |  |  | no open pool |
| META | `0xc0D6…2f35` | `0x7C38…71b1` | 718.26 | 129 | `0xc58b…872f` | 0.031% | 1.13e+17 | 5 bps | 9 bps over feed | 14,487 USDG | in this batch |
| MSFT | `0xe932…2e74` | `0x45C3…Af2E` | 534.98 | 60 | `0x9194…9579` | 0.3% | 7.59e+16 | 5 bps | 31 bps over feed | 9,187 USDG | in this batch |
| MSTR | `0xec26…da09` | `0x3961…dc3D` | 154.25 | 151 | `0xc105…5326` | 0.24% | 7.95e+17 | 85 bps | 114 bps over feed | 7,444 USDG | no pool inside the band |
| MU | `0xfF08…4afD` | `0x425E…d596` | 1029.33 | 69 | `0x6fa3…5659` | 1.0% | 7.12e+16 | 5 bps | 107 bps over feed | 12,022 USDG | no pool inside the band |
| NBIS | `0x9D9c…7931` | `0xE1D8…9705` | 221.57 | 39 | `0x7c2f…4f0c` | 0.99% | 2.39e+16 | 3 bps | 109 bps over feed | 1,835 USDG | no pool inside the band |
| NVDA | `0xd060…9EEC` | `0x379E…9F15` | 230.36 | 342 | `0x6444…29c5` | 0.01% | 8.25e+17 | 6 bps | 7 bps over feed | 59,304 USDG | listed at launch |
| ORCL | `0xb099…EE03` | `0x0e6a…A844` | 142.33 | 41 | `0xc2ce…850a` | 1.0% | 6.79e+16 | 34 bps | 78 bps over feed | 5,448 USDG | in this batch |
| PLTR | `0x894E…4F2A` | `0x820A…eB4c` | 208.73 | 58 | `0xc59e…3802` | 0.15% | 1.08e+17 | 11 bps | 29 bps over feed | 6,991 USDG | in this batch |
| QQQ | `0xD5f3…de68` | `0x8090…C2ae` | 751.92 | 48 | `0xf956…9758` | 0.3% | 2.72e+13 | 12 bps | 383 bps over feed | 3 USDG | no pool inside the band |
| RGTI | `0x2843…97Ba` | `0x2A04…f765` | 14.06 | 24 | none |  |  |  |  |  | no open pool |
| RKLB | `0x3b14…12e2` | `0x0454…CC74` | 68.33 | 41 | `0xbbc1…22f3` | 0.9% | 5.13e+15 | 9 bps | 115 bps over feed | 196 USDG | no pool inside the band |
| SGOV | `0x92FD…F9B5` | `0xa0DF…7A11` | 101.23 | 56 | `0x2a72…99a8` | 0.0375% | 4.30e+16 | 11 bps | 6 bps over feed | 2,386 USDG | treasury asset, listed at launch |
| SLV | `0x411e…D89f` | `0x209b…a2ce` | 55.00 | 34 | `0x7ba0…7ed5` | 0.0375% | 2.27e+13 | 33 bps | 601 bps over feed | 1 USDG | no pool inside the band |
| SNDK | `0xB90A…6400` | `0xfb13…09A3` | 1580.91 | 41 | `0x2707…ea24` | 1.0% | 2.94e+16 | 40 bps | 152 bps over feed | 3,542 USDG | no pool inside the band |
| SPCX | `0x4a0E…5eEa` | `0xB265…Bffb` | 162.64 | 154 | `0x8567…7448` | 0.3% | 6.09e+16 | 43 bps | 78 bps over feed | 2,244 USDG | in this batch |
| SPY | `0x117c…4C0C` | `0x3197…9f6A` | 780.06 | 150 | `0xe592…f907` | 0.05% | 4.72e+18 | 1 bps | 7 bps over feed | 655,083 USDG | listed at launch |
| TSLA | `0x322F…3b2d` | `0x4A11…7C38` | 382.95 | 90 | `0x8517…d32e` | 0.3% | 3.75e+17 | 13 bps | 48 bps over feed | 32,096 USDG | in this batch |
| TSM | `0x58Ff…e7AA` | `0x874c…Fc2F` | 452.92 | 58 | `0x0ba5…5fb1` | 0.75% | 9.69e+16 | 23 bps | 109 bps over feed | 8,063 USDG | no pool inside the band |
| USAR * | `0xd917…86a6` | `0xA994…2DD9` | 12.61 | 27 | `0x2133…1a06` | 0.25% | 1.80e+12 | 1115 bps |  | 0 USDG | no pool inside the band |
| USO | `0xa30F…D344` | `0x75a9…431c` | 148.24 | 42 | `0x1f2a…6420` | 0.12% | 2.33e+17 | 36 bps | 22 bps over feed | 19,270 USDG | in this batch |

**Count, said plainly.** Of the thirty-two stocks and funds the roadmap counted, fifteen have a pool that trades
inside the band with depth to spare: AAPL, NVDA and SPY since launch, and AMZN, BABA, COIN, CRWV, GOOGL, META, MSFT,
ORCL, PLTR, SPCX, TSLA and USO in this batch. DELL, which Chainlink added after the count, is in the batch too, which
makes sixteen stocks on the registry once it executes, seventeen assets with SGOV. EWY and GME have a pool inside the
band but under 200 USDG of depth, so they wait. AMD, ASML, CLSK, CRCL, INTC, IONQ, MSTR, MU, NBIS, QQQ, RGTI, RKLB,
SLV, SNDK, TSM and USAR have no pool that fills a 25 USDG purchase inside 100 bps of the feed; most have only spam
pools at 50% to 99.99% fees or a few dollars of liquidity. The inventory script is the way to re-measure: a pool
somebody seeds tomorrow shows up on the next run, and the listing is one more line in `StockListings.sol`.

Two costs worth naming: CRWV trades through a 0.9% pool and ORCL through a 1% pool, the only ones with depth, so a
purchase in either pays most of the band to the pool. COIN's pool sits 53 bps above the feed, so purchases there run
near the edge of the band until an arbitrageur moves it.

## Rehearsal on a fork

Everything below ran against a fork of mainnet at block 84,439,684 (2026-10-09 20:30 UTC, feeds under an hour
old) through the Chainstack endpoint, with foundry 1.5.0's anvil (1.8.1 cannot fork this chain).

1. **The whole governance path.** Signers impersonated: `propose()` put proposals #18 to #43 on the timelock,
   `approve()` added the second approval to each, `execute()` before the delay sent nothing and failed with the date
   the delay ends, two days were added to the clock, one `execute()` run landed all twenty-six (the tier calls after
   their listings), `status()` reported 26 done, `record()` wrote thirteen entries into `rwa.assets`, and
   `VerifyRwa.s.sol` reported 0 mismatched, 0 owed. The registry holds 17 assets; TSLA is in tier 3.
2. **The purchase.** On a second fork the timelock was impersonated to send the same twenty-six calls directly. The
   example mandate's owner pointed it at the current purchase router and allowed TSLA; the agent bought 0.90 USDG of
   TSLA at the feed price of 382.95. See the demo below.

## The demo

Two purchases of 0.90 USDG of TSLA from the example mandate `0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c`, whose
owner and agent is the payer key, on the demo fork (block 84,439,684, TSLA feed 382.95). On mainnet the same two run
unchanged once the batch has executed; the operator runs them and pastes the hashes here.

**On the console, recorded.** `docs/bullish/stocks-32/demo.webm` (54 s, 1440×900) and the stills `01-listed-stocks.png`
(the table of sixteen, grouped), `02-find-a-stock.png` (the search), `03-buy-form.png` (TSLA chosen, 0.90 USDG, "you
receive at least 0.00232667 TSLA"), `04-bought.png` ("Confirmed. View the transaction.") and `05-held.png` (0.90 USDG
of TSLA held, at the feed price). The agent's purchase landed as
`0x0cace42f89073ca89cf91f6422f3b2da46f2d91f3ea2afd0c11d5a691e9df80b` on the fork: 0.90 USDG in, 0.002339 TSLA out,
0.5% below the feed, inside the 1% band. Made with `ops/e2e/film/stocks-32.ts` in the ops checkout, which drives the
built console with the payer keystore through the wallet bridge and records with Playwright:

```
cd ~/Projects/bursar-ops/ops/e2e
BURSAR_E2E_RPC=http://127.0.0.1:8690 FILM_BASE_URL=http://127.0.0.1:4398 \
  FILM_OUT=~/Projects/bursar-wt/stocks-32/docs/bullish/stocks-32 FILM_STOCK=TSLA FILM_AMOUNT=0.90 npx tsx film/stocks-32.ts
```

On mainnet: `BURSAR_E2E_RPC=https://robinhood.drpc.org FILM_BASE_URL=https://app.bursar.world FILM_MAX_FEE_WEI=50000000000000`,
once the console deploy carries this branch (the live console lists the registry too, so the sixteen show either way).

**From a terminal, the runnable example.** The quote is read from the guard and the router, then the agent sends the
mandate's `buy`; on the fork this was `0x7c12feba0a3b5596e206c15a41ec15079533246d4d85c1a3ec9954a026fdf82e`
(352,403 gas, 0.002339 TSLA out).

```
source ~/Projects/bursar-ops/ops/rhc-env.sh                      # payer keystore password from the Keychain
RPC=https://robinhood.drpc.org                                  # or the fork, http://127.0.0.1:8690
M=0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c                    # the example mandate
R=0xBF6bC24d44f5A432a5682De650981A1885D31660                    # StockSpendRouter, from the record
G=0x41a719D866ADA35BcE10570314312C186570310A                    # PriceGuard, from the record
TSLA=0x322F0929c4625eD5bAd873c95208D54E1c003b2d
K=~/.config/bursar/keystore/payer

# once, by the owner: the current router, and TSLA on the mandate's list at a 1% slippage limit
cast send $M "setRouter(address)" $R --keystore $K --password-file "$ETH_PASSWORD" --rpc-url $RPC
cast send $R "setPolicy(address,uint16,address[],bool[])" $M 100 "[$TSLA]" "[true]" --keystore $K --password-file "$ETH_PASSWORD" --rpc-url $RPC

# the purchase, by the agent: 0.90 USDG of TSLA at the feed, or refused
PRICE=$(cast call $G "tradePrice(address,address)(uint256)" $TSLA $M --rpc-url $RPC | cut -d' ' -f1)
MIN=$(cast call $R "minOutFor(address,address,uint256)(uint256)" $M $TSLA 900000 --rpc-url $RPC | cut -d' ' -f1)
cast send $M "buy(address,uint128,uint128,uint256)" $TSLA 900000 $MIN $PRICE --keystore $K --password-file "$ETH_PASSWORD" --rpc-url $RPC
cast call $TSLA "balanceOf(address)(uint256)" $M --rpc-url $RPC
```

The same purchase from the SDK, which resolves `TSLA` on the registry: `await mandate.buy('TSLA', usdg('0.90'))`. From
Claude through the MCP server: `mandate_buy_stock` with `{ "asset": "TSLA", "amount": "900000" }`.

**Setting the fork up** (what the film ran against): foundry 1.5.0's anvil pinned at a block with fresh feeds,
`anvil --fork-url "$CHAINSTACK_RHC_RPC_URL" --fork-block-number 84439684 --port 8695 --chain-id 4663 --block-time 1`;
a small proxy on 8690 that serves `eth_getLogs` below the fork block from the chain's own endpoint (Chainstack caps a
query at ten thousand blocks, the console asks for ten million) and passes everything else to anvil;
`anvil_setCode` of `0x4360005260206000f3` at `0x…0064` so `ArbSys.arbBlockNumber` answers (the console reads the block
height there); the twenty-six calls from `proposals()` sent by the impersonated timelock; the console built with
`NEXT_PUBLIC_RHC_RPC_PRIMARY=http://127.0.0.1:8690 NEXT_PUBLIC_RHC_RPC_FALLBACK=http://localhost:8690` and served
with `next start --port 4398`. The wallet bridge's fee ceiling has to be raised for a fork, which prices gas at a
gwei where the chain asks a hundredth of that (`FILM_MAX_FEE_WEI`).

## What the operator must do

From `~/Projects/bursar-ops`, after merging the branch into the clone the ops scripts read:

```
cd ~/Projects/bursar-harden/contracts     # or wherever bullish/stocks-32 is checked out
source ~/Projects/bursar-ops/ops/rhc-env.sh
source script/env/rhc-mainnet-v6.env
export KEYS="$HOME/.config/bursar/keystore"

# 1. Read the batch against mainnet: 26 "to propose" lines, or a named refusal.
forge script script/ListStocks.s.sol --sig "status()" --rpc-url "$RHC_RPC_URL"
forge script script/ListStocks.s.sol --sig "proposals()" --rpc-url "$RHC_RPC_URL"   # target and calldata of each

# 2. Propose (signer-1), approve (signer-2). Simulate first, as the migrations do.
forge script script/ListStocks.s.sol --sig "propose()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1"
forge script script/ListStocks.s.sol --sig "propose()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1" --broadcast --slow
forge script script/ListStocks.s.sol --sig "approve()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-2" --broadcast --slow
forge script script/ListStocks.s.sol --sig "status()"  --rpc-url "$RHC_RPC_URL"    # 26 proposed, executable from <date>

# 3. After 48 hours: execute (signer-1). One run lands the listings and the tiers; run it twice if a tier
#    reported "waiting on an earlier call".
forge script script/ListStocks.s.sol --sig "execute()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1" --broadcast --slow
forge script script/ListStocks.s.sol --sig "status()"  --rpc-url "$RHC_RPC_URL"    # 26 done

# 4. Record the listings, regenerate the SDK's copy, verify, commit.
forge script script/ListStocks.s.sol --sig "record()" --rpc-url "$RHC_RPC_URL" --broadcast   # writes rwa.assets; no transaction
pnpm --filter @bursar/core codegen
forge script script/VerifyRwa.s.sol --rpc-url "$RHC_RPC_URL"                                # 0 mismatched, 0 owed
git add contracts/deployments/rhc-mainnet-v6.json packages/core/src/generated/deployments.ts && git commit -m "record the thirteen listed stocks"
```

Each proposal is one timelock entry, 26 in all, because `AssetRegistry.setAsset` takes one asset and the timelock
takes one call per proposal; the script keeps them in step and skips what is already on chain, so every step can be
rerun. Gas: 26 proposals, 26 approvals and 26 executions on Robinhood Chain, under 0.001 ETH together.

Then the mainnet demo (payer key, cents): see "The demo" for the two commands. Then publish `@bursar/sdk` and
`@bursar/mcp` with the regenerated record, so a fresh install names the new tickers without a chain read; the
versions on npm today already buy them through the registry lookup.

Nothing to provision on Render. No new contract.

## Honest limits

- Thirteen listings wait on the 48-hour delay; until it executes, mainnet lists SPY, NVDA and AAPL. The console,
  SDK and MCP already read the registry, so the day it executes they show sixteen with no release.
- "Any of the 32" is not true and the post does not say it: sixteen have pools, two are thin, sixteen have none.
- Purchases are capped at 25 USDG each and refused outside the 100 bps band, after a 26-hour feed silence (every
  weekend from Saturday evening to the Monday round), while an issuer pause is up, or when the pool has drifted. The
  table in the console says which it is per stock.
- Depth is a snapshot. The band check is what protects a purchase when depth moves; the inventory is what to rerun
  before adding more.
- The collateral tier for every new stock is "Single stock" (30% / 50%); USO and SPCX are funds that move like one
  name and were tiered the same way on purpose. Nothing here changes the credit pool's caps.
- The example mandate on mainnet still points at the v4 purchase router, which reads the same registry, so it can buy
  the new stocks either way; the demo moves it to the current router first, which is what a new mandate gets.

## Links

- Branch diff: https://github.com/bursar-world/bursar/compare/main...bullish/stocks-32
- Inventory: https://github.com/bursar-world/bursar/blob/bullish/stocks-32/contracts/script/stocks-inventory.mjs and
  https://github.com/bursar-world/bursar/blob/bullish/stocks-32/docs/bullish/stocks-32-inventory.json
- Governance batch: https://github.com/bursar-world/bursar/blob/bullish/stocks-32/contracts/script/ListStocks.s.sol,
  terms in https://github.com/bursar-world/bursar/blob/bullish/stocks-32/contracts/script/lib/StockListings.sol,
  test in https://github.com/bursar-world/bursar/blob/bullish/stocks-32/contracts/test/script/ListStocks.t.sol
- Console: https://github.com/bursar-world/bursar/blob/bullish/stocks-32/apps/web/src/app/(app)/console/%5Bmandate%5D/stock-panel.tsx
  and https://github.com/bursar-world/bursar/blob/bullish/stocks-32/apps/web/src/app/(app)/console/lib/rwa.ts
- SDK and MCP: https://github.com/bursar-world/bursar/blob/bullish/stocks-32/packages/sdk/src/rwa.ts,
  https://github.com/bursar-world/bursar/blob/bullish/stocks-32/packages/mcp/src/gateway.ts
- Live: the registry https://robinhoodchain.blockscout.com/address/0xbd4950505d45e53740DA4941B666B3C796818393,
  the timelock https://robinhoodchain.blockscout.com/address/0xffe874aA257C99414205ddf684903e30761E1832, the example
  mandate https://app.bursar.world/console/0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c
- Chainlink's feed list: https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json
- Screenshots and recording: `docs/bullish/stocks-32/` on this branch

## The announcement

**One line.** An agent can now buy sixteen Robinhood stocks and funds on Robinhood Chain under a Bursar budget,
each priced by its Chainlink feed: Apple, Amazon, Alphabet, Meta, Microsoft, Nvidia, Tesla, Coinbase, Palantir and more.

**One paragraph.** Bursar mandates can now buy sixteen of Robinhood's tokenized stocks and funds, up from three.
Every purchase is checked against the stock's Chainlink reference price and refused when the price is stale, the
issuer has paused the token, or the pool has drifted from the reference. The owner chooses which stocks the agent may
buy and how far below the reference a fill may land; the agent buys with the mandate's USDG, inside its budget, and
the stock lands in the mandate. The list is every Robinhood stock with a Chainlink feed and a pool deep enough to
trade, measured on chain; the rest are listed with the reason they are not there yet.

**One post.** Give an agent a budget and it can buy Apple, Amazon, Alphabet, Meta, Microsoft, Nvidia, Tesla,
Coinbase, Palantir, Oracle, Alibaba, CoreWeave, Dell, SpaceX, the S&P 500 and the oil fund, on Robinhood Chain,
without holding your keys.

Bursar lists sixteen of Robinhood's tokenized stocks and funds today, up from three. Chainlink publishes a reference
price for thirty-five of them on the chain; we measured every Uniswap pool each one trades in and listed the sixteen
with depth to spare. The other nineteen are in the inventory with the reason, and join the list when a pool does.

How a purchase works: the mandate's owner names the stocks the agent may buy and the slippage it may accept. The
agent spends USDG from the mandate, inside its per-payment, daily and lifetime limits. The purchase is checked against
the Chainlink feed and the pool before and after the swap, and refused when the feed is older than 26 hours, the
issuer has paused the token, or the pool sits more than 1% from the feed. The stock is delivered to the mandate; the
owner can take it out, keep it or post it as collateral.

Try it on the console with any mandate, or from code: `mandate.buy('TSLA', usdg('0.90'))`. Claude buys through the
same path with the published MCP server.

## Progress

- 2026-10-10 17:30Z. Read the lane: `AssetRegistry` keys on the token address and pins one hookless v4 pool per asset;
  listing is `setAsset` from the 48-hour timelock. The console, SDK and MCP server took their asset list from the
  deployment record, not the registry, so a stock governance lists after the record is written would not have shown.
- 18:00Z. Inventory scanner written: feeds, factory tokens, pools from `Initialize` logs, depth and quotes.
- 20:30Z. Full inventory measured at block 85,281,230: 35 feeds, 35 tokens, 19 with a pool inside the band at 25 USDG.
  SDK and MCP read the registry for stocks the record does not name; tests green. Console reads the registry, groups
  and searches the table.
- 20:45Z. `ListStocks.s.sol` builds 26 proposals; preflight passes against a fork. Listed on a fork by impersonating
  the timelock; the registry holds 17 assets there.
- 22:45Z. Governance rehearsed end to end on a fork through the timelock (propose, approve, delay, execute, record,
  verify: 0 mismatched, 0 owed). World test for the script green. Console built against the demo fork.
- 23:05Z. Two 0.90 USDG purchases of TSLA from the example mandate on the fork: one on the console, recorded, one from
  the terminal. Doc, screenshots and recording on the branch.
