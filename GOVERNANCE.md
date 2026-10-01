# Governance

Bursar has two kinds of decision. Changes to this repository are made by its maintainers through
pull requests. Changes to the deployed contracts on Robinhood Chain are made on chain, through
the `AdminTimelock` contract, and a merged pull request alone never changes them.

## Maintainers

The core team maintains the project as the `@bursar-world/maintainers` team on GitHub.
Maintainers review and merge pull requests, triage issues, cut releases, handle security
reports and enforce the [Code of Conduct](CODE_OF_CONDUCT.md). `.github/CODEOWNERS` routes every
review request to that team.

## How decisions are made in the repository

- Most changes are decided in review. One maintainer's approval merges a change. A change to
  `contracts/` also needs a second approval once the project has three or more maintainers.
- Larger changes, such as a new package, a new service or a change to a contract's behaviour,
  start as an issue or a discussion so the approach is agreed before the code is written.
- Maintainers aim for consensus. When it cannot be reached, the maintainers decide by simple
  majority, and the reasoning is written down in the issue or pull request.
- Security fixes may be prepared in private and merged without the usual public review. They are
  explained publicly once the fix is live; see [SECURITY.md](SECURITY.md).

## How protocol parameters change

Chain 4663 has three timelocks, one per contract set:

- `AdminTimelock` v3 at `0xD91A6577828424E386900D0bB41596c6eF3BF8DF` administers `Reputation`,
  `OracleRegistry` and `AgentRegistry` of the current set, together with its `Staking` pool and
  `Buyback`, and is the current escrow's pauser.
- `AdminTimelock` v2 at `0x135eF562ac57845AeA1Bb650fc0E74D67A4a866B` administers the same three
  contracts of the previous set and is the v2 escrow's pauser.
- `AdminTimelock` v1 at `0x5a32Eab02454f97a39857E85b536F83EE0f844Bf` administers the v1 set, the
  earlier `Staking` pool and `Buyback` that the v1 and v2 registries read, and `Vesting`, which
  every set shares. It also holds the community allocation of BRSR. `Vesting` and that allocation
  pass to the v3 timelock through a proposal on the v1 timelock, with its 48-hour delay.

All three have the same signers and the same guardian. What that means in practice:

- **Three signers, two approvals.** Any signer can propose a call. Proposing counts as that
  signer's approval, so one more signer has to approve before it can run.
- **A fixed delay.** A proposal becomes executable 48 hours (172,800 seconds) after it is created
  on the v1 timelock. The delay is set when a timelock is deployed, has no setter, and on v1
  cannot be below 48 hours or above 30 days. The v2 and v3 timelocks are development deployments
  with a one-hour delay and a one-hour minimum; the current one is replaced by one with a 48-hour
  delay before the public launch. The delay is the window in which anyone can read a pending
  change and act on it.
- **A grace period.** An approved proposal that is not executed within 14 days of becoming
  executable expires and has to be proposed again.
- **Cancellation.** On v2 and v3, a proposer can withdraw its own pending proposal. Cancelling anyone
  else's takes vetoes from two signers, so one key cannot block its own removal or keep a pause in
  place by cancelling every unpause. On v1, any single signer can cancel a pending proposal.
- **The guardian.** A separate guardian key can pause contracts in the same block, with no
  approvals and no delay: on v3 the escrow, `OracleRegistry`, `AgentRegistry`, `Staking` and
  `Buyback`; on v2 the escrow, `OracleRegistry` and `AgentRegistry`; on v1 `AgentRegistry`,
  `Staking` and `Buyback`. It can do nothing else. Unpausing, replacing the guardian and replacing
  a signer are ordinary proposals with the full delay.

