# Replacing the stock router with one that sells

This runbook puts the selling `StockSpendRouter` live on Robinhood Chain and moves the public
example mandate onto it. It is written for the people who hold the keys. Both steps are scripts in
this directory that can be simulated against the live chain before they send anything, and the
whole sequence has been run on a fork of mainnet at block 85106897 with the same scripts and
arguments.

## What changes

- **One contract is new.** `StockSpendRouter`, built against the live asset registry, price guard and
  Uniswap v4 pool manager, with `sell`, `recall`, `custodyOf`, `sellable`, `minUsdgFor` and a
  per-asset sale policy on top of the purchase path the sixth set's router has. It has no admin
  and answers to nobody: like the router it replaces, it holds the registry and the guard
  immutably.
- **Nothing is wired by governance.** No administered contract names the router. The 48-hour
  timelock has nothing to propose here, and the keeper, the guard and the registry go on as they
  are. A sale is held to the same guard a purchase is: the feed inside its 26-hour trade bound, the
  pinned pool inside the asset's band of the feed before and after the swap, the caller's quote
  inside that band, the per-trade cap, and the mandate's slippage limit.
- **The previous router stays live.** A mandate that still points at it keeps buying through it. A
  mandate adopts the new one when its principal calls the account's `setRouter`, then saves its
  purchase policy again and sets a sale policy, because a policy lives on the router it was set on.
  The record names the old router under `rwa.previousStockRouter`.
- **The apps follow the record.** The console, the SDK and the MCP server read the router from the
  live record. Once the record names the new router, a mandate on the old one sees "Switch to the
  current router" in its trading policy, and its purchases and sales address the new one after.

## Before you start

**Tools.** Foundry 1.8.1 and the dependencies, as [`../README.md`](../README.md) describes, and `jq`.
Run everything from `contracts/`.

**Keys.** The deploy key signs the deployment and the record; the payer signs the example mandate's
move. Both sign from their encrypted keystores, as in [`MIGRATION.md`](MIGRATION.md): the
operations key tooling exports `ETH_PASSWORD` and Foundry reads the rest.

| Key | Address | Signs |
|---|---|---|
| `rh-deployer` | `deployer` in the record | the router, and the record |
| `payer` | `exampleMandate.principal` in the record | the example mandate's `setRouter` and its two policies |

**Balances.** On the fork the deploy key used 1.9 million gas and the payer 0.2 million. At the
0.021 gwei the chain charges that is under 0.0001 ETH each. No USDG is needed.

**The shell.** Every command below runs in one shell set up like this. Start it fresh.

```sh
cd contracts
source script/env/rhc-mainnet-v6.env        # BURSAR_RECORD and RHC_RPC_URL
export KEYS="$HOME/.config/bursar/keystore"

simulate() { local script="$1" key="$2"; shift 2; forge script "$script" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/$key" "$@"; }
send() { simulate "$@" --broadcast --slow; }
readback() { cast call --rpc-url "$RHC_RPC_URL" "$@"; }
at() { jq -r "$1" "$BURSAR_RECORD"; }
```

Run every `send` as a `simulate` first, with the same arguments, and read what it prints.

## Rehearse first

```sh
export CHAINSTACK_RHC_RPC_URL=...                    # from ~/.config/bursar/chainstack.env
BURSAR_RHC_FORK_RPC="$CHAINSTACK_RHC_RPC_URL" forge test --match-path 'test/script/fork/SellFork.t.sol' -vv
forge test --match-path 'test/script/DeployStockRouter.t.sol'
```

The first forks mainnet at the block the suite pins and runs the example mandate through a purchase,
a release and a sale on the live pool and feed, with the band, stale-feed, slippage and sale-policy
refusals. The second runs both steps below against a local deployment. Start only when both pass.

## The steps

| Step | Who signs | Then wait |
|---|---|---|
| 1. Deploy the router | deploy key | |
| 2. The example mandate adopts it | payer | |
| 3. Publish the record and the apps | deploy key, then the operator | |

### 1. Deploy the router

```sh
simulate script/DeployStockRouter.s.sol rh-deployer
send script/DeployStockRouter.s.sol rh-deployer
```

The run refuses a record whose router already sells, a registry or guard the record names without
code behind it, and a previous router on another registry or guard. It writes the new address to
`rwa.StockSpendRouter` and the old one to `rwa.previousStockRouter`.

```sh
router="$(at .rwa.StockSpendRouter)"
readback "$router" "registry()(address)"                     # rwa.AssetRegistry
readback "$router" "guard()(address)"                        # rwa.PriceGuard
readback "$router" "custodyOf(address)(address)" "$(at .exampleMandate.address)"
```

### 2. The example mandate adopts it

```sh
simulate script/DeployStockRouter.s.sol payer --sig "repointExample()"
send script/DeployStockRouter.s.sol payer --sig "repointExample()"
```

Three calls from the payer: `setRouter` on the mandate, `setPolicy` at a 1% slippage limit with
every listed stock allowed to buy, and `setSalePolicy` with every listed stock allowed to sell. The
run is repeatable and refuses any key but the mandate's principal.

```sh
mandate="$(at .exampleMandate.address)"
readback "$mandate" "router()(address)"                                       # the new router
readback "$router" "saleAllowed(address,address)(bool)" "$mandate" "$(at .rwa.assets.SPY.address)"   # true
```

### 3. Publish the record and the apps

```sh
forge script script/VerifyRwa.s.sol --rpc-url "$RHC_RPC_URL"
git add deployments/rhc-mainnet-v6.json
cd .. && pnpm --filter @bursar/core codegen && pnpm --filter @bursar/core build
```

Commit the record and `packages/core/src/generated/deployments.ts` together, and deploy the console
from that commit. The console needs no new environment variable: it reads the router from the
record. The MCP server picks the router up from the same record at its next start; a server running
with its own `BURSAR_RECORD` copy needs that copy refreshed. The SDK, the MCP server and the core
package go to npm from the same commit so that `rwa().sell` and `mandate_sell_stock` name the
router the chain holds.

### Then

- Each mandate's principal adopts the router from the console's trading policy, or with
  `rwa(mandate).useRouter()` followed by `setPolicy` and `setSalePolicy` in the SDK. Until then the
  mandate keeps buying through the previous router and cannot sell.
- The first mainnet sale: the payer buys $0.50 of SPY under the example mandate, releases it with
  `rwa(mandate).release('SPY', raw)`, and sells it with `rwa(mandate).sell('SPY')`, inside the
  24/5 session or within 26 hours of the last feed answer. Record the three transactions in
  `docs/bullish/uniswap-sell.md`.
