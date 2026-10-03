#!/usr/bin/env bash
# Rehearses the move to the fifth contract set on a copy of Robinhood Chain. anvil forks mainnet as
# it stands, and every step in script/MIGRATION-V5.md runs in the runbook's order with the same
# scripts and arguments. Each key signs as itself through anvil's impersonation, so no key from this
# machine is read, and the delays the runbook waits out are skipped with anvil's clock.
#
#   script/local/rehearse-mainnet.sh                            # from contracts/
#   BURSAR_HANDOVER_LANDED=1 script/local/rehearse-mainnet.sh
#
# The fifth record is written for the fourth set as it reads once its governance handover has
# landed, and the real move waits for that. With BURSAR_HANDOVER_LANDED set, the rehearsal lands the
# handover on the fork first: it skips to when the 48-hour timelock's acceptances are due, executes
# them as the first hardware signer, finishes the fourth record and runs the move against
# deployments/rhc-mainnet-v5.json as committed, so the wiring goes to the 48-hour timelock. Without
# it, the move runs against the chain as it stands, under the one-hour timelock, with a fifth record
# that takes its governance from the fourth as it reads today: the same scripts in the same order,
# the other governance.
#
# RHC_RPC_URL is the chain it forks, the public endpoint unless set, and BURSAR_ANVIL_PORT the
# port, 8549 unless set. The records it writes are copies under cache/bursar/fork, and it builds,
# logs its transactions and keeps forge's --resume data there too: nothing in deployments/, out/,
# broadcast/ or cache/ outside cache/bursar changes, so a real run's logs are never overwritten.
set -euo pipefail
cd "$(dirname "$0")/../.."

upstream="${RHC_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
port="${BURSAR_ANVIL_PORT:-8549}"
rpc="http://127.0.0.1:${port}"
anvil_pid=""
current="the port check"

step() {
  current="$1"
  printf '\n=== %s\n' "$1"
}

finish() {
  local status=$?
  if [ -n "$anvil_pid" ]; then kill "$anvil_pid" 2>/dev/null || true; fi
  if [ "$status" -ne 0 ]; then printf '\nMainnet rehearsal failed at: %s\n' "$current" >&2; fi
}
trap finish EXIT

# Another node on the port would take every transaction meant for this one.
if nc -z 127.0.0.1 "$port" 2>/dev/null; then
  echo "port $port is in use; set BURSAR_ANVIL_PORT to a free one" >&2
  exit 1
fi
anvil --fork-url "$upstream" --chain-id 4663 --port "$port" --auto-impersonate --silent &
anvil_pid=$!
for _ in $(seq 100); do
  cast chain-id --rpc-url "$rpc" >/dev/null 2>&1 && break
  sleep 0.2
done
kill -0 "$anvil_pid" 2>/dev/null || { echo "anvil did not start" >&2; exit 1; }
forked_at="$(cast block-number --rpc-url "$rpc")"
# anvil cannot answer a call against the forked block itself: Robinhood Chain's headers carry no
# blob fields, and anvil wants them for the block a call runs on. One block of its own first.
cast rpc evm_mine --rpc-url "$rpc" >/dev/null

# shellcheck source=../env/rhc-mainnet-v5.env
source script/env/rhc-mainnet-v5.env
dir=cache/bursar/fork
rm -rf "$dir/broadcast"
mkdir -p "$dir"
for record in rhc-mainnet-v4 rhc-mainnet-v5; do
  cp "deployments/$record.json" "$dir/$record.json"
done
previous="$dir/rhc-mainnet-v4.json"
next="$dir/rhc-mainnet-v5.json"
export BURSAR_ALLOW_EOA_GOVERNANCE=i-accept-eoa-governance
# The fork reports chain 4663, so without these its logs and --resume data would land where a real
# mainnet run keeps its own.
export FOUNDRY_OUT="$dir/out"
export FOUNDRY_CACHE_PATH="$dir/cache"
export FOUNDRY_BROADCAST="$dir/broadcast"
# Forge's test preprocessing leaves artifacts behind that every later command warns about.
export FOUNDRY_DYNAMIC_TEST_LINKING=false
# Every key signs through impersonation. Forge reads ETH_PASSWORD as a keystore's password file and
# refuses an --unlocked run while it is set, as it is in a shell the key tooling set up.
unset ETH_PASSWORD

