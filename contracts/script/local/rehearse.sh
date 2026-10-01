#!/usr/bin/env bash
# Rehearses the whole deployment on a local chain, and then the move to the next one, with the
# commands a mainnet run uses.
#
# First a complete set: the fixtures that stand in for Robinhood Chain's outside contracts, every
# deploy script in order with its verify companion, the BRSR/USDG market opened by the seeding
# script, the wiring batch through the timelock, the lender's first cash, a payee and the three
# resolvers seated, the three examples, and a strict check of the whole set.
#
# Then the next record is planned on top of it, the timelock and the token set carried over, and
# every step of script/MIGRATION.md runs against the two records in the runbook's order: the staking
# run joins what it finds, the wiring batch proposes only what differs, the money moves, the first
# record retires and the next one goes live. It ends on a strict check with nothing owed and one
# flow per lane against the new set.
#
#   script/local/rehearse.sh            # from contracts/
#
# It starts anvil on BURSAR_ANVIL_PORT (8546 unless set) with chain id 4663 and stops it on exit.
# Every transaction is signed by anvil, for one of its own accounts or for an address it
# impersonates: no key from this machine is read. The build, the records, the transaction logs and
# the endpoints forge saves for --resume all go to a directory of this run's own under cache/bursar,
# removed on exit with the chain they describe, so nothing a real run or a later local run reads is
# touched.
set -euo pipefail
cd "$(dirname "$0")/../.."

port="${BURSAR_ANVIL_PORT:-8546}"
rpc="http://127.0.0.1:${port}"
run="cache/bursar/rehearsal-$$"
anvil_pid=""
current="the port check"

step() {
  current="$1"
  printf '\n=== %s\n' "$1"
}

finish() {
  local status=$?
  if [ -n "$anvil_pid" ]; then kill "$anvil_pid" 2>/dev/null || true; fi
  rm -rf "$run"
  if [ "$status" -ne 0 ]; then printf '\nRehearsal failed at: %s\n' "$current" >&2; fi
}
trap finish EXIT

# Another node on the port would take every transaction meant for this one.
if nc -z 127.0.0.1 "$port" 2>/dev/null; then
  echo "port $port is in use; set BURSAR_ANVIL_PORT to a free one" >&2
  exit 1
fi

# shellcheck source=../env/local.env
source script/env/local.env
mkdir -p "$run"
first="$run/local-4663.json"
next="$run/local-4663-next.json"
export BURSAR_RECORD="$first"
export FOUNDRY_OUT="$run/out"
export FOUNDRY_CACHE_PATH="$run/cache"
export FOUNDRY_BROADCAST="$run/broadcast"

step "Build"
forge build

anvil --chain-id 4663 --port "$port" --auto-impersonate --silent &
anvil_pid=$!
for _ in $(seq 50); do
  cast chain-id --rpc-url "$rpc" >/dev/null 2>&1 && break
  sleep 0.2
done
kill -0 "$anvil_pid" 2>/dev/null || { echo "anvil did not start" >&2; exit 1; }

# anvil's account 9 places the fixtures, so the deploy key starts from nonce zero.
fixtures=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720
# The principal of the examples, and the payee they pay. Neither is one of anvil's own accounts,
# so anvil signs for them by impersonation, as it does for the resolvers.
payer=0x0000000000000000000000000000000000004001
payee="$BURSAR_EXAMPLE_PAYEE"
read -r -a resolvers <<<"${BURSAR_RESOLVERS//,/ }"

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

deploy_shielded() {
  send script/DeployShielded.s.sol "$BURSAR_DEPLOYER" \
    --libraries "vendor/poseidon-solidity/PoseidonT3.sol:PoseidonT3:$(jq -r .external.PoseidonT3 "$BURSAR_RECORD")" \
    --libraries "vendor/poseidon-solidity/PoseidonT4.sol:PoseidonT4:$(jq -r .external.PoseidonT4 "$BURSAR_RECORD")"
}

for account in "$payer" "$payee" "${resolvers[@]}"; do
  cast rpc anvil_setBalance "$account" 0xde0b6b3a7640000 --rpc-url "$rpc" >/dev/null
done

step "Fixtures and the local record"
send script/local/LocalFixtures.s.sol "$fixtures"
usdg="$(jq -r .settlementAsset "$BURSAR_RECORD")"

step "The core set"
send script/Deploy.s.sol "$BURSAR_DEPLOYER"
check script/VerifyCore.s.sol

step "BRSR and vesting"
send script/DeployToken.s.sol "$BURSAR_DEPLOYER"
check script/VerifyToken.s.sol

