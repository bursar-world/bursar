import { fileURLToPath } from 'node:url';

/**
 * The Privacy Pools v1.3.0 proving artifacts from the official trusted setup (see
 * privacy-pools/manifest.json). Node only: browsers load the same files over HTTP.
 */
const at = (file) => fileURLToPath(new URL(`./privacy-pools/build/${file}`, import.meta.url));

export const shieldedArtifacts = {
  withdraw: { wasm: at('withdraw.wasm'), zkey: at('withdraw.zkey'), vkey: at('withdraw.vkey') },
  commitment: { wasm: at('commitment.wasm'), zkey: at('commitment.zkey'), vkey: at('commitment.vkey') },
};
