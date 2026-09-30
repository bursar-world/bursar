#!/usr/bin/env bash
# Rehearses the whole deployment on a local chain, with the commands a mainnet run uses: the
# fixtures that stand in for Robinhood Chain's outside contracts, every deploy script in order
# with its verify companion, the wiring batch through the timelock, and then one flow per lane
# against what was deployed.
#
#   script/local/rehearse.sh            # from contracts/
#
# It starts anvil on BURSAR_ANVIL_PORT (8546 unless set) with chain id 4663 and stops it on exit.
# Every transaction is signed by one of anvil's own unlocked accounts: no key from this machine
# is read.
set -euo pipefail
cd "$(dirname "$0")/../.."

port="${BURSAR_ANVIL_PORT:-8546}"
rpc="http://127.0.0.1:${port}"

# Another node on the port would take every transaction meant for this one.
if nc -z 127.0.0.1 "$port" 2>/dev/null; then
  echo "port $port is in use; set BURSAR_ANVIL_PORT to a free one" >&2
  exit 1
fi
anvil --chain-id 4663 --port "$port" --silent &
anvil_pid=$!
trap 'kill "$anvil_pid" 2>/dev/null || true' EXIT
for _ in $(seq 50); do
  cast chain-id --rpc-url "$rpc" >/dev/null 2>&1 && break
  sleep 0.2
done
kill -0 "$anvil_pid" 2>/dev/null || { echo "anvil did not start" >&2; exit 1; }

# shellcheck source=../env/local.env
source script/env/local.env
# anvil answers as chain 4663, so its transaction logs would land where a real mainnet run keeps
# its own.
export FOUNDRY_BROADCAST=cache/bursar/local-broadcast
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

send script/local/LocalFixtures.s.sol "$fixtures"

send script/Deploy.s.sol "$BURSAR_DEPLOYER"
check script/VerifyCore.s.sol
send script/DeployToken.s.sol "$BURSAR_DEPLOYER"
check script/VerifyToken.s.sol
send script/DeployStaking.s.sol "$BURSAR_DEPLOYER"
check script/VerifyStaking.s.sol
send script/DeployRwa.s.sol "$BURSAR_DEPLOYER"
check script/VerifyRwa.s.sol
send script/DeployCollateral.s.sol "$BURSAR_DEPLOYER"
check script/VerifyCollateral.s.sol
send script/DeployPrivacy.s.sol "$BURSAR_DEPLOYER"
check script/VerifyPrivacy.s.sol

# The proofs the lane tests use are bound to the shielded pool's address, which is the deploy
# key's address and nonce. The rehearsal starts the shielded run at the nonce the proofs were made
# for; a mainnet run does not need this.
cast rpc anvil_setNonce "$BURSAR_DEPLOYER" 0x2710 --rpc-url "$rpc" >/dev/null
send script/DeployShielded.s.sol "$BURSAR_DEPLOYER" \
  --libraries "vendor/poseidon-solidity/PoseidonT3.sol:PoseidonT3:$(jq -r .external.PoseidonT3 "$BURSAR_RECORD")" \
  --libraries "vendor/poseidon-solidity/PoseidonT4.sol:PoseidonT4:$(jq -r .external.PoseidonT4 "$BURSAR_RECORD")"
check script/VerifyShielded.s.sol

send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_1" --sig "propose()"
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_2" --sig "approve()"
cast rpc evm_increaseTime "$((BURSAR_TIMELOCK_PERIOD + 1))" --rpc-url "$rpc" >/dev/null
cast rpc evm_mine --rpc-url "$rpc" >/dev/null
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_1" --sig "execute()"
check script/VerifyWiring.s.sol
check script/Verify.s.sol

BURSAR_LOCAL_RPC="$rpc" forge test --match-path test/script/LocalChain.t.sol -vv