step "Staking and the buyback"
send script/DeployStaking.s.sol "$BURSAR_DEPLOYER"
check script/VerifyStaking.s.sol

# 25 USDG and the BRSR it buys at 200 micro-USD, from the liquidity key. The stand-in USDG mints to
# anyone. The seeder is offered to the timelock, and the wiring batch accepts it.
step "The market"
tx "$BURSAR_BRSR_LIQUIDITY" "$usdg" "mint(address,uint256)" "$BURSAR_BRSR_LIQUIDITY" 25000000
BURSAR_SEED_PRICE_MICRO_USD=200 BURSAR_SEED_USDG_MICRO=25000000 send script/SeedPool.s.sol "$BURSAR_BRSR_LIQUIDITY"
check script/VerifyStaking.s.sol

step "The RWA lane"
send script/DeployRwa.s.sol "$BURSAR_DEPLOYER"
check script/VerifyRwa.s.sol

step "The collateral lane"
send script/DeployCollateral.s.sol "$BURSAR_DEPLOYER"
check script/VerifyCollateral.s.sol

step "Committed mandates"
send script/DeployPrivacy.s.sol "$BURSAR_DEPLOYER"
check script/VerifyPrivacy.s.sol

step "Shielded settlement"
deploy_shielded
check script/VerifyShielded.s.sol

step "The wiring batch"
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_1" --sig "propose()"
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_2" --sig "approve()"
later "$((BURSAR_TIMELOCK_PERIOD + 1))"
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_1" --sig "execute()"
check script/VerifyWiring.s.sol

step "The lender's first cash"
send script/MigrateCredit.s.sol "$BURSAR_LENDER" --sig "fund(uint256)" 10000000

# The set in use, the way the live one is: a payee registered, each resolver bonded from the
# treasury, and the three examples, the collateral one with stock posted. The committed example is
# left out: its terms are sealed with the payer's own signature.
step "A payee, the resolvers and the examples"
tx "$payee" "$usdg" "mint(address,uint256)" "$payee" 5000000
BURSAR_PAYEE_NAME=example_payee send script/MigratePayee.s.sol "$payee"
send script/MigrateResolvers.s.sol "$BURSAR_TREASURY" --sig "fund()"
for resolver in "${resolvers[@]}"; do
  send script/MigrateResolvers.s.sol "$resolver" --sig "bond()"
done
tx "$payer" "$usdg" "mint(address,uint256)" "$payer" 1000000
tx "$payer" "$(jq -r .rwa.assets.SPY.address "$BURSAR_RECORD")" "mint(address,uint256)" "$payer" 1000000000000000000
send script/MigrateExamples.s.sol "$payer" --sig "create()"
send script/RetireRecords.s.sol "$BURSAR_DEPLOYER" --sig "goLive()"

step "The strict check of the first set"
BURSAR_VERIFY_STRICT=1 check script/Verify.s.sol

# The next record, planned the way deployments/rhc-mainnet-v4.json is: governance, the token set,
# the roles and the outside contracts carried over, nothing of its own yet.
step "The next record"
jq '{
  network: "local-4663-next",
  chainId,
  status: "planned",
  local,
  dev,
  rpc,
  explorer,
  settlementAsset,
  settlementDecimals,
  supersedes: .network,
  deployer,
  external,
  roles,
  contracts: {AdminTimelock: .contracts.AdminTimelock},
  token: (.token | {BRSR, Vesting, Staking, Buyback, V4LiquiditySeeder, keeper, poolId, fromBlock}),
  verifiedOnChain: {}
}' "$first" >"$next"
export BURSAR_RECORD="$next"
export BURSAR_PREVIOUS_RECORD="$first"
# The deploy key lent its USDG to the credit pool, and the core run asks it for one again.
tx "$BURSAR_DEPLOYER" "$usdg" "mint(address,uint256)" "$BURSAR_DEPLOYER" 1000000

step "1. Deploy the new set"
send script/Deploy.s.sol "$BURSAR_DEPLOYER"
check script/VerifyCore.s.sol
check script/VerifyToken.s.sol
send script/DeployStaking.s.sol "$BURSAR_DEPLOYER"
check script/VerifyStaking.s.sol
send script/DeployRwa.s.sol "$BURSAR_DEPLOYER"
check script/VerifyRwa.s.sol
send script/DeployCollateral.s.sol "$BURSAR_DEPLOYER"
check script/VerifyCollateral.s.sol
send script/DeployPrivacy.s.sol "$BURSAR_DEPLOYER"
check script/VerifyPrivacy.s.sol
# The proofs the lane tests use are bound to the shielded pool's address, which is the deploy key's
# address and nonce. The new set's shielded run starts at the nonce the proofs were made for; a
# mainnet run does not need this.
cast rpc anvil_setNonce "$BURSAR_DEPLOYER" 0x2710 --rpc-url "$rpc" >/dev/null
deploy_shielded
check script/VerifyShielded.s.sol

