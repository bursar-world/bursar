# Changelog

Notable changes to Bursar, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Contract deployments are recorded
with their chain and date, because a deployed contract does not change when this repository does.

## [Unreleased]

Everything below is live on Robinhood Chain mainnet (chain 4663). The current set is a
development deployment: its timelock delay and its dispute vote windows are one hour each, so a
change can be exercised within a day. The 48-hour delay returns before the public launch. Full
records are in `contracts/deployments/`.

### The Base lane

- A mandate pays an x402 service on Base in USDC. `mandate.fetch(url, { lane: 'base' })` in
  `@bursar/sdk` asks the facilitator what to lock, locks that USDG for the facilitator's Base lane
  address through the account's own `spend`, and carries the facilitator's EIP-3009 authorization,
  signed from a USDC float it holds on Base, to the service. The service's own facilitator settles
  it. Once USDC reports the authorization used the lock releases to the lane's address; one that
  expires unused is cancelled and the mandate's windows are credited. One USDG buys one USDC plus a
  fee the quote states. Refusals arrive as `BaseLaneRefusedError`, in sentences.
- The facilitator gains five routes without a token (`/base/quote`, `/base/pay`,
  `/base/payments/:id`, `/base/payments/:id/outcome`, `/base/float`), a worker on the maintenance
  pass, the `bursar_base_payments` ledger (migration 0013) and the `FACILITATOR_BASE_*` settings.
  The lane is off until `FACILITATOR_BASE_KEY` is set. `@bursar/core` carries `BASE_MAINNET`.

### Contracts

- Fourth contract set, deployed 2026-10-01 and now the live record (`rhc-mainnet-v4.json`). The
  third set's `AdminTimelock`, `BRSR`, `Vesting`, `Staking`, `Buyback` and `V4LiquiditySeeder`
  carry over at the same addresses; every other contract is new, including a fresh shielded pool
  behind its own `Entrypoint`. The third set stays on chain and keeps serving the mandates, locks
  and disputes opened through it. What changed with the set:
  - `Reputation`: a score now weighs how much a payee has settled and with how many payers, as
    well as how many of its jobs ended well. A job of 1 USDG or more counts, each payer counts for
    at most 62.5 USDG of credit, and a full score takes 250 USDG of credit, so at least four
    payers. The cap curve is unchanged: 25 USDG with no history, 2.25 USDG more per point, 250 USDG
    at a score of 100. Governance sets the three weights the way it sets the curve. `payeeStats`,
    `edges`, `score` and `capOf` read as before, with `creditOf`, `edgeVolume` and `weights` beside
    them, and the escrow passes each job's amount along with its outcome.
  - `AgentRegistry`: a provider can ask for its stake back while the registry is paused. The
    seven-day delay is unchanged, and so is what a pause stops: new registrations, top-ups and
    reactivations.
  - The collateral lane lends against a position only once its pool has been observed at least
    five minutes earlier and agreed with its price feed. A feed that jumps more than 15% since that
    reading, or goes quiet in session, halts new borrowing; repayments, and withdrawals from a line
    with no debt, are unaffected. A keeper run every five minutes keeps the readings current. A
    written-off line's remaining collateral goes to the lender.
  - The shielded pool takes at most 250 USDG from one address in any seven days, beside the
    100 USDG per deposit and 1,000 USDG pool caps. An address the access registry has since blocked
    can still take out what it put in.
  - A payment made for an x402 call through the escrow lane commits the request when the lock is
    made: the method, the endpoint and a commitment to the request body are its published input.
    Ruling policy version 3 applies from the same day.
- Third contract set, deployed 2026-09-30 (`rhc-mainnet-v3.json`), now superseded. Every contract
  was new except `BRSR` and `Vesting`. Its `AdminTimelock`, which the fourth set keeps, has a
  one-hour delay; a proposer can withdraw its own proposal, and cancelling anyone else's takes
  vetoes from two signers. Reputation caps start at 25 USDG and rise 2.25 USDG per score point to
  the 250 USDG ceiling. Dispute commit and reveal windows are one hour each.
- Second contract set, deployed 2026-09-28 (`rhc-mainnet-v2.json`), now superseded. The first set
  with a one-hour delay. Mandates gained spend classes, a lifetime total and a settlement lane. Its
  contracts stay on chain and keep serving the mandates, locks and disputes opened through them.
