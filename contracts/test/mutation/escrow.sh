#!/usr/bin/env bash
# Mutation campaign over src/Escrow.sol.
#
# A mutant is one small change to the contract: a statement replaced by a revert, a line commented
# out, an operator or a literal swapped. A mutant the tests still pass on is behaviour nothing
# checks. slither-mutate makes the changes one at a time and runs the escrow tests against each;
# this script gives it a compiler, a test command and a place to write, and puts the source back
# whatever happens.
#
# The campaign rewrites src/Escrow.sol in place for the length of each mutant, so it refuses to
# start unless that file matches HEAD, restores it from git on every exit, and must not share the
# checkout with another forge run. Each mutant costs one incremental compile and one run of the
# escrow tests, about ten seconds; the severe classes alone take over an hour, the whole set
# several.
#
# Needs forge at the pinned release and slither-analyzer 0.11.6 (pipx install
# slither-analyzer==0.11.6). The mutated file is parsed with the solc 0.8.24 that forge installed,
# so nothing is downloaded. The compile check on each mutant goes through forge and the forge
# cache: pointed at the project itself, the tool would clean the whole build before every mutant.
#
#   test/mutation/escrow.sh                   the whole campaign
#   MUTATORS=RR,CR test/mutation/escrow.sh    the two severe classes only
set -euo pipefail

cd "$(dirname "$0")/../.."

target=src/Escrow.sol
tests=${TESTS:-test/Escrow*.t.sol}
timeout=${TIMEOUT:-300}
log=${LOG:-cache/mutation-escrow.log}

command -v slither-mutate >/dev/null || { echo "slither-mutate is not installed" >&2; exit 1; }
git diff --quiet -- "$target" || { echo "$target differs from HEAD; commit or restore it first" >&2; exit 1; }

# Built once up front, so the compiler is installed and the run slither-mutate times before it
# starts is a warm one.
forge build >/dev/null

solc=$(find "$HOME/.svm" "$HOME/Library/Application Support/svm" -name solc-0.8.24 -type f 2>/dev/null | head -n 1 || true)
[ -n "$solc" ] || { echo "forge has not installed solc 0.8.24" >&2; exit 1; }

# Survivors and backups go to a scratch directory: the tool deletes and recreates its output
# directory, and a path under the checkout would be in the way of the build it drives.
scratch=$(mktemp -d "${TMPDIR:-/tmp}/escrow-mutation.XXXXXX")
trap 'git checkout -q -- "$target"; rm -rf "$scratch"' EXIT

# The seed CI uses, so a mutant is caught or missed for the same reason on every run.
FOUNDRY_FUZZ_SEED=0x4663 slither-mutate "$target" \
  --contract-names Escrow \
  --test-cmd "forge test --match-path '$tests'" \
  --compile-force-framework solc \
  --solc "$solc" \
  --solc-remaps "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/" \
  --solc-args "--evm-version cancun" \
  --timeout "$timeout" \
  --output-dir "$scratch/campaign" \
  --verbose \
  ${MUTATORS:+--mutators-to-run "$MUTATORS"} 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tee "$log"

[ -f "$scratch/campaign/patches_files.txt" ] && cp "$scratch/campaign/patches_files.txt" "${log%.log}-survivors.diff"

echo
echo "surviving mutants: $(grep -c 'UNCAUGHT' "$log" || true)"
awk '/mutants: [0-9]+ caught of [0-9]+/ { caught += $3; total += $6 }
  END { if (total) printf "mutation score: %d of %d mutants caught (%.1f%%)\n", caught, total, 100 * caught / total }' "$log"
echo "the log is $log; surviving mutants as diffs in ${log%.log}-survivors.diff"
