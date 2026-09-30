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
| `Reputation` | The cap curve: base cap, cap per score point, maximum cap. |
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
