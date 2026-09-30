import { readFileSync } from 'node:fs';

import * as snarkjs from 'snarkjs';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  PUBLIC_SIGNALS,
  capabilityHalves,
  capabilityRootFromPath,
  capabilityTree,
  counterCommitment,
  counterpartyTree,
  initialCounter,
  spendInput,
  termsCommitment,
} from '../index.js';
import { artifacts } from '../artifacts.js';

const PAYEE = 0x5210d8df060a9d5ce4c1305045ed5c9548fca374n;
const OTHER = 0x1111111111111111111111111111111111111111n;
const STRANGER = 0x2222222222222222222222222222222222222222n;
const MANDATE = 0x420beb507f72173e7d78e0f956968f64fb508356n;
const DAY = 86_400n;
const NOW = 1_790_600_000n;

// keccak256 of the class-namespaced labels, as @bursar/core hashes them. All three are above the
// field modulus, which is why the circuit takes an id in two halves.
const RENDER = 0xa94efc9949cf6e40f98b32b5d30d27175e000116c67c6442d3c083f7aafbe7d0n; // service:gpu.render:1
const TRANSCRIBE = 0xfe300b971e66a8ffc640c8c45ffc27fc1f2f6028cd6cbee0c6548f1b73baa3f5n; // service:audio.transcribe:1
const HIRE = 0xb31224402c73b011aa5c56ddeeb745dbf3f0d774a540c6cdba20ecf20973cbe0n; // hire:research.summarize:1

const counterparties = [PAYEE, OTHER];
const capabilities = [RENDER, TRANSCRIBE];
const terms = {
  perCallCap: 100_000n,
  periodCap: 250_000n,
  periodLen: DAY,
  totalCap: 1_000_000n,
  capabilityRoot: capabilityTree(capabilities).root,
  counterpartyRoot: counterpartyTree(counterparties).root,
  expiry: NOW + 30n * DAY,
  salt: 0x0badc0ffee0ddf00dn,
};
const fresh = { period: 0n, spent: 0n, total: 0n, nonce: 0n };

let vkey: unknown;

async function prove(input: Record<string, unknown>) {
  return snarkjs.groth16.fullProve(input, artifacts.wasm, artifacts.zkey);
}