Proposals, approvals and executions are public events on chain. The console's governance page at
[app.bursar.world/governance](https://app.bursar.world/governance) lists them and lets a signer
act on them.

What the timelock can change:

| Contract | Parameters under the timelock |
|---|---|
| `Reputation` | The cap curve: base cap, cap per score point, maximum cap. The scoring weights: the smallest payment that counts, the most one payer counts for, and the settled volume a full score takes. |
| `OracleRegistry` | Commit and reveal windows, unbonding period, quorum, voter limit, deviation band, slash rate, slash sink, and slashing a resolver by governance ruling. |
| `AgentRegistry` | Minimum stake, slash rate, slasher, slash sink, the blocklist, pause. |
| `Staking` | Fee rebate tiers, unbonding period, the global and per-resolver bond floors, denying a resolver's bond, credit manager, treasury, slash sink, pause. |
| `Buyback` | Spend per call and per window, minimum spend, price ceiling, window, interval, pause. |
| `Vesting` | Revoking a grant, forward only. |

What it cannot change:

- `Escrow` has no admin. Its fees, time-to-live bounds and dispute windows are fixed at
  deployment, and a change to any of them is a new deployment. The v3 escrow names the v3 timelock
  as its pauser, and the v2 escrow the v2 timelock. A pause stops new locks and new disputes;
  payments already held can still be released, refunded and ruled on.
- `MandateAccountFactory` has no admin, and each `MandateAccount` is controlled by its own
  principal. Governance cannot move a principal's funds or change a mandate's limits.
- `BRSR` has a fixed supply, no minter and no owner.
- The escrow's fee recipient is changed only by the current recipient, in two steps.

In the current release the three signers and the guardian are individual keys held by the core
team. Moving the signer set to a multisig will itself go through the timelock and be visible on
chain.

Replacing a contract that has no admin, such as `Escrow`, means a new deployment with the scripts
in `contracts/script/`, joined to the existing timelock so that one governance process covers the
whole system. Any such change is announced in [CHANGELOG.md](CHANGELOG.md) and on
[X](https://x.com/UseBursar) before it takes effect.

## Privileged roles

Every key or contract that can do something an ordinary user cannot, for the current set on chain
4663. Holders are given as the key in `contracts/deployments/rhc-mainnet-v3.json` that names them,
with the address that record holds today, so the tables can be refreshed from the record. Each
power was taken from the contract source under `contracts/src` and from the vendored
`Entrypoint.sol`; what each contract must always hold is in [docs/INVARIANTS.md](docs/INVARIANTS.md),
and the steps for using or rotating a key are in [docs/RUNBOOK.md](docs/RUNBOOK.md).

### Governance keys

| Role | Holder today | Can | Cannot | Delay |
|---|---|---|---|---|
| Timelock signers (three keys, two approvals) | `roles.timelockSigners`: `0xb51c63568324848DfC88A09f91F06fA86771aB69`, `0x3C7facc7C72c3aCeB2EF93703813652aC9039266`, `0x1f3eE000728EF363B9F867f88BBF618F2A17c42d` | Propose any call from `AdminTimelock` at `contracts.AdminTimelock`, approve, execute once the delay has passed, withdraw their own proposal, veto another's (two vetoes cancel it). Through the timelock: every setter in the next table, and `updateSigner` and `setGuardian` on the timelock itself. | Act alone: one key's proposal needs a second key before it can run, and nothing runs inside the delay. Bypass the delay, pause without a proposal, or reach a contract the timelock does not administer. | One hour on the current timelock, 48 hours on the first set's, plus a 14-day grace period in which an approved proposal can still run. |
| Guardian | `roles.guardian`: `0x7cfF32B8B4DB47E2Cde5907c8F5c93EC6a095E2A` | Call `guardianPause` on the timelock, which calls `pause()` on each target in the same block. Reaches `Escrow` (the timelock is its pauser), `OracleRegistry`, `AgentRegistry`, `Staking` and `Buyback` of the current set. | Unpause, propose, approve, hold a signer seat, or send any calldata other than `pause()`. The worst a lost guardian key can do is an outage that lasts until an unpause proposal lands. | None. |

### The timelock as administrator

`AdminTimelock` at `contracts.AdminTimelock` (`0xD91A6577828424E386900D0bB41596c6eF3BF8DF`) is the
admin of every contract below. Each setter runs only as a proposal with two approvals after the
one-hour delay. On Bursar's own contracts the admin role moves in two steps (`transferAdmin`, then
`acceptAdmin` by the new admin), so a mistyped address cannot orphan a contract; the vendored
`Entrypoint` grants and revokes its roles directly.

| Contract (record key) | Setters under the timelock | Cannot |
|---|---|---|
| `Reputation` (`contracts.Reputation`) | `setCurve` (base cap, cap per score point, maximum cap), `transferAdmin`. | Edit a payee's history; only the escrow writes it. |
| `OracleRegistry` (`contracts.OracleRegistry`) | `setConfig` (commit and reveal windows, unbonding period, quorum, voter limit, deviation band, slash rate), `setSlashSink`, `slash` (a governance ruling against one resolver's bond), `evict` (unseat a resolver whose bond backs no open vote and return what is left), `pause`, `unpause`, `transferAdmin`. | Touch a live dispute's windows, change the bond token or the escrow it answers, or take resolver rewards. |
| `AgentRegistry` (`contracts.AgentRegistry`) | `setMinStake` (at most 10,000 USDG), `setSlashBps` (at most 50%), `setSlasher`, `setSlashSink`, `setBlacklistRoot`, `clearBlacklist`, `slash` (clamped to `slashBps` of the stake per call), `sweep` (settlement asset only above `totalStaked`, any other token in full), `pause`, `unpause`, `transferAdmin`. | Take more than the slash ceiling from a stake in one call, or reach staked collateral through `sweep`. Matured withdrawals execute while paused. |
| `Staking` (`token.Staking`) | `setTiers` (fee rebate table, at most 50% off), `setUnbondingPeriod`, `setUnbondWindow`, `setMaxExitHold`, `setSlashLimit`, `setMinBond`, `setBondFloor` (per resolver), `setBondingDenied`, `setCreditManager`, `setSlasher`, `setSlashSink`, `setTreasury`, `pause` (also holds matured exits for `maxExitHold`, seven days), `unpause`, `transferAdmin`. | Take stake itself: only the slasher can, within the slash allowance. Reach rewards already earned. |
| `Buyback` (`token.Buyback`) | `setParams` (spend per call and per window, minimum spend, price ceiling, window, interval; every call restates the ceiling), `setKeeper`, `setMaxCeilingAge`, `sweep` (any token, only to the treasury fixed at construction), `pause`, `unpause`, `transferAdmin`. | Change the pool it trades or the treasury it sweeps to; both are immutable. |
| `V4LiquiditySeeder` (`token.V4LiquiditySeeder`), as owner | `initializePool` (one shot, already done), `removeLiquidity`, `sweep`, `transferOwnership`. | Point the seeder at another pool. Anyone can add liquidity. |
| `AssetRegistry` (`rwa.AssetRegistry`) | `setAsset` (feed, staleness bounds, band, haircuts, caps, pinned pool), `setEligible`, `transferAdmin`. | Register an asset whose pool is not an asset/USDG pair without a hook, or set a band above 5%, a trade bound above 7 days or a valuation bound above 14 days. |
| `TreasuryPark` (`rwa.TreasuryPark`) | `setAdapter` (enable or disable a park adapter), `transferAdmin`. | Move a mandate's parked position; disabling an adapter stops new parks and leaves every exit open. |
| `CreditPool` (`rwa.collateral.CreditPool`) | `setCaps` (total and per-mandate debt), `setRates` (base and slope, together at most 50% a year), `setLender`, `transferAdmin`. | Lend or write off (only the vault can), or withdraw the pool's cash (only the lender can). |
| `CollateralVault` (`rwa.collateral.CollateralVault`) | `setParams` (minimum borrow health, liquidation target, bounty at most 10%), `setTier`, `setAssetTier`, `transferAdmin`. | Take or sell collateral outside a liquidation anyone can trigger below health 1.0. |
| `SolvencyLog` (`privacy.SolvencyLog`) | `setPoster`, `transferAdmin`. | Rewrite or remove a posted epoch. |
| `Entrypoint` (`privacy.shielded.Entrypoint`), as `OWNER_ROLE` | Upgrade the UUPS proxy's implementation, `registerPool`, `removePool`, `updatePoolConfiguration` (minimum deposit, vetting fee, maximum relay fee), `windDownPool` (irreversible; stops deposits, never withdrawals), `withdrawFees` (the vetting fees the Entrypoint holds), grant and revoke `OWNER_ROLE` and `ASP_POSTMAN`. | Change the pool's own caps (immutable in `ShieldedPool`), spend a note, or stop a depositor's ragequit, which never reads the Entrypoint. An upgrade waits out the same one-hour delay as any proposal. |
| `Vesting` (`token.Vesting`) | `revoke` (stops a grant's clock; what has vested stays claimable, the rest returns to the treasury), `sweep` (tokens above live grants), `transferAdmin`. | Shorten the schedule, move a grant, or take vested tokens. Today the admin is the first set's timelock at `0x5a32Eab02454f97a39857E85b536F83EE0f844Bf` (48-hour delay); its handover to the current timelock is a pending proposal there. |
| `Escrow` (`contracts.Escrow`), as pauser | `pause`, `unpause`. | Anything else: fees, deadline bounds and dispute windows are immutable, and the fee recipient moves only on the current recipient's own two-step call. |
| `AdminTimelock` itself | `updateSigner` (one seat at a time), `setGuardian`. | Change its delay, which is immutable. |

### One-shot wiring held by the deploy key

The deploy key, `deployer` (`0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4`), holds no admin role on
the current set. Each contract gave it exactly one call to wire the set together, and each refuses a
second call. All of them have been used.

| Contract | Call | Status |
|---|---|---|
| `Reputation` | `setEscrow` | Spent: `escrow()` is the current escrow. |
| `Escrow` | `setResolver`, `setRegistry`, `setPauser` | Spent: all three read the current registries and the timelock. |
| `OracleRegistry` | `setEscrow`, `setStaking` | Spent: the escrow and the current staking pool are set. |
| `Vesting` | `createGrants` | Spent on 2026-09-22: `grantsWritten()` is true. |
| `TreasuryPark` | `initAdapters` | Spent: both adapters are listed. |
| `CreditPool` | `bindVault` | Spent: `vault()` is the current vault. |
| `Entrypoint` | `initialize`, then `OWNER_ROLE` handed to the timelock and renounced | Spent: the timelock holds `OWNER_ROLE` and the deploy key does not. |

### Service keys

Each is one key run by the team, with no delay in front of it. None can change a parameter or
reach another party's funds.

| Role | Holder today | Can | Cannot |
|---|---|---|---|
| Resolvers (three keys, quorum two) | `roles.resolvers`: `0xD8D90e4c8f3419B1b8305dF2905eb31d3fBBf599`, `0xC284CdA6c6982447f202830f4e969F13cBcB0b94`, `0x7062A480732EC7B0F00a3D0c968356e1671dd356` | Commit and reveal a score on any dispute on `OracleRegistry`, each backed by a bond of 30,000 BRSR. Two agreeing scores decide a ruling. | Vote on a dispute they are party to, move a lock directly, or take a bond back inside seven days. A silent or outlying vote costs 10% of the bond. |
| Buyback keeper | `token.keeper`: `0xD8D90e4c8f3419B1b8305dF2905eb31d3fBBf599` (today the first resolver key) | Call `Buyback.buyback()` when the caps, the interval and the price ceiling allow. | Choose the amount, the price, the recipient or the pool. |
| Credit pool lender | `rwa.collateral.lender`: `0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4` (the deploy key) | Withdraw USDG that is neither lent out nor owed to stakers. | Touch lent cash, debt, or the spread set aside for stakers. |
| Solvency poster | `privacy.solvencyPoster`: `0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4` (the deploy key) | Post one root per UTC day to `SolvencyLog`, at a block not past the chain head. | Overwrite a posted epoch or post one for a day ahead. Anyone can recompute and check a root. |
| Association-set postman | `privacy.shielded.aspPostman`: `0x731F3BbbD40ae5387646A62D5F08C2517aA84bbe` | Post the association-set root the shielded pool accepts withdrawals against (`Entrypoint.updateRoot`). | Move funds, admit a deposit the access registry blocks (the pool checks the registry itself), or stop a depositor's ragequit, which needs no root. |
| Shielded relayer | `privacy.shielded.relayer`: `0xc8FB46218bA6750EBF8cE7Cc8f7a56D7C7F99630` | Submit a note owner's withdrawal through `ShieldedRelay`, pay its gas, take the fee the proof names (at most 5%), and send a gas drop to a fresh recipient. | Redirect a payout or raise its fee: both are bound into the proof. |
| Facilitator keys | Set per deployment in the facilitator's environment, not in the record. The service holds one key, `FACILITATOR_RELAYER_KEY`, which must be the gas float `FACILITATOR_GAS_FLOAT`. | Broadcast the EIP-3009 authorisations payers signed and pay their gas. | Sign for the settlement, collateral or treasury addresses (`FACILITATOR_SETTLEMENT`, `FACILITATOR_COLLATERAL`, `FACILITATOR_TREASURY`), which must differ from the gas float. A mandate-lane settlement broadcasts nothing. |

### Treasury and token holders

| Role | Holder today | Can | Cannot |
|---|---|---|---|
| Escrow fee recipient | `roles.treasury`: `0x7f2D3be9597fb538BDBA3Dbcb9BEcECCD9056d21` | Receive swept fees (anyone can sweep), and name its successor in two steps (`transferTreasury`, `acceptTreasury`). Also the treasury `Staking`, `Buyback` and `Vesting` send to. | Change a fee or reach a lock. The timelock cannot move this role. |
| Slash sink | `roles.slashSink`: `0xb4A7D77a710f6b1fF4cDDd9D3c9b66E3f917A4FF` | Receive slashed bonds and stakes and orphaned resolver rewards. | Anything else; it receives and holds no power. |
| Liquidity key | `roles.liquidity`: `0x0DF776dBD1Ce5A8F38993Bc98bc3D81661FA51B2` | Holds what is left of the 5% liquidity allocation of BRSR and owned the first seeder, now empty. | Take liquidity out of the current seeder, which the timelock owns. |
| Community allocation holder | The first set's timelock at `0x5a32Eab02454f97a39857E85b536F83EE0f844Bf`, until its pending proposal transfers the 800,000,000 BRSR to the current timelock. | Release community BRSR by two-of-three proposal, 48 hours after it is made. | Mint: the supply is fixed. |

### No privileged party

`MandateAccountFactory` and `CommittedMandateFactory` have no admin, and each account they create
answers only to its principal. `BRSR` has no minter, owner or pauser. `PriceGuard`,
`StockSpendRouter`, the park adapters, `DisclosureRegistry`, `WithinMandateVerifier`,
`ShieldedPool` and `ShieldedRelay` hold their configuration in immutables and have no setter. The
first and second sets are administered by their own timelocks, which have the same signers and
guardian as the current one.

## Becoming a maintainer

Maintainers are added by the existing maintainers. We look for someone who has:

- contributed substantial, well-tested changes over several months;
- reviewed other people's pull requests carefully and constructively;
- shown good judgement about security and about changes that affect funds on chain.

Any maintainer can nominate a contributor. The nomination is accepted when a majority of
maintainers agree and nobody raises an unresolved objection within a week. A maintainer who has
been inactive for six months, or who asks to step down, is moved to emeritus status and can
return by the same process.

Holding a timelock signer or guardian key is a separate responsibility from being a maintainer,
and changes to the key holders happen on chain through the timelock.

## Changing this document

Changes to this document are made by pull request and need approval from a majority of
maintainers.
