# Agents sell and rebalance Robinhood stocks back to USDG on Uniswap, inside the budget

## Progress

- 2026-10-10 15:30 UTC: read the lane. A mandate account lets only its principal move a token out, so a
  sale needs an owner-released custody; the router gains `sell`, `recall`, `custodyOf`, `sellable`,
  `minUsdgFor` and a per-asset sale policy.
- 16:30 UTC: router written and compiling; 21 unit tests on the RWA fixture green; four fork tests green on
  a pinned mainnet fork (block 85106897) through the Chainstack endpoint: buy $0.50 SPY, release, sell for
  0.499374 USDG; band, stale-feed, slippage, after-hours and sale-policy refusals.
- 17:10 UTC: deploy script and its world test green; full offline contract suite green (1119 tests).
- 22:30 UTC: SDK `sell`, `release`, `recall`, `sellQuote`, `setSalePolicy`, `salePolicy` with offline tests,
  766 SDK tests green. Next: MCP `mandate_sell_stock`, the console, the fork demo and the assets.
