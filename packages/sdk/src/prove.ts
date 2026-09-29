/**
 * The within-mandate prover, for Node. snarkjs runs the circuit's wasm witness generator and a
 * Groth16 prover over the committed zkey; one proof takes about a second.
 *
 * Imported as `@bursar/sdk/prove` so browser bundles of the main entry never pull in snarkjs or
 * the 8 MB of proving artifacts.
 */

import { readFileSync } from 'node:fs';

import { counterCommitment, spendInput } from '@bursar/circuits';
import { artifacts } from '@bursar/circuits/artifacts';
import { committedMandateAccountAbi, escrowAbi } from '@bursar/core';
import * as snarkjs from 'snarkjs';
import { decodeFunctionData, parseEventLogs, type Address, type Hex, type PublicClient } from 'viem';

import { COMMITTED_CLASSES, circuitTerms, type CommittedClass, type TermsDocument } from './committed.js';

export type CounterState = { period: bigint; spent: bigint; total: bigint; nonce: bigint };

export type Groth16Proof = {
  a: readonly [bigint, bigint];
  b: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
  c: readonly [bigint, bigint];
};

export type ProvenSpend = {
  provenAt: bigint;
  newCounter: bigint;
  nullifier: bigint;
  proof: Groth16Proof;
  publicSignals: string[];
  next: CounterState;
};

export const FRESH_STATE: CounterState = { period: 0n, spent: 0n, total: 0n, nonce: 0n };

/**
 * Proves one spend. `provenAt` is the time the proof speaks for; the account accepts it only
 * while `block.timestamp <= provenAt <= block.timestamp + 15 minutes`, so aim a little ahead of
 * the latest block.
 */
export async function proveSpend(args: {
  terms: TermsDocument;
  state: CounterState;
  mandate: Address;
  payee: Address;
  amount: bigint;
  spendClass: CommittedClass;
  provenAt: bigint;
}): Promise<ProvenSpend> {
  const { input, next } = spendInput({
    terms: circuitTerms(args.terms),
    counterparties: args.terms.counterparties,
    state: args.state,
    mandate: args.mandate,
    payee: args.payee,
    amount: args.amount,
    classId: COMMITTED_CLASSES[args.spendClass],
    now: args.provenAt,
  });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, artifacts.wasm, artifacts.zkey);
  const n = (v: string | undefined) => BigInt(v ?? 0);
  return {
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

/** Arguments for `CommittedMandateAccount.spend`. */
export function spendArgs(
  proven: ProvenSpend,
  lock: {
    payee: Address;
    capabilityId: Hex;
    inputCommit: Hex;
    inputURI: string;
    amount: bigint;
    deadline: bigint;
    spendClass: CommittedClass;
  },
) {
  return [
    {
      payee: lock.payee,
      capabilityId: lock.capabilityId,
      inputCommit: lock.inputCommit,
      inputURI: lock.inputURI,
      amount: lock.amount,
      deadline: lock.deadline,
      classId: COMMITTED_CLASSES[lock.spendClass],
      provenAt: proven.provenAt,
      newCounter: proven.newCounter,
      nullifier: proven.nullifier,
    },
    proven.proof,
  ] as const;
}

/**
 * Rebuilds the confidential counters from the chain and the terms. Amounts come from the escrow
 * locks and each proof's time from its transaction, and the result is checked against the
 * account's stored counter commitment, so an agent needs no local state to keep proving.
 */
export async function recoverState(
  client: Pick<PublicClient, 'getLogs' | 'readContract' | 'getTransaction'>,
  account: Address,
  terms: TermsDocument,
  fromBlock: bigint = 0n,
): Promise<CounterState> {
  const [escrow, nonce, stored, version] = await Promise.all([
    client.readContract({ address: account, abi: committedMandateAccountAbi, functionName: 'escrow' }),
    client.readContract({ address: account, abi: committedMandateAccountAbi, functionName: 'nonce' }),
    client.readContract({ address: account, abi: committedMandateAccountAbi, functionName: 'counter' }),
    client.readContract({ address: account, abi: committedMandateAccountAbi, functionName: 'version' }),
  ]);
  if (version > 1n) throw new Error('This mandate was amended; recover from the amended counter instead.');

  const logs = await client.getLogs({ address: account, fromBlock, toBlock: 'latest' });
  const spends = parseEventLogs({ abi: committedMandateAccountAbi, logs, eventName: 'ProvenSpend' });

  const periodLen = BigInt(terms.periodLen);
  let state = FRESH_STATE;
  for (const log of spends) {
    const [lock, tx] = await Promise.all([
      client.readContract({ address: escrow, abi: escrowAbi, functionName: 'getLock', args: [log.args.escrowId] }),
      client.getTransaction({ hash: log.transactionHash }),
    ]);
    const call = decodeFunctionData({ abi: committedMandateAccountAbi, data: tx.input });
    if (call.functionName !== 'spend') throw new Error(`Spend ${log.transactionHash} did not call spend directly.`);
    const period = call.args[0].provenAt / periodLen;
    const carried = period === state.period ? state.spent : 0n;
    state = { period, spent: carried + lock.amount, total: state.total + lock.amount, nonce: state.nonce + 1n };
  }

  if (state.nonce !== BigInt(nonce) || counterCommitment(state, terms.salt) !== stored) {
    throw new Error('The recovered counters do not match the account. Are these the right terms?');
  }
  return state;
}
