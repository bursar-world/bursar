// Writes build/setup.json: what phase 1 was, what phase 2 contributed, and the hashes a reader
// needs to check the artifacts in this directory against the deployed verifier.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [ptauUrl, ptauSha256] = process.argv.slice(2);
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const contribution = readFileSync('build/contribution-1.log', 'utf8');
const verify = readFileSync('build/zkey-verify.log', 'utf8');
const hashBlock = (text) =>
  (text.match(/Contribution Hash:\s*\n((?:\s+[0-9a-f ]+\n){4})/) ?? [, ''])[1]
    .split('\n')
    .map((line) => line.replace(/\s+/g, ''))
    .join('');

const record = {
  circuit: 'within_mandate',
  circom: '2.1.9',
  snarkjs: '0.7.6',
  phase1: {
    source: 'Perpetual Powers of Tau (PSE), 80 contributions, 2^16',
    url: ptauUrl,
    sha256: ptauSha256,
  },
  phase2: {
    mode: 'development: one contribution, no beacon',
    contributions: [{ name: 'bursar dev phase 2, contribution 1', hash: hashBlock(contribution) }],
    pending: 'Three independent contributors and a Robinhood Chain block hash as beacon, before launch.',
  },
  zkeyVerify: /ZKey Ok!/.test(verify) ? 'ZKey Ok!' : 'FAILED',
  sha256: {
    'within_mandate.r1cs': sha('build/within_mandate.r1cs'),
    'within_mandate.wasm': sha('build/within_mandate.wasm'),
    'within_mandate.zkey': sha('build/within_mandate.zkey'),
    'verification_key.json': sha('build/verification_key.json'),
    'WithinMandateVerifier.sol': sha('../contracts/src/zk/WithinMandateVerifier.sol'),
  },
};
writeFileSync('build/setup.json', `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
if (record.zkeyVerify !== 'ZKey Ok!') process.exit(1);
