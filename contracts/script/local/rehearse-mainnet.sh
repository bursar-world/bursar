#!/usr/bin/env bash
# Rehearses the move to the fourth contract set on a copy of Robinhood Chain. anvil forks mainnet as
# it stands, and every step in script/MIGRATION.md runs in the runbook's order with the same
# scripts and arguments. Each key signs as itself through anvil's impersonation, so no key from this
# machine is read, and the delays the runbook waits out are skipped with anvil's clock.
#
#   script/local/rehearse-mainnet.sh            # from contracts/
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

# shellcheck source=../env/rhc-mainnet-v4.env
source script/env/rhc-mainnet-v4.env
dir=cache/bursar/fork
rm -rf "$dir/broadcast"
mkdir -p "$dir"
for record in rhc-mainnet-v3 rhc-mainnet-v4; do
  cp "deployments/$record.json" "$dir/$record.json"
done
export BURSAR_RECORD="$dir/rhc-mainnet-v4.json"
export BURSAR_PREVIOUS_RECORD="$dir/rhc-mainnet-v3.json"
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

# Every key comes from the records, as the runbook's commands name them.
deployer="$(jq -r .deployer "$BURSAR_RECORD")"
signer_1="$(jq -r '.roles.timelockSigners[0]' "$BURSAR_RECORD")"
signer_2="$(jq -r '.roles.timelockSigners[1]' "$BURSAR_RECORD")"
treasury="$(jq -r .roles.treasury "$BURSAR_RECORD")"
read -r -a resolvers <<<"$(jq -r '.roles.resolvers | join(" ")' "$BURSAR_RECORD")"
payer="$(jq -r .exampleMandate.principal "$BURSAR_PREVIOUS_RECORD")"
payee="$BURSAR_EXAMPLE_PAYEE"
usdg="$(jq -r .settlementAsset "$BURSAR_RECORD")"
timelock="$(jq -r .contracts.AdminTimelock "$BURSAR_RECORD")"

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

observe() {
  local guard
  guard="$(jq -r .rwa.PriceGuard "$BURSAR_RECORD")"
  for symbol in SGOV SPY NVDA AAPL; do
    tx "$deployer" "$guard" "observe(address)" "$(jq -r ".rwa.assets.$symbol.address" "$BURSAR_RECORD")"
  done
}

# Executes the newest open proposal on a timelock that carries this target and calldata, as the
# first signer, once its delay has passed on the fork's clock.
land() {
  local on="$1" target="$2" data="$3" count id proposal after now
  count="$(cast call "$on" "proposalCount()(uint256)" --rpc-url "$rpc" | cut -d' ' -f1)"
  for ((id = count - 1; id >= 0; id--)); do
    proposal="$(cast call "$on" "getProposal(uint256)((address,bytes,uint64,uint64,bool,bool))" "$id" --json --rpc-url "$rpc")"
    if jq -e --arg target "$target" --arg data "$data" \
      '.[0] | (.[0] | ascii_downcase) == ($target | ascii_downcase) and .[1] == $data and ((.[4] or .[5]) | not)' \
      <<<"$proposal" >/dev/null; then
      after="$(jq -r '.[0][3]' <<<"$proposal")"
      now="$(cast block latest --field timestamp --rpc-url "$rpc")"
      if [ "$now" -le "$after" ]; then later "$((after - now + 1))"; fi
      tx "$signer_1" "$on" "execute(uint256)" "$id"
      echo "executed #$id on $on"
      return
    fi
  done
  echo "no open proposal on $on for $target $data" >&2
  return 1
}

# The third set's own move left its Vesting handover in flight: proposed on both timelocks and
# waiting out the first one's 48 hours. Its runbook lands it. On a fork taken before that it lands
# here the same way, so every check below reads the chain as it will stand; once it has landed on
# the chain itself, this step finds nothing to do.
step "0. What is still in flight on the chain"
vesting="$(jq -r .token.Vesting "$BURSAR_RECORD")"
admin="$(cast call "$vesting" "admin()(address)" --rpc-url "$rpc")"
if [ "$admin" = "$timelock" ]; then
  echo "nothing: the vesting contract answers to $timelock"
else
  land "$admin" "$vesting" "$(cast calldata "transferAdmin(address)" "$timelock")"
  land "$timelock" "$vesting" "$(cast calldata "acceptAdmin()")"
fi

step "1. Deploy the new set"
send script/Deploy.s.sol "$deployer"
check script/VerifyCore.s.sol
check script/VerifyToken.s.sol
send script/DeployStaking.s.sol "$deployer"
check script/VerifyStaking.s.sol
send script/DeployRwa.s.sol "$deployer"
check script/VerifyRwa.s.sol
send script/DeployCollateral.s.sol "$deployer"
check script/VerifyCollateral.s.sol
send script/DeployPrivacy.s.sol "$deployer"
check script/VerifyPrivacy.s.sol
send script/DeployShielded.s.sol "$deployer" \
  --libraries "vendor/poseidon-solidity/PoseidonT3.sol:PoseidonT3:$(jq -r .external.PoseidonT3 "$BURSAR_RECORD")" \
  --libraries "vendor/poseidon-solidity/PoseidonT4.sol:PoseidonT4:$(jq -r .external.PoseidonT4 "$BURSAR_RECORD")"
