#!/bin/sh
# Groth16 setup for within_mandate. Phase 1 is the public Perpetual Powers of Tau (PSE, 80
# contributions, 2^16). Phase 2 here is a single development contribution. The multi-party
# phase 2 (three contributors plus a Robinhood Chain block hash as beacon) replaces it before
# launch; see contracts/deployments/rhc-mainnet-v2.json, productionChecklist.
set -eu
cd "$(dirname "$0")/.."

PTAU_URL="https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_16.ptau"
PTAU_SHA256="ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9"
PTAU="${PTAU:-$HOME/.cache/bursar-ptau/ppot_0080_16.ptau}"
SNARKJS="node_modules/.bin/snarkjs"

if [ ! -f "$PTAU" ]; then
  mkdir -p "$(dirname "$PTAU")"
  curl -fsSL -o "$PTAU" "$PTAU_URL"
fi
echo "$PTAU_SHA256  $PTAU" | shasum -a 256 -c -

sh scripts/compile.sh

"$SNARKJS" groth16 setup build/within_mandate.r1cs "$PTAU" build/within_mandate_0000.zkey
ENTROPY="$(openssl rand -hex 32)"
"$SNARKJS" zkey contribute build/within_mandate_0000.zkey build/within_mandate.zkey \
  --name="bursar dev phase 2, contribution 1" -e="$ENTROPY" > build/contribution-1.log
unset ENTROPY
rm -f build/within_mandate_0000.zkey

"$SNARKJS" zkey verify build/within_mandate.r1cs "$PTAU" build/within_mandate.zkey > build/zkey-verify.log
"$SNARKJS" zkey export verificationkey build/within_mandate.zkey build/verification_key.json
"$SNARKJS" zkey export solidityverifier build/within_mandate.zkey ../contracts/src/zk/WithinMandateVerifier.sol
sed -i.bak 's/contract Groth16Verifier/contract WithinMandateVerifier/' ../contracts/src/zk/WithinMandateVerifier.sol
rm -f ../contracts/src/zk/WithinMandateVerifier.sol.bak

node scripts/record-setup.mjs "$PTAU_URL" "$PTAU_SHA256"
