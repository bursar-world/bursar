# Static analysis

The contracts under `contracts/src` are run through [Slither](https://github.com/crytic/slither),
the static analyser from Trail of Bits, on every push to `main`, on every pull request that touches
`contracts/`, and once a week. The run fails on any finding of High or Medium severity. Every
finding Slither has raised so far has been read and either fixed or answered where it stands, so
the run is clean: as of 1 October 2026 it reports no findings.

This page says what runs, how to run it yourself, what is in and out of scope, and what each
detector found and why it stands.

## What runs

| | |
|---|---|
| Tool | Slither 0.11.6 (`slither-analyzer` on PyPI), with crytic-compile 0.4.2 |
| Build | Foundry 1.8.1, the release pinned in `contracts/.foundry-version`, with the compilers and settings `contracts/foundry.toml` pins |
| Settings | `contracts/slither.config.json` |
| Workflow | `.github/workflows/slither.yml` |
| Fails on | any High or Medium finding (`fail_on: medium`) |
| Output | the log, and a SARIF report uploaded to the repository's code scanning |

The workflow installs the same Foundry release and the same three Solidity dependencies, at the
same commits, as the contracts job in `ci.yml`, so Slither reads exactly the build the tests run
against. Slither itself and every package it depends on are installed by version and by the
sha256 of each wheel.

## Reproduce it locally

With Foundry and the contracts' dependencies installed as
[`contracts/README.md`](../contracts/README.md) describes, two commands run the same analysis
with the same settings:

```sh
pipx install slither-analyzer==0.11.6
cd contracts && slither .
```

Slither picks up `slither.config.json` from the working directory. The last line of its output
is the summary; the exit code is non-zero when a High or Medium finding is present.

To list suppressions that no longer match a finding, add `--warn-unused-ignores`. Two lines about
`lib/openzeppelin-contracts/contracts/utils/Panic.sol` are expected: that directive belongs to the
library, whose findings are filtered out before suppressions are checked.

## Scope

Detectors report on Bursar's own contracts: everything under `contracts/src`, including
`src/shielded`, except `src/zk/WithinMandateVerifier.sol`, which snarkjs generates from the
circuit and which is checked by the proofs in the test fixtures rather than by reading it.

Everything else compiles as a dependency and is left to its own authors: `lib/` (forge-std and
OpenZeppelin Contracts), `vendor/` (the Privacy Pools core, Poseidon and the lean incremental
Merkle tree, each at the version `foundry.toml` builds it with), `test/` and `script/`.

Five detectors are switched off for the whole project, because every one of their reports here is
of the same shape and none describes a defect:

| Detector | Reports | Why it is off |
|---|---|---|
| `timestamp` | 83 | Every comparison is a deadline, window, cooldown or staleness bound measured in minutes to days, read against the sequencer's clock. A drift of seconds changes no outcome. |
| `naming-convention` | 22 | Immutables written in capitals and the EIP-712 names (`DOMAIN_SEPARATOR`, the type hashes). `forge lint` governs naming, with an inline exception at each of these. |
| `pragma` | 2 | The OpenZeppelin and Privacy Pools sources carry their own pragmas. `foundry.toml` pins which compiler builds what. |
| `assembly` | 5 | Reports the presence of inline assembly, not a defect. Each block is a few lines and tells the compiler it respects the memory layout: forwarding a revert, raising a custom error, and copying a blueprint's code. |
| `low-level-calls` | 8 | Reports the presence of a low-level call, not a defect. Each is a best-effort call whose failure the caller handles, with the reason in a comment at the call. |

Optimisation suggestions are off as well (`exclude_optimization`). The three it made are noted at
the end of the table below.

## Findings

Slither raised 281 findings on the first run over this scope. Each was read against the code.
Four were fixed, and reading two more led to a further change; both changes are described under
"What changed". The rest stand. Where the detector is still on, the line carries a
`slither-disable` comment that says why in a sentence or two. Each detector name in the table
links to Slither's own description of it.

| Detector | Severity | Count | Verdict | Reason |
|---|---|---|---|---|
| [`reentrancy-balance`](https://github.com/crytic/slither/wiki/Detector-Documentation#reentrancy-vulnerabilities-balance) | High | 1 | By design | `MandateAccount.buy` measures the fill from its own balance before and after the router call, under the reentrancy guard; nothing left open can move the bought token out of the account while the router runs, and the floor applies to what arrived. |
| [`weak-prng`](https://github.com/crytic/slither/wiki/Detector-Documentation#weak-PRNG) | High | 2 | False positive | `CollateralVault.inSession` takes a timestamp modulo a week and a day to find the weekday and time of day. Nothing is drawn at random. |
| [`divide-before-multiply`](https://github.com/crytic/slither/wiki/Detector-Documentation#divide-before-multiply) | Medium | 3 | By design | The spend windows advance by whole periods, so the division is meant to drop the part of a period already run; the resolver reward keeps the remainder of an integer split as dust for the sink. |
| [`incorrect-equality`](https://github.com/crytic/slither/wiki/Detector-Documentation#dangerous-strict-equalities) | Medium | 41 | By design | Every strict equality is a zero or sentinel check on a counter, an epoch, a ledger figure or the delta one transfer made. Where a third party could push the figure past zero, that only turns a refusal into the ordinary path. |
| [`locked-ether`](https://github.com/crytic/slither/wiki/Detector-Documentation#contracts-that-lock-ether) | Medium | 1 | False positive | The upstream `deposit` is payable for its native-asset pools. `ShieldedPool._pull` reverts on any value sent with one, and nothing else is payable, so no ether can enter. |
| [`reentrancy-no-eth`](https://github.com/crytic/slither/wiki/Detector-Documentation#reentrancy-vulnerabilities-1) | Medium | 5 | By design | `Escrow` books a payout the asset refused only after the transfer attempt, because the booking records the refusal; `TreasuryPark` writes a position after the adapter has traded, because the adapter reports the amount only then. Every entry point involved runs under the reentrancy guard. |
| [`uninitialized-local`](https://github.com/crytic/slither/wiki/Detector-Documentation#uninitialized-local-variables) | Medium | 7 | False positive | Counters, running totals and flags that start at zero or false on purpose. |
| [`unused-return`](https://github.com/crytic/slither/wiki/Detector-Documentation#unused-return) | Medium | 17 | By design | Price-guard calls made for their reverts, after a trade as well as before it; partial reads of a Chainlink round or a pool slot; a fill measured from balances instead of the router's claim; a repayment or write-off whose amount is already known or emitted. |
| [`calls-loop`](https://github.com/crytic/slither/wiki/Detector-Documentation#calls-inside-a-loop) | Low | 23 | By design | Loops over lists only governance extends (accepted assets, adapters, factories, pause targets), calling the lane's own registry, guard and adapters. The two loops that reach outside contracts, the guardian's pause and the unpark, carry on past a target that fails. |
| [`missing-zero-check`](https://github.com/crytic/slither/wiki/Detector-Documentation#missing-zero-address-validation) | Low | 18 | 4 fixed, 14 by design | Fixed: the constructors of `TreasuryPark`, `UsdgAdapter` and `RobinhoodStockAdapter`, where a zero would have been permanent. The rest: zero clears a role, switches an optional component off, or names a pending admin nobody can accept. |
| [`reentrancy-benign`](https://github.com/crytic/slither/wiki/Detector-Documentation#reentrancy-vulnerabilities-2) | Low | 7 | By design | Bookkeeping written after a call into a contract the deployment fixes: the pool manager, the lane's own credit pool, an account the factory has just created. Each caller is guarded. |
| [`reentrancy-events`](https://github.com/crytic/slither/wiki/Detector-Documentation#reentrancy-vulnerabilities-3) | Low | 4 | By design | Each event reports the result of the call it follows. |
| [`return-bomb`](https://github.com/crytic/slither/wiki/Detector-Documentation#return-bomb) | Low | 2 | By design | Both reads of a payer's `principal()` cap the gas of the call. The callee pays, out of that cap, to build whatever it returns, so copying the answer back is bounded by the same cap. Reading these two sites led to the `DisclosureRegistry` change below. |
| [`shadowing-local`](https://github.com/crytic/slither/wiki/Detector-Documentation#local-variable-shadowing) | Low | 21 | False positive | Interface setters name their parameter after the getter they set (`setAgent(address agent)`). An interface has no body in which the one could be read for the other. |
| [`timestamp`](https://github.com/crytic/slither/wiki/Detector-Documentation#block-timestamp) | Low | 83 | By design, detector off | See the table above. |
| [`assembly`](https://github.com/crytic/slither/wiki/Detector-Documentation#assembly-usage) | Informational | 5 | Detector off | See the table above. |
| [`low-level-calls`](https://github.com/crytic/slither/wiki/Detector-Documentation#low-level-calls) | Informational | 8 | Detector off | See the table above. |
| [`missing-inheritance`](https://github.com/crytic/slither/wiki/Detector-Documentation#missing-inheritance) | Informational | 1 | By design | The generated verifier does not declare the interface `CommittedMandateAccount` calls it through. snarkjs writes the verifier; the interface is kept where it is used. |
| [`naming-convention`](https://github.com/crytic/slither/wiki/Detector-Documentation#conformance-to-solidity-naming-conventions) | Informational | 22 | Detector off | See the table above. |
| [`pragma`](https://github.com/crytic/slither/wiki/Detector-Documentation#different-pragma-directives-are-used) | Informational | 2 | Detector off | See the table above. |
| [`too-many-digits`](https://github.com/crytic/slither/wiki/Detector-Documentation#too-many-digits) | Informational | 3 | False positive | The literal in each case is a contract's creation code, used to predict or deploy an address. |
| [`unindexed-event-address`](https://github.com/crytic/slither/wiki/Detector-Documentation#unindexed-event-parameters) | Informational | 1 | By design | `V4LiquiditySeeder.LiquidityRemoved` carries its recipient in the data. Indexing it now would change how every reader decodes the event. |
| [`cache-array-length`](https://github.com/crytic/slither/wiki/Detector-Documentation#cache-array-length) | Optimization | 2 | Not acted on | Two loops run only when an asset or adapter is added. The gas saved would be negligible. |
| [`immutable-states`](https://github.com/crytic/slither/wiki/Detector-Documentation#state-variables-that-could-be-declared-immutable) | Optimization | 1 | Not acted on | `CommittedMandateAccount.principal` is set once. Making it immutable changes the creation code, and with it every address the factory predicts. |

## What changed

Two changes came out of the triage. Both are in the contracts that are being redeployed, and
each has a regression test that fails against the code as it was.

**Zero addresses at construction.** `TreasuryPark`, `UsdgAdapter` and `RobinhoodStockAdapter`
accepted a zero address for values that cannot be changed afterwards: the park's settlement asset
and admin, each adapter's park, and the USDG adapter's asset. A deployment with a zero in any of
them would have had to be redone. The constructors now revert with `ZeroAddress()`. Tests:
`test/rwa/Rwa.t.sol`, the five `refusesAZero…` cases.

**Decoding a principal in `DisclosureRegistry`.** The registry asks each party of a disputed
lock for its `principal()`, with a gas cap, so the principal of a mandate account can grant
disclosure directly. The answer was decoded as an address, which reverts when the returned word
has bits set above the address range. A payer answering with such a word would have made the
payee's principal unable to grant on that lock, because the payer is asked first. The answer is
now read as a word and held to the address range, the way `OracleRegistry` already reads it; an
out-of-range word names nobody. Tests: `test/privacy/DisclosureRegistry.t.sol`.

## Keeping it clean

A new finding fails the run. The person who introduced it reads the code, and then either
changes it or adds a `slither-disable-next-line <detector>` comment (or a start/end pair) at the
line, with a sentence saying why the finding does not apply. Detectors are switched off only when
every report they make here is of one shape and none is a defect, and the table above is updated
when that happens.
