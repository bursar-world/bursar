import { fileURLToPath } from 'node:url';

/** Paths to the proving artifacts. Node only; the hashing helpers in index.js run anywhere. */
export const artifacts = {
  wasm: fileURLToPath(new URL('./build/within_mandate.wasm', import.meta.url)),
  zkey: fileURLToPath(new URL('./build/within_mandate.zkey', import.meta.url)),
  verificationKey: fileURLToPath(new URL('./build/verification_key.json', import.meta.url)),
  r1cs: fileURLToPath(new URL('./build/within_mandate.r1cs', import.meta.url)),
};