async function verify(publicSignals: string[], proof: unknown) {
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

function spend(state: typeof fresh, amount: bigint, extra: Partial<Parameters<typeof spendInput>[0]> = {}) {
  return spendInput({
    terms,
    counterparties,
    capabilities,
    state,
    mandate: MANDATE,
    payee: PAYEE,
    amount,
    capabilityId: RENDER,
    now: NOW,
    ...extra,
  });
}

beforeAll(() => {
  vkey = JSON.parse(readFileSync(artifacts.verificationKey, 'utf8'));
});

describe('within_mandate', () => {
  it('proves three spends inside the period cap and refuses the fourth', async () => {
    let state: typeof fresh = fresh;
    expect(counterCommitment(state, terms.salt)).toBe(initialCounter(terms.salt));

    for (let i = 0; i < 3; i++) {
      const { input, next } = spend(state, 80_000n);
      const { proof, publicSignals } = await prove(input);
      expect(await verify(publicSignals, proof)).toBe(true);
      expect(publicSignals).toHaveLength(PUBLIC_SIGNALS.length);
      expect(BigInt(publicSignals[1]!)).toBe(termsCommitment(terms));
      expect(BigInt(publicSignals[2]!)).toBe(counterCommitment(state, terms.salt));
      expect(BigInt(publicSignals[3]!)).toBe(counterCommitment(next, terms.salt));
      state = next;
    }
    expect(state.spent).toBe(240_000n);

    // The helper refuses first, so a caller learns why without running the prover.
    expect(() => spend(state, 80_000n)).toThrow('over the period cap');

    // A prover that skips the helper and forges the counters cannot build a witness.
    const { input } = spend({ ...state, spent: 0n }, 80_000n);
    input.oldSpent = state.spent;
    await expect(prove(input)).rejects.toThrow(/Assert Failed/);

    // Honest counters and an amount that breaks only the period cap.
    const honest = spend(state, 10_000n).input;
    honest.amount = 80_000n;
    await expect(prove(honest)).rejects.toThrow(/Assert Failed/);
  }, 120_000);

  it('opens a new period with a fresh period cap but keeps the lifetime total', async () => {
    const state = { period: NOW / DAY, spent: 240_000n, total: 240_000n, nonce: 3n };
    const { input, next } = spend(state, 100_000n, { now: NOW + DAY });
    expect(next.spent).toBe(100_000n);
    expect(next.total).toBe(340_000n);
    const { proof, publicSignals } = await prove(input);
    expect(await verify(publicSignals, proof)).toBe(true);
  });

  it('refuses a spend over the per-call cap in-proof', async () => {
    expect(() => spend(fresh, 100_001n)).toThrow('over the per-call cap');
    const { input } = spend(fresh, 100_000n);
    input.amount = 100_001n;
    await expect(prove(input)).rejects.toThrow(/Assert Failed/);
  });

  it('refuses the lifetime total, a stranger and an expired mandate', async () => {
    expect(() => spend({ period: 0n, spent: 0n, total: 950_000n, nonce: 9n }, 80_000n)).toThrow('over the total budget');
    expect(() => spend(fresh, 1n, { payee: STRANGER })).toThrow('not an allowed counterparty');
    expect(() => spend(fresh, 1n, { now: terms.expiry + 1n })).toThrow('mandate expired');

    const { input } = spend(fresh, 1n);
    await expect(prove({ ...input, payee: STRANGER })).rejects.toThrow(/Assert Failed/);
    await expect(prove({ ...input, now: terms.expiry + 1n })).rejects.toThrow(/Assert Failed/);
  });

  it('binds the capability: one outside the committed set cannot be proven', async () => {
    expect(() => spend(fresh, 1n, { capabilityId: HIRE })).toThrow('capability not allowed');

    // Swap the public capability for one outside the set, keeping the path of an allowed one.
    const { input } = spend(fresh, 1n);
    const outside = capabilityHalves(HIRE);
    await expect(prove({ ...input, capabilityHi: outside.hi, capabilityLo: outside.lo })).rejects.toThrow(/Assert Failed/);

    // Or prove membership in a root of the prover's own choosing: the terms commitment moves.
    const own = capabilityTree([HIRE]);
    const path = own.proof(HIRE)!;
    await expect(
      prove({
        ...input,
        capabilityHi: outside.hi,
        capabilityLo: outside.lo,
        capabilityRoot: own.root,
        capabilityPathElements: path.pathElements,
        capabilityPathIndices: path.pathIndices.map(BigInt),
      }),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('holds a services-only mandate to services, and proves the capability as two public halves', async () => {
    const servicesOnly = { ...terms, capabilityRoot: capabilityTree([RENDER]).root };
    const only = (capabilityId: bigint) =>
      spendInput({ terms: servicesOnly, counterparties, capabilities: [RENDER], state: fresh, mandate: MANDATE, payee: PAYEE, amount: 1n, capabilityId, now: NOW });
    expect(() => only(HIRE)).toThrow('capability not allowed');

    const { input } = only(RENDER);
    const { proof, publicSignals } = await prove(input);
    expect(await verify(publicSignals, proof)).toBe(true);
    const { hi, lo } = capabilityHalves(RENDER);
    expect(BigInt(publicSignals[PUBLIC_SIGNALS.indexOf('capabilityHi')]!)).toBe(hi);
    expect(BigInt(publicSignals[PUBLIC_SIGNALS.indexOf('capabilityLo')]!)).toBe(lo);
    expect((hi << 128n) | lo).toBe(RENDER);

    // The same proof does not verify for the hire capability.
    const hire = capabilityHalves(HIRE);
    const swapped = [...publicSignals];
    swapped[PUBLIC_SIGNALS.indexOf('capabilityHi')] = hire.hi.toString();
    swapped[PUBLIC_SIGNALS.indexOf('capabilityLo')] = hire.lo.toString();
    expect(await verify(swapped, proof)).toBe(false);
  });

  it('builds capability paths that walk back to the root, whatever order the list came in', () => {
    const tree = capabilityTree([TRANSCRIBE, RENDER, RENDER]);
    expect(tree.root).toBe(capabilityTree(capabilities).root);
    expect(tree.members).toHaveLength(2);
    expect(capabilityRootFromPath(RENDER, tree.proof(RENDER)!)).toBe(tree.root);
    expect(tree.proof(HIRE)).toBeNull();
    expect(() => capabilityTree([])).toThrow('at least one capability');
    expect(() => capabilityHalves(1n << 256n)).toThrow('32 bytes');
  });

  it('rejects a valid proof whose public inputs were altered', async () => {
    const { input } = spend(fresh, 50_000n);
    const { proof, publicSignals } = await prove(input);
    const tampered = [...publicSignals];
    tampered[5] = '10'; // amount
    expect(await verify(tampered, proof)).toBe(false);
    const otherPayee = [...publicSignals];
    otherPayee[6] = OTHER.toString();
    expect(await verify(otherPayee, proof)).toBe(false);
  });

  it('keeps the verification key and the Solidity verifier in step', () => {
    const sol = readFileSync(new URL('../../contracts/src/zk/WithinMandateVerifier.sol', import.meta.url), 'utf8');
    const key = vkey as { vk_alpha_1: string[]; IC: unknown[] };
    expect(sol).toContain(key.vk_alpha_1[0]!);
    expect(key.IC).toHaveLength(PUBLIC_SIGNALS.length + 1);
    expect(sol).toContain(`uint[${PUBLIC_SIGNALS.length}] calldata _pubSignals`);
  });
});
