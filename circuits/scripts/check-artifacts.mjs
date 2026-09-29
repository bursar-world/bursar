// The artifacts are committed, so a clean checkout builds without circom or the 75 MB phase-1
// file. This checks they are present and match the hashes recorded at setup.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const setup = JSON.parse(readFileSync('build/setup.json', 'utf8'));
const paths = {
  'within_mandate.r1cs': 'build/within_mandate.r1cs',
  'within_mandate.wasm': 'build/within_mandate.wasm',
  'within_mandate.zkey': 'build/within_mandate.zkey',
  'verification_key.json': 'build/verification_key.json',
  'WithinMandateVerifier.sol': '../contracts/src/zk/WithinMandateVerifier.sol',
};
let bad = 0;
for (const [name, path] of Object.entries(paths)) {
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== setup.sha256[name]) {
    console.error(`${name}: ${actual} does not match setup.json ${setup.sha256[name]}`);
    bad++;
  }
}

// The vendored Privacy Pools artifacts: official ceremony outputs, pinned in their manifest.
const manifest = JSON.parse(readFileSync('privacy-pools/manifest.json', 'utf8'));
for (const [name, expected] of Object.entries(manifest.sha256)) {
  const actual = createHash('sha256').update(readFileSync(`privacy-pools/build/${name}`)).digest('hex');
  if (actual !== expected) {
    console.error(`privacy-pools/${name}: ${actual} does not match manifest.json ${expected}`);
    bad++;
  }
}
if (bad) process.exit(1);
console.log(
  `circuits: ${Object.keys(paths).length} artifacts match build/setup.json, ` +
    `${Object.keys(manifest.sha256).length} match privacy-pools/manifest.json (${manifest.version})`,
);
