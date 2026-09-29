// Writes contracts/test/fixtures/within_mandate.json: a committed mandate and two proven spends
// against it, for the Foundry tests. Usage: node scripts/fixture.mjs <mandate address>
import { writeFileSync } from 'node:fs';

import * as snarkjs from 'snarkjs';

import { artifacts } from '../artifacts.js';
import { counterpartyTree, initialCounter, spendInput, termsCommitment } from '../index.js';

const mandate = BigInt(process.argv[2]);
const PAYEE = 0xbeef01n;
const NOW = 1_790_600_000n;
const tree = counterpartyTree([PAYEE, 0xbeef02n]);
const terms = {
  perCallCap: 100_000n,
  periodCap: 250_000n,
  periodLen: 86_400n,
  totalCap: 1_000_000n,
  classMask: 3n,
  counterpartyRoot: tree.root,
  expiry: NOW + 30n * 86_400n,
  salt: 0x5a17n,
};

const hex = (v) => `0x${BigInt(v).toString(16).padStart(64, '0')}`;
let state = { period: 0n, spent: 0n, total: 0n, nonce: 0n };
const spends = [];
for (const amount of [80_000n, 90_000n]) {
  const { input, next } = spendInput({
    terms,
    counterparties: [PAYEE, 0xbeef02n],
    state,
    mandate,
    payee: PAYEE,
    amount,
    classId: 0,
    now: NOW + 60n,
  });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, artifacts.wasm, artifacts.zkey);
  spends.push({
    amount: Number(amount),
    provenAt: Number(NOW + 60n),
    newCounter: hex(publicSignals[3]),
    nullifier: hex(publicSignals[4]),
    a: proof.pi_a.slice(0, 2).map(hex),
    b: [
      [hex(proof.pi_b[0][1]), hex(proof.pi_b[0][0])],
      [hex(proof.pi_b[1][1]), hex(proof.pi_b[1][0])],
    ],
    c: proof.pi_c.slice(0, 2).map(hex),
  });
  state = next;
}

const fixture = {
  mandate: `0x${mandate.toString(16).padStart(40, '0')}`,
  now: Number(NOW),
  termsCommitment: hex(termsCommitment(terms)),
  counter: hex(initialCounter(terms.salt)),
  spend1: spends[0],
  spend2: spends[1],
};
writeFileSync(new URL('../../contracts/test/fixtures/within_mandate.json', import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(fixture.mandate, fixture.termsCommitment);
process.exit(0);
