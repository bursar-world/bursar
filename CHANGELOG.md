# Changelog

Notable changes to Bursar, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Contract deployments are recorded
with their chain and date, because a deployed contract does not change when this repository does.

## [Unreleased]

## [0.1.0] - 2026-09-27

First public release. Everything below is live on Robinhood Chain mainnet (chain 4663) and
settles in USDG.

### Contracts

Deployed on 2026-09-22. Addresses and full deployment records are in `contracts/deployments/`.

- `MandateAccount` and `MandateAccountFactory`: a principal's spending mandate, with per-call,
  daily and monthly caps, allowed payees and capabilities, an approval threshold above which the
  principal signs each spend, and a revocable agent key.
- `Escrow`: holds each payment for the life of one job, with release, refund on timeout,
  cancellation and disputes. 1% protocol fee, 0.5% resolver fee on disputed locks, 5% dispute
  bond.
- `Reputation`: per-payee settlement history and a per-job payee cap that starts at 25 USDG and
  rises with that history to at most 125 USDG under the current curve. The contract ceiling is
  250 USDG.
- `OracleRegistry`: commit-reveal dispute resolution by bonded resolvers, with a quorum of two.
- `AgentRegistry`: staked directory of counterparties, with a 5 USDG minimum stake.
- `AdminTimelock`: two-of-three governance with a 48-hour delay and a pause-only guardian.
- `BRSR`: fixed supply of one billion, split 80% community (held by the timelock), 10% team
  (in `Vesting`, four years with a one-year cliff), 5% treasury and 5% liquidity.
- `Staking`: resolver bonds in BRSR with a 25,000 BRSR floor, and a fee rebate table of four
  tiers from 5% to 30%, set by governance on 2026-09-24.
- `Buyback`: spends protocol revenue on BRSR in a Uniswap v4 pool. It trades once the BRSR/USDG
  pool is seeded and governance sets a price ceiling.

### Packages

- `@bursar/sdk`: pay a provider from an agent inside a mandate, with quotes, escrowed payment,
  remaining limits and typed errors.
- `@bursar/mcp`: the same capability as an MCP server bound to one mandate.
- `@bursar/x402`: x402 v1 and v2 codec and the `exact` EVM scheme for USDG, supporting EIP-3009,
  EIP-2612 permits and Permit2, with payments bound to the request they pay for.
- `@bursar/core`: chain configuration, generated contract addresses and ABIs, six-decimal money
  types, and an RPC pool with rate limits, failover and a circuit breaker.

### Services

- Facilitator: verifies and settles x402 payments, with prefund, collateral and direct funding
  lanes, a Postgres ledger and a trust event outbox.
- Underwriter: decides whether an agent may spend against the live mandate account and records
  each decision in a hash-chained journal.
- Sidecar: runs on the provider's side, watches escrow for its jobs, delivers output and releases
  payment.

### Console

- [app.bursar.world](https://app.bursar.world): create and fund mandates, review activity,
  approvals and settlements, the provider and resolver desks, governance, operations, network
  status and token information, all read from the contracts on chain.

[Unreleased]: https://github.com/bursar-world/bursar/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bursar-world/bursar/releases/tag/v0.1.0
