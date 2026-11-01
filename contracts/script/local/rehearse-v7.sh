#!/usr/bin/env bash
# Rehearses the move from the sixth record to the seventh, BRSR to $BURSAR, on a copy of Robinhood
# Chain. anvil forks mainnet as it stands and every step of script/MIGRATION-V7.md runs in order
# with the same scripts and arguments. Each of the deployment's own keys signs as itself through
# anvil's impersonation, so no keystore on this machine is opened; the operator's $BURSAR comes from
# impersonating its holder, and the payments at the end come from a fresh random key funded on the
# fork. The delays the runbook waits out are skipped with anvil's clock.
#
#   script/local/rehearse-v7.sh                                  # from contracts/
#
# After the move it pays through the new escrow twice, once released and once disputed and ruled
# on by the bonded resolvers, and checks that the buyback refuses to trade while the credit pool
# still reads its ceiling. Then it skips the seven days the old bonds take to unbond, reclaims them
# and asks whether the sixth record can retire.
#
# RHC_RPC_URL is the chain it forks, the public endpoint unless set; BURSAR_ANVIL_PORT the port,
# 8549 unless set. Everything it writes stays under cache/bursar/fork-rhc-mainnet-v7: copies of the
# two records, the build, forge's broadcast logs.
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
  if [ "$status" -ne 0 ]; then printf '\nRehearsal of the seventh record failed at: %s\n' "$current" >&2; fi
}
trap finish EXIT

if nc -z 127.0.0.1 "$port" 2>/dev/null; then
  echo "port $port is in use; set BURSAR_ANVIL_PORT to a free one" >&2
  exit 1
fi
anvil --fork-url "$upstream" --chain-id 4663 --port "$port" --auto-impersonate --block-time 1 --silent &
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

previous_name=rhc-mainnet-v6
next_name=rhc-mainnet-v7
# shellcheck source=/dev/null
source "script/env/$next_name.env"
dir="cache/bursar/fork-$next_name"
rm -rf "$dir/broadcast"
mkdir -p "$dir"
for record in "$previous_name" "$next_name"; do
  cp "deployments/$record.json" "$dir/$record.json"
done
export BURSAR_RECORD="$dir/$next_name.json"
export BURSAR_PREVIOUS_RECORD="$dir/$previous_name.json"
export BURSAR_ALLOW_EOA_GOVERNANCE=i-accept-eoa-governance
export FOUNDRY_OUT="$dir/out"
export FOUNDRY_CACHE_PATH="$dir/cache"
export FOUNDRY_BROADCAST="$dir/broadcast"
export FOUNDRY_DYNAMIC_TEST_LINKING=false
unset ETH_PASSWORD

send() {
  local script="$1" sender="$2"
  shift 2
  forge script "$script" --rpc-url "$rpc" --unlocked --sender "$sender" --broadcast --slow "$@"
}

check() {
  forge script "$@" --rpc-url "$rpc"
}

tx() {
  local from="$1"
  shift
  cast send "$@" --from "$from" --unlocked --rpc-url "$rpc" >/dev/null
}

call() {
  cast call "$@" --rpc-url "$rpc"
}

later() {
  cast rpc evm_increaseTime "$1" --rpc-url "$rpc" >/dev/null
  cast rpc evm_mine --rpc-url "$rpc" >/dev/null
}

expect() {
  local what="$1" want="$2" got="$3"
  if [ "$want" != "$got" ]; then
    echo "MISMATCH $what: expected $want, read $got" >&2
    exit 1
  fi
  echo "ok $what: $got"
}

gas_for() {
  local account
  for account in "$@"; do
    if [ "$(cast balance "$account" --rpc-url "$rpc")" -lt 100000000000000 ]; then
      cast rpc anvil_setBalance "$account" 0xde0b6b3a7640000 --rpc-url "$rpc" >/dev/null
      echo "$account topped up with gas on the fork"
    fi
  done
}

next() { jq -r "$1" "$BURSAR_RECORD"; }
previous() { jq -r "$1" "$BURSAR_PREVIOUS_RECORD"; }

deployer="$(next .deployer)"
timelock="$(next .contracts.AdminTimelock)"
read -r signer_1 signer_2 _ <<<"$(call "$timelock" "getSigners()(address[3])" | tr -d '[],')"
treasury="$(next .roles.treasury)"
payer="$(previous .exampleMandate.principal)"
# shellcheck disable=SC2207
resolvers=($(next '.roles.resolvers[]'))
usdg="$(next .settlementAsset)"
bursar="$(next .token.BURSAR)"
# The operator's wallet: $BURSAR's deployer on Pons, and the holder the resolver bonds come from.
operator="$(call "$bursar" "deployer()(address)")"
gas_for "$deployer" "$signer_1" "$signer_2" "$treasury" "$payer" "$operator" "${resolvers[@]}"

step "1. Take back the sixth credit pool's cash"
# The lender's own USDG, before anything is deployed: the core run wants the deploy key to hold a
# dollar of the settlement asset, and this is where that dollar comes from.
cash="$(call "$(previous .rwa.collateral.CreditPool)" "cash()(uint256)" | cut -d' ' -f1)"
echo "the sixth credit pool holds $cash micro-USD of cash"
send script/MigrateCredit.s.sol "$deployer"

