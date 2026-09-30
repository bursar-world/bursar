/**
 * The within-mandate prover, for Node. snarkjs runs the circuit's wasm witness generator and a
 * Groth16 prover over the committed zkey; one proof takes about a second.
 *
 * Imported as `@bursar/sdk/prove` so browser bundles of the main entry never pull in snarkjs or
 * the 8 MB of proving artifacts.
 */

import { readFileSync } from 'node:fs';

import { spendInput } from '@bursar/circuits';
import { artifacts } from '@bursar/circuits/artifacts';
import { toCapabilityId } from '@bursar/core';
import * as snarkjs from 'snarkjs';
import type { Address, Hex } from 'viem';

import { capabilityIdsOf, circuitTerms, type CounterState, type TermsDocument } from './committed.js';

export { FRESH_STATE, recoverState } from './committed.js';
export type { CounterState } from './committed.js';

export type Groth16Proof = {
  a: readonly [bigint, bigint];
  b: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
  c: readonly [bigint, bigint];
};

/** A proof and the public facts it was made for, which the account call has to repeat exactly. */
export type ProvenSpend = {
  payee: Address;
  amount: bigint;
  capabilityId: Hex;
  provenAt: bigint;
  newCounter: bigint;
  nullifier: bigint;
  proof: Groth16Proof;
  publicSignals: string[];
  next: CounterState;
};

/**
 * Proves one spend. `capability` is a label from the terms, such as `service:gpu.render:1`, or its
 * 32-byte id; the escrow lock will carry exactly that id. `provenAt` is the time the proof speaks
 * for; the account accepts it only while `block.timestamp <= provenAt <= block.timestamp + 15
 * minutes`, so aim a little ahead of the latest block.
 */
export async function proveSpend(args: {
  terms: TermsDocument;
  state: CounterState;
  mandate: Address;
  payee: Address;
  amount: bigint;
  capability: string;
  provenAt: bigint;
}): Promise<ProvenSpend> {
  const capabilityId = toCapabilityId(args.capability);
  const { input, next } = spendInput({
    terms: circuitTerms(args.terms),
    counterparties: args.terms.counterparties,
    capabilities: capabilityIdsOf(args.terms),
    state: args.state,
    mandate: args.mandate,
    payee: args.payee,
    amount: args.amount,
    capabilityId,
    now: args.provenAt,
  });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, artifacts.wasm, artifacts.zkey);
  const n = (v: string | undefined) => BigInt(v ?? 0);
  return {
    payee: args.payee,
    amount: args.amount,
    capabilityId,
    provenAt: args.provenAt,
    newCounter: n(publicSignals[3]),
    nullifier: n(publicSignals[4]),
    proof: {
      a: [n(proof.pi_a[0]), n(proof.pi_a[1])],
      // The verifier takes G2 coordinates in (imaginary, real) order.
      b: [
        [n(proof.pi_b[0]?.[1]), n(proof.pi_b[0]?.[0])],
        [n(proof.pi_b[1]?.[1]), n(proof.pi_b[1]?.[0])],
      ],
      c: [n(proof.pi_c[0]), n(proof.pi_c[1])],
    },
    publicSignals,
    next,
  };
}

let vkey: unknown;

export async function verifySpendProof(publicSignals: string[], proof: snarkjs.Groth16Proof): Promise<boolean> {
  vkey ??= JSON.parse(readFileSync(artifacts.verificationKey, 'utf8'));
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

/**
 * Arguments for `CommittedMandateAccount.spend`. The payee, the amount and the capability come from
 * the proof, so the call cannot drift from what was proven.
 */
export function spendArgs(proven: ProvenSpend, lock: { inputCommit: Hex; inputURI: string; deadline: bigint }) {
  return [
    {
      payee: proven.payee,
      capabilityId: proven.capabilityId,
      inputCommit: lock.inputCommit,
      inputURI: lock.inputURI,
      amount: proven.amount,
      deadline: lock.deadline,
      provenAt: proven.provenAt,
      newCounter: proven.newCounter,
      nullifier: proven.nullifier,
    },
    proven.proof,
  ] as const;
}