check script/VerifyShielded.s.sol

step "2. Propose the wiring"
send script/ProposeWiring.s.sol "$signer_1" --sig "propose()"
send script/ProposeWiring.s.sol "$signer_2" --sig "approve()"
check script/ProposeWiring.s.sol --sig "status()"

step "3. Move what needs no governance"
send script/RetireRecords.s.sol "$deployer" --sig "settle()"
send script/MigrateExamples.s.sol "$payer" --sig "drain()"
send script/MigrateCredit.s.sol "$deployer"
send script/MigrateCredit.s.sol "$deployer" --sig "fund(uint256)" 20000000
tx "$deployer" "$usdg" "transfer(address,uint256)" "$payee" 5000000
send script/MigratePayee.s.sol "$payee"
send script/MigrateResolvers.s.sol "$treasury" --sig "fund()"
for resolver in "${resolvers[@]}"; do
  send script/MigrateResolvers.s.sol "$resolver" --sig "bond()"
done
send script/MigrateExamples.s.sol "$payer" --sig "create()"
# The keeper's first two observations of each collateral asset's pool, five minutes apart, so the
# new lane can draw.
observe
later 301
observe

step "4. The wiring lands; the new record goes live"
later "$((BURSAR_TIMELOCK_PERIOD + 1))"
send script/ProposeWiring.s.sol "$signer_1" --sig "execute()"
check script/VerifyWiring.s.sol
send script/RetireRecords.s.sol "$deployer" --sig "goLive()"
BURSAR_VERIFY_STRICT=1 check script/Verify.s.sol

step "5. Old bonds and stake come back; the previous record retires"
later "$((7 * 24 * 3600 + 1))"
for resolver in "${resolvers[@]}"; do
  send script/MigrateResolvers.s.sol "$resolver" --sig "reclaim()"
done
send script/MigratePayee.s.sol "$payee" --sig "reclaim()"
tx "$payee" "$usdg" "transfer(address,uint256)" "$deployer" 5000000
send script/MigrateCredit.s.sol "$deployer" --sig "fund(uint256)" 5000000
send script/RetireRecords.s.sol "$deployer" --sig "settle()"
send script/MigrateExamples.s.sol "$payer" --sig "drain()"
send script/MigrateCredit.s.sol "$deployer" --sig "claimSeized()"
send script/RetireRecords.s.sol "$deployer"

# The buyback's ceiling is trusted for seven days after it is set, and the week above has used them
# up. The signers restate it with the figures the buyback holds, as the runbook has them do.
buyback="$(jq -r .token.Buyback "$BURSAR_RECORD")"
PARAMS="(uint128,uint128,uint128,uint128,uint64,uint64)"
params="$(cast call "$buyback" "params()($PARAMS)" --json --rpc-url "$rpc" | jq -r '.[0] | map(tostring) | "(" + join(",") + ")"')"
tx "$signer_1" "$timelock" "propose(address,bytes)" "$buyback" "$(cast calldata "setParams($PARAMS)" "$params")"
id="$(($(cast call "$timelock" "proposalCount()(uint256)" --rpc-url "$rpc" | cut -d' ' -f1) - 1))"
tx "$signer_2" "$timelock" "approve(uint256)" "$id"
later "$((BURSAR_TIMELOCK_PERIOD + 1))"
tx "$signer_1" "$timelock" "execute(uint256)" "$id"
BURSAR_VERIFY_STRICT=1 check script/Verify.s.sol

# What each key spent, from the receipts forge logged: the figure the runbook's balances rest on.
step "Gas each key used"
names=(deployer signer-1 signer-2 treasury resolver-1 resolver-2 resolver-3 payer payee)
keys=("$deployer" "$signer_1" "$signer_2" "$treasury" "${resolvers[@]}" "$payer" "$payee")
for i in "${!names[@]}"; do
  used="$(find "$dir/broadcast" -name 'run-[0-9]*.json' -exec cat {} + | jq -s --arg from "${keys[$i]}" '
    def hex: ltrimstr("0x") | explode | reduce .[] as $c (0; . * 16 + (if $c > 96 then $c - 87 elif $c > 64 then $c - 55 else $c - 48 end));
    [.[].receipts[] | select((.from | ascii_downcase) == ($from | ascii_downcase)) | .gasUsed | hex] | add // 0')"
  printf '%-12s %s %s\n' "${names[$i]}" "${keys[$i]}" "$used"
done

step "Done"
for record in "$BURSAR_PREVIOUS_RECORD" "$BURSAR_RECORD"; do
  printf '%-40s %s\n' "$record" "$(jq -r '.status + (if .supersededBy then " -> " + .supersededBy else "" end)' "$record")"
done
current="done"
printf '\nMainnet rehearsal passed: every step of MIGRATION.md ran on a fork of block %s, the previous record is %s and the new record is %s.\n' \
  "$forked_at" "$(jq -r .status "$BURSAR_PREVIOUS_RECORD")" "$(jq -r .status "$BURSAR_RECORD")"