step "2. Deploy the seventh set"
send script/Deploy.s.sol "$deployer"
send script/DeployRwa.s.sol "$deployer"
send script/DeployStaking.s.sol "$deployer"
send script/DeployCollateral.s.sol "$deployer"
send script/DeployPrivacy.s.sol "$deployer"
check script/VerifyCore.s.sol
check script/VerifyRwa.s.sol
check script/VerifyStaking.s.sol
check script/VerifyCollateral.s.sol
check script/VerifyPrivacy.s.sol
check script/VerifyToken.s.sol

step "3. Propose the wiring"
send script/ProposeWiring.s.sol "$signer_1" --sig "propose()"
send script/ProposeWiring.s.sol "$signer_2" --sig "approve()"
check script/ProposeWiring.s.sol --sig "status()"
# The stocks governance listed after launch have tiers on the sixth vault and none on the new one.
send script/ListStocks.s.sol "$signer_1" --sig "propose()"
send script/ListStocks.s.sol "$signer_2" --sig "approve()"

step "4. Move what needs no governance"
send script/RetireRecords.s.sol "$deployer" --sig "settle()"
send script/MigrateExamples.s.sol "$payer" --sig "drain()"
if [ "$cash" != "0" ]; then send script/MigrateCredit.s.sol "$deployer" --sig "fund(uint256)" "$cash"; fi
send script/MigrateExamples.s.sol "$payer" --sig "create()"

step "5. The wiring lands"
delay="$(call "$timelock" "timelockPeriod()(uint64)" | cut -d' ' -f1)"
later "$((delay + 1))"
send script/ProposeWiring.s.sol "$signer_1" --sig "execute()"
send script/ListStocks.s.sol "$signer_1" --sig "execute()"
check script/VerifyWiring.s.sol