- Stock purchases and the treasury lane: `AssetRegistry`, `PriceGuard`, `StockSpendRouter` and
  `TreasuryPark`. Purchases of SPY, NVDA and AAPL are capped at 25 USDG per trade, parking in SGOV
  at 100 USDG per mandate and 1,000 USDG in total. Every trade is priced by the asset's feed and
  checked against its pinned Uniswap v4 pool.
- The collateral lane: `CreditPool` lends USDG to a mandate against stock or treasury tokens posted
  in `CollateralVault`, 10 USDG per mandate and 100 USDG in total, with liquidation below a health
  of 1.0. The pool's spread is paid to BRSR stakers.
- Committed mandates: a mandate whose terms are a commitment, with every spend proven inside them
  by `WithinMandateVerifier`. Each committed mandate can lock at most 25 USDG over its life.
  `DisclosureRegistry` lets a party to a dispute grant one resolver one slice of the job, and
  `SolvencyLog` takes a daily root over the protocol's public obligations and the balances behind
  them.
- Shielded settlement on Privacy Pools v1.3.0: a USDG `ShieldedPool` capped at 100 USDG per
  deposit and 1,000 USDG in the pool, behind the upstream `Entrypoint`, and a `ShieldedRelay`
  that screens recipients against the Robinhood Chain access registry.
- `Staking` is now a share pool behind the collateral lane: it earns the credit pool's spread, is
  slashed when a line is written off, and holds the resolver bond floors. The three vetted
  resolvers have a floor of 30,000 BRSR each; nobody else can bond. `Buyback` names a keeper and
  trades under a price ceiling of 240 micro-USD per BRSR that expires seven days after it is set.
- The BRSR/USDG market opened on 2026-09-29 at 200 micro-USD per BRSR, and the position moved into
  a `V4LiquiditySeeder` the current timelock owns.
- `Vesting` and the community allocation of BRSR move from the first timelock to the current one
  through proposals on the first timelock, with its 48-hour delay.

### Services

- Resolver: votes the three bonded resolver keys on every dispute under the published
  [ruling policy](docs/RULING-POLICY.md), with a backup runner that reveals from the keystores
  alone. Ruling policy version 3 from 2026-10-01; version 2 before that.
- Association-set provider and relayer for the shielded pool, and a solvency service that posts
  the daily root.

### Documentation

- An operations runbook, `docs/RUNBOOK.md`, and an hourly monitor of the live deployment,
  `contracts/script/monitor.mjs`.
- `GOVERNANCE.md` lists every privileged role, and `SECURITY.md` states the trust assumptions and
  current limits.
- Two annotated tags mark what was reviewed: `audit-2026-10-01`, the commit the external review
  read, and `rescore-2026-10-02`, the state read again after its findings were closed.
  `SECURITY.md` lists them under Reviews.
- Every statement in `docs/INVARIANTS.md` links to the test that checks it, and `docs/MUTATION.md`
  records the escrow mutation campaign's score with its survivors.

## [0.1.0] - 2026-09-27

First public release. Everything below is live on Robinhood Chain mainnet (chain 4663) and
settles in USDG.

### Contracts

The first contract set, deployed on 2026-09-22 and recorded in
`contracts/deployments/rhc-mainnet.json`. It has since been superseded by the sets above; its
contracts stay on chain and keep serving the mandates, locks and disputes opened through them.

- `MandateAccount` and `MandateAccountFactory`: a principal's spending mandate, with per-call,
  daily and monthly caps, allowed payees and capabilities, an approval threshold above which the
  principal signs each spend, and a revocable agent key.
- `Escrow`: holds each payment for the life of one job, with release, refund on timeout,
  cancellation and disputes. 1% protocol fee, 0.5% resolver fee on disputed locks, 5% dispute
  bond.
- `Reputation`: per-payee settlement history and a per-job payee cap that starts at 25 USDG and
  rises with that history to at most 125 USDG under the curve this set deployed with. The
  contract ceiling is 250 USDG.
- `OracleRegistry`: commit-reveal dispute resolution by bonded resolvers, with a quorum of two.
- `AgentRegistry`: staked directory of counterparties, with a 5 USDG minimum stake.
- `AdminTimelock`: two-of-three governance with a 48-hour delay and a pause-only guardian. This
  first timelock keeps its 48-hour delay; the later sets' timelocks are development deployments
  with a one-hour delay, as described under Unreleased and in [GOVERNANCE.md](GOVERNANCE.md).
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
