# Mutation testing

A mutant is one small change to a contract: a statement replaced by a revert, a line commented
out, an operator or a literal swapped. The tests are run against each mutant in turn. A mutant
they fail on is caught; a mutant they still pass on is behaviour nothing checks. The score is the
share of mutants caught. It measures the tests, not the contract.

The campaign covers `contracts/src/Escrow.sol`, the contract that holds every payment, and runs
the escrow tests (`contracts/test/Escrow*.t.sol`) against each mutant. It runs on demand through
`.github/workflows/mutation.yml`, which keeps the log and the survivors' diffs as the
`escrow-mutation` artifact for 30 days, or locally from `contracts/`:

```sh
MUTATORS=RR,CR test/mutation/escrow.sh    # the two severe classes: revert and comment
test/mutation/escrow.sh                   # every class
```

The script needs `slither-mutate` from slither-analyzer 0.11.6 and the Foundry release pinned in
`contracts/.foundry-version`. It pins the fuzz seed, so a mutant is caught or missed for the same
reason on every run, and puts the source back whatever happens. The severe classes alone take over
an hour.

## Committed score

| | |
|---|---|
| Date | 1 October 2026 |
| Target | `contracts/src/Escrow.sol` |
| Command | `MUTATORS=RR,CR test/mutation/escrow.sh`, from `contracts/` |
| Seed | `FOUNDRY_FUZZ_SEED=0x4663`, set by the script |
| Revert mutants (RR) | 103 of 108 caught |
| Comment mutants (CR) | 135 of 153 caught |
| Together | 238 of 261 compiling mutants caught, 91.2% |
| Survivors | 23 |

## The survivors

Nineteen of the 23 were in the escrow's governance surface: the brake could be commented out, the
pauser's guards dropped, and the events a reopen, a ruling, a treasury handover and a disclosure
grant publish silenced, with nothing in the escrow's tests failing.
[`EscrowGovernance.t.sol`](../contracts/test/EscrowGovernance.t.sol) was written from those
diffs. Each of its cases fails on exactly the change that survived.

The four left are the gas-starvation guards. Four best-effort calls in the escrow must not be able
to block a settlement: the resolver reward notice, a payout to an address the token refuses, the
payer's refund hook and the reputation write. A failure in any of them is recorded and the
settlement goes on. `_requireNotStarved` tells a callee that failed on its own from one the caller
starved of gas under the 63/64 rule, and reverts in the second case, so a tight gas limit cannot
turn a ruling into a silent skip. A mutant that removes one of the four checks passes, because no
test yet drives a settlement with a gas limit tuned to starve exactly one of those calls. The
guards stand; the test that pins them is still to be written.

A rerun that changes these figures replaces this table, with its date.