step "6. The resolvers bond in \$BURSAR"
floor="$(next .parameters.Staking.resolverBondFloor)"
need="$(python3 -c "print($floor * ${#resolvers[@]})")"
echo "the operator sends the treasury $need BURSAR wei for ${#resolvers[@]} bonds"
tx "$operator" "$bursar" "transfer(address,uint256)" "$treasury" "$need"
send script/MigrateResolvers.s.sol "$treasury" --sig "fund()"
for resolver in "${resolvers[@]}"; do
  send script/MigrateResolvers.s.sol "$resolver" --sig "bond()"
done
registry="$(next .contracts.OracleRegistry)"
expect "OracleRegistry.resolverCount" 3 "$(call "$registry" "resolverCount()(uint256)" | cut -d' ' -f1)"
expect "OracleRegistry.bondAsset" "$(cast to-check-sum-address "$bursar")" "$(call "$registry" "bondAsset()(address)")"

step "7. The seventh record goes live"
send script/RetireRecords.s.sol "$deployer" --sig "goLive()"
check script/Verify.s.sol | tee "$dir/verify.log"
grep -E '^ *(MISMATCH|owed) ' "$dir/verify.log" || true
expect "seventh record status" live "$(next .status)"
expect "sixth record status" superseded "$(previous .status)"

step "8. A payment released through the new escrow"
escrow="$(next .contracts.Escrow)"
payee="$BURSAR_EXAMPLE_PAYEE"
wallet="$(cast wallet new --json | jq '.data // . | if type == "array" then .[0] else . end')"
key="$(jq -r .private_key <<<"$wallet")"
buyer="$(jq -r .address <<<"$wallet")"
cast rpc anvil_setBalance "$buyer" 0xde0b6b3a7640000 --rpc-url "$rpc" >/dev/null
# The deploy key's USDG went into the new credit pool. On the fork the payer is funded from the
# Uniswap pool manager, which holds the chain's USDG liquidity.
manager="$(next .external.PoolManager)"
cast rpc anvil_setBalance "$manager" 0xde0b6b3a7640000 --rpc-url "$rpc" >/dev/null
tx "$manager" "$usdg" "transfer(address,uint256)" "$buyer" 3000000
gas_for "$payee"
pay() { cast send "$@" --private-key "$key" --rpc-url "$rpc" >/dev/null; }
deadline=$(($(cast block latest --field timestamp --rpc-url "$rpc") + 86400))
pay "$usdg" "approve(address,uint256)" "$escrow" 3000000
first="$(call "$escrow" "nextId()(uint256)" | cut -d' ' -f1)"
pay "$escrow" "lock(address,bytes32,bytes32,string,uint128,uint64)" "$payee" "$(cast keccak capability)" "$(cast keccak input-1)" "ipfs://input-1" 1000000 "$deadline"
before="$(call "$usdg" "balanceOf(address)(uint256)" "$payee" | cut -d' ' -f1)"
tx "$payee" "$escrow" "release(uint256,bytes32,string)" "$first" "$(cast keccak output-1)" "ipfs://output-1"
after="$(call "$usdg" "balanceOf(address)(uint256)" "$payee" | cut -d' ' -f1)"
expect "payee paid on release, micro-USD" 990000 "$((after - before))"

step "9. A payment disputed and ruled on"
second=$((first + 1))
pay "$escrow" "lock(address,bytes32,bytes32,string,uint128,uint64)" "$payee" "$(cast keccak capability)" "$(cast keccak input-2)" "ipfs://input-2" 1000000 "$deadline"
pay "$escrow" "dispute(uint256)" "$second"
dispute="$(call "$registry" "disputeIdOf(uint256)(uint256)" "$second" | cut -d' ' -f1)"
echo "lock $second is dispute $dispute on $registry"
salt="$(cast keccak salt)"
# All three seated resolvers vote, as the resolver service does: a seated key that stays silent
# through a ruling loses a tenth of its bond.
for resolver in "${resolvers[@]}"; do
  hash="$(call "$registry" "commitmentHash(uint256,address,uint8,bytes32)(bytes32)" "$dispute" "$resolver" 80 "$salt")"
  tx "$resolver" "$registry" "commitVote(uint256,bytes32)" "$dispute" "$hash"
done
later "$((BURSAR_COMMIT_WINDOW + 1))"
for resolver in "${resolvers[@]}"; do
  tx "$resolver" "$registry" "revealVote(uint256,uint8,bytes32)" "$dispute" 80 "$salt"
done
later "$((BURSAR_REVEAL_WINDOW + 1))"
payee_before="$(call "$usdg" "balanceOf(address)(uint256)" "$payee" | cut -d' ' -f1)"
buyer_before="$(call "$usdg" "balanceOf(address)(uint256)" "$buyer" | cut -d' ' -f1)"
tx "$deployer" "$registry" "finalize(uint256)" "$dispute"
# A median of 80 refunds nothing: the payee is judged to have delivered. The disputer's bond, five
# percent, is forfeited to the resolvers who voted with the median.
ruling="$(call "$registry" "getDispute(uint256)((uint256,uint64,uint64,uint64,uint8,uint8,uint8,uint16,uint8,uint8))" "$dispute")"
echo "dispute $dispute after finalize: $ruling"
lock="$(cast call "$escrow" "getLock(uint256)((address,address,address,bytes32,bytes32,bytes32,string,string,uint128,uint64,uint64,uint128,uint64,uint8,bool))" "$second" --rpc-url "$rpc")"
expect "lock $second status (6 = Resolved)" 6 "$(tr -d '()' <<<"$lock" | awk -F', ' '{print $14}')"
payee_after="$(call "$usdg" "balanceOf(address)(uint256)" "$payee" | cut -d' ' -f1)"
buyer_after="$(call "$usdg" "balanceOf(address)(uint256)" "$buyer" | cut -d' ' -f1)"
echo "payee received $((payee_after - payee_before)) micro-USD, buyer received $((buyer_after - buyer_before))"

step "10. The buyback cannot trade; the credit pool reads its ceiling"
buyback="$(next .token.Buyback)"
expect "Buyback.paused" true "$(call "$buyback" "paused()(bool)")"
expect "Buyback.keeper" 0x0000000000000000000000000000000000000000 "$(call "$buyback" "keeper()(address)")"
expect "Buyback USDG balance" 0 "$(call "$usdg" "balanceOf(address)(uint256)" "$buyback" | cut -d' ' -f1)"
if cast send "$buyback" "buyback()" --from "${resolvers[0]}" --unlocked --rpc-url "$rpc" >/dev/null 2>&1; then
  echo "MISMATCH: Buyback.buyback() went through" >&2
  exit 1
fi
echo "ok Buyback.buyback() reverts"
pool="$(next .rwa.collateral.CreditPool)"
expect "CreditPool.buyback" "$(cast to-check-sum-address "$buyback")" "$(call "$pool" "buyback()(address)")"
echo "Buyback.params: $(call "$buyback" "params()((uint128,uint128,uint128,uint128,uint64,uint64))")"
echo "Buyback.ceilingSetAt: $(call "$buyback" "ceilingSetAt()(uint64)")"

step "11. Seven days later: the old bonds come back, and the sixth record asks to retire"
later "$((7 * 86400 + 1))"
for resolver in "${resolvers[@]}"; do
  send script/MigrateResolvers.s.sol "$resolver" --sig "reclaim()"
done
send script/MigrateCredit.s.sol "$deployer" --sig "claimSeized()"
# Locks on the sixth escrow whose deadline passed in the meantime go back to their payers first.
send script/RetireRecords.s.sol "$deployer" --sig "settle()"
if send script/RetireRecords.s.sol "$deployer" 2>&1 | tee "$dir/retire.log"; then
  echo "the sixth record retired: $(previous .status)"
else
  echo "the sixth record stays superseded; what is still open is listed above"
fi

step "Done"
current="done"
printf '\nRehearsal of the seventh record passed on a fork of block %s: %s is %s, %s is %s.\n' \
  "$forked_at" "$next_name" "$(next .status)" "$previous_name" "$(previous .status)"
