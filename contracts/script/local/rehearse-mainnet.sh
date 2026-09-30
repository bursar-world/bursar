#!/usr/bin/env bash
# Rehearses the mainnet redeploy and the migration on a copy of Robinhood Chain. anvil forks
# mainnet as it stands, and every step in script/MIGRATION.md runs in the runbook's order with the
# runbook's commands. Each key signs as itself through anvil's impersonation, so no key from this
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

# shellcheck source=../env/rhc-mainnet-v3.env
source script/env/rhc-mainnet-v3.env
dir=cache/bursar/fork
mkdir -p "$dir"
for record in rhc-mainnet rhc-mainnet-token rhc-mainnet-v2 rhc-mainnet-v3; do
  cp "deployments/$record.json" "$dir/$record.json"
done
export BURSAR_RECORD="$dir/rhc-mainnet-v3.json"
export BURSAR_V1_RECORD="$dir/rhc-mainnet.json"
export BURSAR_V2_RECORD="$dir/rhc-mainnet-v2.json"
export BURSAR_TOKEN_RECORD="$dir/rhc-mainnet-token.json"
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
liquidity="$(jq -r .roles.liquidity "$BURSAR_RECORD")"
read -r -a resolvers <<<"$(jq -r '.roles.resolvers | join(" ")' "$BURSAR_RECORD")"
payer="$(jq -r .exampleMandate.principal "$BURSAR_V2_RECORD")"
payee="$BURSAR_EXAMPLE_PAYEE"
usdg="$(jq -r .settlementAsset "$BURSAR_RECORD")"
first_timelock="$(jq -r .contracts.AdminTimelock "$BURSAR_V1_RECORD")"

send() {
  local script="$1" sender="$2"
  shift 2
  forge script "$script" --rpc-url "$rpc" --unlocked --sender "$sender" --broadcast "$@"
}

check() {
  forge script "$1" --rpc-url "$rpc"
}

later() {
  cast rpc evm_increaseTime "$1" --rpc-url "$rpc" >/dev/null
  cast rpc evm_mine --rpc-url "$rpc" >/dev/null
}

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

step "2. Propose the wiring and the handover"
send script/ProposeWiring.s.sol "$signer_1" --sig "propose()"
send script/ProposeWiring.s.sol "$signer_2" --sig "approve()"
send script/MigrateGovernance.s.sol "$signer_1" --sig "propose()"
send script/MigrateGovernance.s.sol "$signer_2" --sig "approve()"

step "3. Moves that need no governance"
send script/RetireRecords.s.sol "$deployer" --sig "settle()"
send script/MigrateExamples.s.sol "$payer" --sig "drain()"
send script/MigrateCredit.s.sol "$deployer"
send script/MigrateCredit.s.sol "$deployer" --sig "fund(uint256)" 25000000
cast send "$usdg" "transfer(address,uint256)" "$payee" 5000000 --from "$deployer" --unlocked --rpc-url "$rpc" >/dev/null
send script/MigratePayee.s.sol "$payee"
BURSAR_ALLOW_MAINNET_SEED=i-am-moving-the-market send script/MigrateLiquidity.s.sol "$liquidity"
send script/MigrateStake.s.sol "$payer" --sig "leave()"
send script/MigrateGovernance.s.sol "$deployer" --sig "retireShielded()"

step "4. The wiring lands; resolvers bond"
later "$((BURSAR_TIMELOCK_PERIOD + 1))"
send script/ProposeWiring.s.sol "$signer_1" --sig "execute()"
check script/VerifyWiring.s.sol
send script/MigrateResolvers.s.sol "$treasury" --sig "fund()"
for resolver in "${resolvers[@]}"; do
  send script/MigrateResolvers.s.sol "$resolver" --sig "bond()"
done
send script/MigrateExamples.s.sol "$payer" --sig "create()"

step "5. The handover lands"
later "$(cast call "$first_timelock" "timelockPeriod()(uint64)" --rpc-url "$rpc" | cut -d' ' -f1)"
send script/MigrateGovernance.s.sol "$signer_1" --sig "execute()"
BURSAR_VERIFY_STRICT=1 check script/Verify.s.sol

step "6. Old bonds and stakes come back; the old records retire"
later "$((7 * 24 * 3600 + 1))"
send script/MigrateStake.s.sol "$payer" --sig "complete()"
for resolver in "${resolvers[@]}"; do
  send script/MigrateResolvers.s.sol "$resolver" --sig "reclaim()"
done
send script/MigratePayee.s.sol "$payee" --sig "reclaim()"
send script/RetireRecords.s.sol "$deployer" --sig "settle()"
send script/MigrateExamples.s.sol "$payer" --sig "drain()"
send script/RetireRecords.s.sol "$deployer"

step "Done"
for record in "$BURSAR_V1_RECORD" "$BURSAR_TOKEN_RECORD" "$BURSAR_V2_RECORD" "$BURSAR_RECORD"; do
  printf '%-40s %s\n' "$record" "$(jq -r '.status + (if .supersededBy then " -> " + .supersededBy else "" end)' "$record")"
done
current="done"
printf '\nMainnet rehearsal passed: every step of MIGRATION.md ran on a fork of block %s, and the new record is %s.\n' \
  "$forked_at" "$(jq -r .status "$BURSAR_RECORD")"
