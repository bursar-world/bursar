#!/usr/bin/env bash
# Rehearses the move to 48-hour governance on a copy of Robinhood Chain. anvil forks mainnet as it
# stands, and every step in script/GOVERNANCE-48H.md runs in the runbook's order with the same
# scripts and arguments. The old timelock's signers and the deploy key sign as themselves through
# anvil's impersonation, and three placeholder addresses stand in for the hardware keys the new
# timelock will have; on the chain itself those sign the `cast send` lines the runbook gives. The
# delays the runbook waits out are skipped with anvil's clock.
#
#   script/local/rehearse-governance.sh            # from contracts/
#
# RHC_RPC_URL is the chain it forks, the public endpoint unless set, and BURSAR_ANVIL_PORT the
# port, 8550 unless set. The record it writes is a copy under cache/bursar/governance, and it
# builds, logs its transactions and keeps forge's --resume data there too: nothing in deployments/,
# out/, broadcast/ or cache/ outside cache/bursar changes, so a real run's logs are never overwritten.
set -euo pipefail
cd "$(dirname "$0")/../.."

upstream="${RHC_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
port="${BURSAR_ANVIL_PORT:-8550}"
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
  if [ "$status" -ne 0 ]; then printf '\nGovernance rehearsal failed at: %s\n' "$current" >&2; fi
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

# shellcheck source=../env/rhc-mainnet-v4.env
source script/env/rhc-mainnet-v4.env
dir=cache/bursar/governance
rm -rf "$dir/broadcast"
mkdir -p "$dir"
cp deployments/rhc-mainnet-v4.json "$dir/rhc-mainnet-v4.json"
export BURSAR_RECORD="$dir/rhc-mainnet-v4.json"
export BURSAR_PREVIOUS_RECORD=deployments/rhc-mainnet-v3.json
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

# The keys the record names, and three stand-ins for the hardware keys.
deployer="$(jq -r .deployer "$BURSAR_RECORD")"
signer_1="$(jq -r '.roles.timelockSigners[0]' "$BURSAR_RECORD")"
signer_2="$(jq -r '.roles.timelockSigners[1]' "$BURSAR_RECORD")"
hw_1=0x0000000000000000000000000000000000004801
hw_2=0x0000000000000000000000000000000000004802
hw_3=0x0000000000000000000000000000000000004803
export BURSAR_SIGNERS_48H="$hw_1,$hw_2,$hw_3"
for account in "$hw_1" "$hw_2" "$hw_3"; do
  cast rpc anvil_setBalance "$account" 0x38d7ea4c68000 --rpc-url "$rpc" >/dev/null
done

send() {
  local script="$1" sender="$2"
  shift 2
  forge script "$script" --rpc-url "$rpc" --unlocked --sender "$sender" --broadcast "$@"
}

check() {
  forge script "$@" --rpc-url "$rpc"
}

later() {
  cast rpc evm_increaseTime "$1" --rpc-url "$rpc" >/dev/null
  cast rpc evm_mine --rpc-url "$rpc" >/dev/null
}

step "0. The set as it stands"
BURSAR_VERIFY_STRICT=1 check script/Verify.s.sol

step "1. Deploy the 48-hour timelock"
send script/HandoverGovernance.s.sol "$deployer" --sig "deploy()"
check script/VerifyCore.s.sol

step "2. The old timelock offers everything"
send script/HandoverGovernance.s.sol "$signer_1" --sig "propose()"
send script/HandoverGovernance.s.sol "$signer_2" --sig "approve()"
check script/HandoverGovernance.s.sol --sig "status()"

step "3. The offer lands"
later "$((BURSAR_TIMELOCK_PERIOD + 1))"
send script/HandoverGovernance.s.sol "$signer_1" --sig "execute()"
check script/HandoverGovernance.s.sol --sig "status()"

step "4. The new timelock accepts, from its own signers"
check script/HandoverGovernance.s.sol --sig "handover()"
send script/AcceptGovernance.s.sol "$hw_1" --sig "propose()"
send script/AcceptGovernance.s.sol "$hw_2" --sig "approve()"
check script/AcceptGovernance.s.sol --sig "status()"

step "5. The acceptance lands"
later "$((48 * 3600 + 1))"
send script/AcceptGovernance.s.sol "$hw_1" --sig "execute()"
check script/AcceptGovernance.s.sol --sig "status()"

step "6. The record follows the chain"
send script/HandoverGovernance.s.sol "$deployer" --sig "finish()"
BURSAR_VERIFY_STRICT=1 check script/Verify.s.sol

# What each key spent, from the receipts forge logged: the figure the runbook's balances rest on.
step "Gas each key used"
names=(deployer signer-1 signer-2 hardware-1 hardware-2)
keys=("$deployer" "$signer_1" "$signer_2" "$hw_1" "$hw_2")
for i in "${!names[@]}"; do
  used="$(find "$dir/broadcast" -name 'run-[0-9]*.json' -exec cat {} + | jq -s --arg from "${keys[$i]}" '
    def hex: ltrimstr("0x") | explode | reduce .[] as $c (0; . * 16 + (if $c > 96 then $c - 87 elif $c > 64 then $c - 55 else $c - 48 end));
    [.[].receipts[] | select((.from | ascii_downcase) == ($from | ascii_downcase)) | .gasUsed | hex] | add // 0')"
  printf '%-12s %s %s\n' "${names[$i]}" "${keys[$i]}" "$used"
done

step "Done"
printf 'AdminTimelock %s, delay %s s, escrow pauser %s, dev %s\n' \
  "$(jq -r .contracts.AdminTimelock "$BURSAR_RECORD")" \
  "$(jq -r .parameters.AdminTimelock.timelockPeriod "$BURSAR_RECORD")" \
  "$(jq -r .contracts.escrowPauser "$BURSAR_RECORD")" \
  "$(jq -r .dev "$BURSAR_RECORD")"
current="done"
printf '\nGovernance rehearsal passed: every step of GOVERNANCE-48H.md ran on a fork of block %s, and the record names the 48-hour timelock.\n' "$forked_at"