send() {
  local script="$1" sender="$2"
  shift 2
  forge script "$script" --rpc-url "$rpc" --unlocked --sender "$sender" --broadcast "$@"
}

check() {
  forge script "$@" --rpc-url "$rpc"
}

tx() {
  local from="$1"
  shift
  cast send "$@" --from "$from" --unlocked --rpc-url "$rpc" >/dev/null
}

later() {
  cast rpc evm_increaseTime "$1" --rpc-url "$rpc" >/dev/null
  cast rpc evm_mine --rpc-url "$rpc" >/dev/null
}

# A key the fork impersonates still pays for gas. Each one's balance on the chain is printed, to be
# read against the gas figures at the end, and a key under a tenth of a milli-ether is topped up on
# the fork alone so the rehearsal gets through.
gas_for() {
  local account
  for account in "$@"; do
    printf '%s holds %s ETH\n' "$account" "$(cast balance "$account" --ether --rpc-url "$rpc")"
    if [ "$(cast balance "$account" --rpc-url "$rpc")" -lt 100000000000000 ]; then
      cast rpc anvil_setBalance "$account" 0xde0b6b3a7640000 --rpc-url "$rpc" >/dev/null
      echo "  topped up on the fork"
    fi
  done
}

observe() {
  local guard keeper
  guard="$(jq -r .rwa.PriceGuard "$BURSAR_RECORD")"
  # Only the keeper may observe. anvil impersonates it like any other account.
  keeper="$(jq -r .rwa.guardKeeper "$BURSAR_RECORD")"
  for symbol in SGOV SPY NVDA AAPL; do
    tx "$keeper" "$guard" "observe(address)" "$(jq -r ".rwa.assets.$symbol.address" "$BURSAR_RECORD")"
  done
}

step "0. Governance"
deployer="$(jq -r .deployer "$previous")"
if [ -n "${BURSAR_HANDOVER_LANDED:-}" ]; then
  # The 48-hour timelock's acceptances are approved and wait out its delay; the fork skips to
  # when they are due, lands them as GOVERNANCE-48H.md does, and the fourth record follows.
  export BURSAR_RECORD="$previous"
  hw_1="$(jq -r '.governance48.signers[0]' "$previous")"
  incoming="$(jq -r .governance48.AdminTimelock "$previous")"
  gas_for "$hw_1" "$deployer"
  due="$(cast call "$incoming" "getProposal(uint256)((address,bytes,uint64,uint64,bool,bool))" 0 --json --rpc-url "$rpc" | jq -r '.[0][3]')"
  now="$(cast block latest --field timestamp --rpc-url "$rpc")"
  if [ "$now" -le "$due" ]; then later "$((due - now + 1))"; fi
  send script/AcceptGovernance.s.sol "$hw_1" --sig "execute()"
  send script/HandoverGovernance.s.sol "$deployer" --sig "finish()"
  if [ "$(jq -r .contracts.AdminTimelock "$previous")" != "$(jq -r .contracts.AdminTimelock "$next")" ]; then
    echo "the finished fourth record and the fifth name different timelocks" >&2
    exit 1
  fi
  echo "the handover has landed on the fork: the fifth record runs as committed"
else
  # The one-hour timelock still governs the chain as it stands, so the fifth record takes its
  # governance from the fourth as it reads today, and the committed one is left as written.
  jq --slurpfile v4 "$previous" '
    .contracts.AdminTimelock = $v4[0].contracts.AdminTimelock
    | del(.contracts.escrowPauser)
    | .roles = $v4[0].roles
    | .dev = $v4[0].dev
    | .parameters.AdminTimelock = $v4[0].parameters.AdminTimelock
  ' "$next" >"$next.tmp" && mv "$next.tmp" "$next"
  echo "the handover has not landed: the fifth record runs under the one-hour timelock, as the chain stands"
fi
export BURSAR_RECORD="$next"
export BURSAR_PREVIOUS_RECORD="$previous"

# Every key comes from the records, as the runbook's commands name them.
signer_1="$(jq -r '.roles.timelockSigners[0]' "$BURSAR_RECORD")"
signer_2="$(jq -r '.roles.timelockSigners[1]' "$BURSAR_RECORD")"
payer="$(jq -r .exampleMandate.principal "$BURSAR_PREVIOUS_RECORD")"
keeper="$BURSAR_GUARD_KEEPER"
gas_for "$deployer" "$signer_1" "$signer_2" "$payer" "$keeper"

