#!/bin/sh
# Compiles the circuit into build/. Needs circom 2.1.9 on PATH.
set -eu
cd "$(dirname "$0")/.."
mkdir -p build
circom src/within_mandate.circom --r1cs --wasm --sym -l node_modules -o build
mv build/within_mandate_js/within_mandate.wasm build/within_mandate.wasm
rm -rf build/within_mandate_js build/within_mandate.sym
