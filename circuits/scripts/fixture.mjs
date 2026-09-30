// Writes contracts/test/fixtures/within_mandate.json: a committed mandate and two proven spends
// against it, for the Foundry tests. The tests place the account at the fixture's address with
// deployCodeTo, so the address is fixed here and not derived from any bytecode.
//
//   node scripts/fixture.mjs [mandate address]
import { writeFileSync } from 'node:fs';

import * as snarkjs from 'snarkjs';

import { artifacts } from '../artifacts.js';
import { capabilityTree, counterpartyTree, initialCounter, spendInput, termsCommitment } from '../index.js';

const mandate = BigInt(process.argv[2] ?? '0x0000000000000000000000000000000000acc001');
const PAYEE = 0xbeef01n;
const NOW = 1_790_600_000n;
// keccak256 of the labels, as @bursar/core's capabilityId hashes them.
const RENDER = 0xa94efc9949cf6e40f98b32b5d30d27175e000116c67c6442d3c083f7aafbe7d0n; // service:gpu.render:1
const TRANSCRIBE = 0xfe300b971e66a8ffc640c8c45ffc27fc1f2f6028cd6cbee0c6548f1b73baa3f5n; // service:audio.transcribe:1
const counterparties = [PAYEE, 0xbeef02n];
const capabilities = [RENDER, TRANSCRIBE];
const terms = {
  perCallCap: 100_000n,
  periodCap: 250_000n,
  periodLen: 86_400n,
  totalCap: 1_000_000n,
  capabilityRoot: capabilityTree(capabilities).root,
  counterpartyRoot: counterpartyTree(counterparties).root,
  expiry: NOW + 30n * 86_400n,
  salt: 0x5a17n,
};

const hex = (v) => `0x${BigInt(v).toString(16).padStart(64, '0')}`;
let state = { period: 0n, spent: 0n, total: 0n, nonce: 0n };
const spends = [];
for (const amount of [80_000n, 90_000n]) {
  const { input, next } = spendInput({
    terms,
    counterparties,
    capabilities,
    state,
    mandate,
    payee: PAYEE,
    amount,
    capabilityId: RENDER,
    now: NOW + 60n,
  });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, artifacts.wasm, artifacts.zkey);
  spends.push({
    amount: Number(amount),
    capabilityId: hex(RENDER),
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
