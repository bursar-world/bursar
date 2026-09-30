#!/usr/bin/env bash
# Rehearses the whole deployment on a local chain, with the commands a mainnet run uses: the
# fixtures that stand in for Robinhood Chain's outside contracts, every deploy script in order
# with its verify companion, the BRSR/USDG market opened by the seeding script, the wiring batch
# through the timelock, the lender's first cash, a strict check of the whole set, and then one
# flow per lane against what was deployed.
#
#   script/local/rehearse.sh            # from contracts/
#
# It starts anvil on BURSAR_ANVIL_PORT (8546 unless set) with chain id 4663 and stops it on exit.
# Every transaction is signed by one of anvil's own unlocked accounts: no key from this machine
# is read. The build, the record, the transaction logs and the endpoints forge saves for --resume
# all go to a directory of this run's own under cache/bursar, removed on exit with the chain they
# describe, so nothing a real run or a later local run reads is touched.
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
export BURSAR_RECORD="$run/local-4663.json"
export FOUNDRY_OUT="$run/out"
export FOUNDRY_CACHE_PATH="$run/cache"
export FOUNDRY_BROADCAST="$run/broadcast"

step "Build"
forge build

anvil --chain-id 4663 --port "$port" --silent &
anvil_pid=$!
for _ in $(seq 50); do
  cast chain-id --rpc-url "$rpc" >/dev/null 2>&1 && break
  sleep 0.2
done
kill -0 "$anvil_pid" 2>/dev/null || { echo "anvil did not start" >&2; exit 1; }

# anvil's account 9 places the fixtures, so the deploy key starts from nonce zero.
fixtures=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720

send() {
  local script="$1" sender="$2"
  shift 2
  forge script "$script" --rpc-url "$rpc" --unlocked --sender "$sender" --broadcast "$@"
}

check() {
  forge script "$1" --rpc-url "$rpc"
}

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
cast send "$usdg" "mint(address,uint256)" "$BURSAR_BRSR_LIQUIDITY" 25000000 \
  --from "$BURSAR_BRSR_LIQUIDITY" --unlocked --rpc-url "$rpc" >/dev/null
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

# The proofs the lane tests use are bound to the shielded pool's address, which is the deploy
# key's address and nonce. The rehearsal starts the shielded run at the nonce the proofs were made
# for; a mainnet run does not need this.
step "Shielded settlement"
cast rpc anvil_setNonce "$BURSAR_DEPLOYER" 0x2710 --rpc-url "$rpc" >/dev/null
send script/DeployShielded.s.sol "$BURSAR_DEPLOYER" \
  --libraries "vendor/poseidon-solidity/PoseidonT3.sol:PoseidonT3:$(jq -r .external.PoseidonT3 "$BURSAR_RECORD")" \
  --libraries "vendor/poseidon-solidity/PoseidonT4.sol:PoseidonT4:$(jq -r .external.PoseidonT4 "$BURSAR_RECORD")"
check script/VerifyShielded.s.sol

step "The wiring batch"
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_1" --sig "propose()"
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_2" --sig "approve()"
cast rpc evm_increaseTime "$((BURSAR_TIMELOCK_PERIOD + 1))" --rpc-url "$rpc" >/dev/null
cast rpc evm_mine --rpc-url "$rpc" >/dev/null
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_1" --sig "execute()"
check script/VerifyWiring.s.sol

step "The lender's first cash"
send script/MigrateCredit.s.sol "$BURSAR_LENDER" --sig "fund(uint256)" 10000000

step "The strict check"
BURSAR_VERIFY_STRICT=1 check script/Verify.s.sol

step "Every lane"
BURSAR_LOCAL_RPC="$rpc" forge test --match-path test/script/LocalChain.t.sol -vv

current="done"
printf '\nRehearsal passed: every script ran, the strict check found 0 mismatched and 0 owed, and every lane ran.\n'