step "2. Propose the wiring"
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_1" --sig "propose()"
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_2" --sig "approve()"

step "3. Move what needs no governance"
send script/RetireRecords.s.sol "$BURSAR_DEPLOYER" --sig "settle()"
send script/MigrateExamples.s.sol "$payer" --sig "drain()"
# The lender's returned cash is lent again, less the payee's new stake, which it bridges until the
# payee's old stake comes back in step 5.
send script/MigrateCredit.s.sol "$BURSAR_LENDER"
send script/MigrateCredit.s.sol "$BURSAR_LENDER" --sig "fund(uint256)" 5000000
tx "$BURSAR_LENDER" "$usdg" "transfer(address,uint256)" "$payee" 5000000
send script/MigratePayee.s.sol "$payee"
send script/MigrateResolvers.s.sol "$BURSAR_TREASURY" --sig "fund()"
for resolver in "${resolvers[@]}"; do
  send script/MigrateResolvers.s.sol "$resolver" --sig "bond()"
done
send script/MigrateExamples.s.sol "$payer" --sig "create()"

step "4. The wiring lands; the new record goes live"
later "$((BURSAR_TIMELOCK_PERIOD + 1))"
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_1" --sig "execute()"
check script/VerifyWiring.s.sol
send script/RetireRecords.s.sol "$BURSAR_DEPLOYER" --sig "goLive()"
BURSAR_VERIFY_STRICT=1 check script/Verify.s.sol

step "5. Old bonds and stake come back; the first record retires"
later "$((7 * 24 * 3600 + 1))"
for resolver in "${resolvers[@]}"; do
  send script/MigrateResolvers.s.sol "$resolver" --sig "reclaim()"
done
send script/MigratePayee.s.sol "$payee" --sig "reclaim()"
tx "$payee" "$usdg" "transfer(address,uint256)" "$BURSAR_LENDER" 5000000
send script/MigrateCredit.s.sol "$BURSAR_LENDER" --sig "fund(uint256)" 5000000
send script/RetireRecords.s.sol "$BURSAR_DEPLOYER" --sig "settle()"
send script/MigrateExamples.s.sol "$payer" --sig "drain()"
send script/RetireRecords.s.sol "$BURSAR_DEPLOYER"

# The buyback's ceiling is trusted for seven days, and the week above has used them up. Governance
# restates it with the figures the buyback holds, the way the runbook has the signers do it.
step "The buyback's ceiling, restated"
timelock="$(jq -r .contracts.AdminTimelock "$BURSAR_RECORD")"
buyback="$(jq -r .token.Buyback "$BURSAR_RECORD")"
PARAMS="(uint128,uint128,uint128,uint128,uint64,uint64)"
params="$(cast call "$buyback" "params()($PARAMS)" --json --rpc-url "$rpc" | jq -r '.[0] | map(tostring) | "(" + join(",") + ")"')"
tx "$BURSAR_TIMELOCK_SIGNER_1" "$timelock" "propose(address,bytes)" "$buyback" "$(cast calldata "setParams($PARAMS)" "$params")"
id="$(($(cast call "$timelock" "proposalCount()(uint256)" --rpc-url "$rpc" | cut -d' ' -f1) - 1))"
tx "$BURSAR_TIMELOCK_SIGNER_2" "$timelock" "approve(uint256)" "$id"
later "$((BURSAR_TIMELOCK_PERIOD + 1))"
tx "$BURSAR_TIMELOCK_SIGNER_1" "$timelock" "execute(uint256)" "$id"

step "The strict check of the new set"
BURSAR_VERIFY_STRICT=1 check script/Verify.s.sol

step "Every lane"
BURSAR_LOCAL_RPC="$rpc" forge test --match-path test/script/LocalChain.t.sol -vv

step "Done"
for record in "$first" "$next"; do
  printf '%-24s %s\n' "$(jq -r .network "$record")" "$(jq -r '.status + (if .supersededBy then " -> " + .supersededBy else "" end)' "$record")"
done
current="done"
printf '\nRehearsal passed: the first set deployed and verified, the next one joined its timelock and token set, every migration step ran, the strict check found 0 mismatched and 0 owed, and every lane ran.\n'