step "1. Deploy the lane"
send script/DeployRwa.s.sol "$deployer"
check script/VerifyRwa.s.sol
send script/DeployCollateral.s.sol "$deployer"
check script/VerifyCollateral.s.sol

step "2. Propose the wiring"
send script/ProposeWiring.s.sol "$signer_1" --sig "propose()"
send script/ProposeWiring.s.sol "$signer_2" --sig "approve()"
check script/ProposeWiring.s.sol --sig "status()"

step "3. Move what needs no governance"
send script/RetireRecords.s.sol "$deployer" --sig "settle()"
send script/MigrateExamples.s.sol "$payer" --sig "drain()"
# The previous pool's cash comes back to the lender and goes into the new pool, as the runbook has
# the lender do once the figure is on the console.
cash="$(cast call "$(jq -r .rwa.collateral.CreditPool "$BURSAR_PREVIOUS_RECORD")" "cash()(uint256)" --rpc-url "$rpc" | cut -d' ' -f1)"
send script/MigrateCredit.s.sol "$deployer"
if [ "$cash" != "0" ]; then send script/MigrateCredit.s.sol "$deployer" --sig "fund(uint256)" "$cash"; fi
send script/MigrateExamples.s.sol "$payer" --sig "create()"
# The keeper's first two observations of each collateral asset's pool on the new guard, five
# minutes apart, so the new lane can draw.
observe
later 301
observe

step "4. The wiring lands; the new record goes live"
# The delay is the one of the timelock that governs the carried contracts today.
governs="$(cast call "$(jq -r .token.Staking "$BURSAR_RECORD")" "admin()(address)" --rpc-url "$rpc")"
delay="$(cast call "$governs" "timelockPeriod()(uint64)" --rpc-url "$rpc" | cut -d' ' -f1)"
echo "the wiring waits $delay seconds on $governs"
later "$((delay + 1))"
send script/ProposeWiring.s.sol "$signer_1" --sig "execute()"
check script/VerifyWiring.s.sol
send script/RetireRecords.s.sol "$deployer" --sig "goLive()"
BURSAR_VERIFY_STRICT=1 check script/Verify.s.sol

step "5. The previous record retires"
send script/MigrateCredit.s.sol "$deployer" --sig "claimSeized()"
send script/RetireRecords.s.sol "$deployer"
BURSAR_VERIFY_STRICT=1 check script/Verify.s.sol

# What each key spent, from the receipts forge logged: the figure the runbook's balances rest on.
step "Gas each key used"
names=(deployer signer-1 signer-2 payer keeper)
keys=("$deployer" "$signer_1" "$signer_2" "$payer" "$keeper")
if [ -n "${BURSAR_HANDOVER_LANDED:-}" ]; then
  names+=(hardware-1); keys+=("$hw_1")
fi
for i in "${!names[@]}"; do
  used="$(find "$dir/broadcast" -name 'run-[0-9]*.json' -exec cat {} + | jq -s --arg from "${keys[$i]}" '
    def hex: ltrimstr("0x") | explode | reduce .[] as $c (0; . * 16 + (if $c > 96 then $c - 87 elif $c > 64 then $c - 55 else $c - 48 end));
    [.[].receipts[] | select((.from | ascii_downcase) == ($from | ascii_downcase)) | .gasUsed | hex] | add // 0')"
  printf '%-12s %s %s\n' "${names[$i]}" "${keys[$i]}" "$used"
done
# The keeper's observations go through cast and are not in forge's logs: eight calls to observe.

step "Done"
for record in "$BURSAR_PREVIOUS_RECORD" "$BURSAR_RECORD"; do
  printf '%-40s %s\n' "$record" "$(jq -r '.status + (if .supersededBy then " -> " + .supersededBy else "" end)' "$record")"
done
current="done"
printf '\nMainnet rehearsal passed: every step of MIGRATION-V5.md ran on a fork of block %s with the handover %s, the previous record is %s and the new record is %s.\n' \
  "$forked_at" "${BURSAR_HANDOVER_LANDED:+landed}${BURSAR_HANDOVER_LANDED:-not landed}" \
  "$(jq -r .status "$BURSAR_PREVIOUS_RECORD")" "$(jq -r .status "$BURSAR_RECORD")"
