/**
 * Proving for the shielded pool, with the official Privacy Pools v1.3.0 artifacts.
 *
 * Imported as `@bursar/sdk/shielded-prove`. It takes the artifacts explicitly so the same code runs
 * in Node (paths from `@bursar/circuits/privacy-pools`) and in a browser (URLs or bytes). A
 * withdrawal proof takes a few seconds; the proving key is 17 MB.
 */

import * as snarkjs from 'snarkjs';

import {
  ragequitInput,
  toSolidityProof,
  withdrawInput,
  type Note,
  type NoteSecrets,
  type SolidityProof,
} from './shielded.js';

export type CircuitArtifacts = { readonly wasm: string | Uint8Array; readonly zkey: string | Uint8Array };

export type ProvenWithdrawal = {
  readonly proof: SolidityProof<8>;
  /** The note that stays in the pool. Its value is the old value minus the withdrawal. */
  readonly change: Note;
};

export async function proveWithdrawal(
  args: Parameters<typeof withdrawInput>[0] & { artifacts: CircuitArtifacts },
): Promise<ProvenWithdrawal> {
  const { input, change } = withdrawInput(args);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, args.artifacts.wasm, args.artifacts.zkey);
  const solidity = toSolidityProof(proof, publicSignals) as SolidityProof<8>;
  if (solidity.pubSignals[0] !== change.commitment) {
    throw new Error('The proof commits to a different change note than the one computed here.');
  }
  return { proof: solidity, change };
}

/** A ragequit proof: the depositor shows it knows the note's secrets and takes the note back publicly. */
export async function proveRagequit(note: Note, artifacts: CircuitArtifacts): Promise<SolidityProof<4>> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(ragequitInput(note), artifacts.wasm, artifacts.zkey);
  const solidity = toSolidityProof(proof, publicSignals) as SolidityProof<4>;
  if (solidity.pubSignals[0] !== note.commitment) throw new Error('The ragequit proof names a different commitment.');
  return solidity;
}

/** Off-chain check against a verification key (the parsed `withdraw.vkey` or `commitment.vkey`). */
export async function verifyShieldedProof(vkey: unknown, proof: SolidityProof): Promise<boolean> {
  const s = (v: bigint) => v.toString();
  return snarkjs.groth16.verify(vkey, proof.pubSignals.map(s), {
    pi_a: [s(proof.pA[0]), s(proof.pA[1]), '1'],
    pi_b: [
      [s(proof.pB[0][1]), s(proof.pB[0][0])],
      [s(proof.pB[1][1]), s(proof.pB[1][0])],
      ['1', '0'],
    ],
    pi_c: [s(proof.pC[0]), s(proof.pC[1]), '1'],
    protocol: 'groth16',
    curve: 'bn128',
  });
}

export type { NoteSecrets };
