/**
 * Committed mandates: terms that live off chain behind a Poseidon commitment.
 *
 * The principal writes the terms, the SDK commits to them and seals the readable copy to the
 * principal's viewing key. The account stores the commitment and a counter commitment, and every
 * spend proves it fits (see `@bursar/sdk/prove`). The agent holds the same terms document so it
 * can prove; nobody else sees a cap, a class or a counterparty.
 */

import { counterpartyTree, initialCounter, termsCommitment, type CommittedTerms } from '@bursar/circuits';
import { committedMandateAccountAbi, committedMandateFactoryAbi } from '@bursar/core';
import {
  bytesToHex,
  concatBytes,
  getAddress,
  hexToBytes,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import { InvalidArgumentError } from './errors.js';

export { committedMandateAccountAbi, committedMandateFactoryAbi };

/** Class bits a committed mandate can allow. Escrow spends are services (0) and hires (1). */
export const COMMITTED_CLASSES = { service: 0, hire: 1 } as const;
export type CommittedClass = keyof typeof COMMITTED_CLASSES;

/** The readable terms, as the principal writes them and the viewing key opens them. */
export type TermsDocument = {
  readonly v: 1;
  readonly perCallCap: string;
  readonly periodCap: string;
  readonly periodLen: number;
  readonly totalCap: string;
  readonly classes: readonly CommittedClass[];
  readonly counterparties: readonly Address[];
  readonly expiry: number;
  /** Decimal field element. Hides the terms behind the commitment; never reuse one. */
  readonly salt: string;
  readonly label?: string;
};

export type TermsInput = {
  readonly perCallCap: bigint;
  readonly periodCap: bigint;
  readonly periodLen: number;
  readonly totalCap: bigint;
  readonly classes: readonly CommittedClass[];
  readonly counterparties: readonly Address[];
  readonly expiry: number;
  readonly label?: string;
};

const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function randomSalt(): bigint {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(31));
  return BigInt(bytesToHex(raw));
}

export function writeTerms(input: TermsInput): TermsDocument {
  const fail = (field: string, message: string) => {
    throw new InvalidArgumentError(field, message, {});
  };
  if (input.perCallCap <= 0n) fail('perCallCap', 'The per-call cap must be above zero.');
  if (input.periodCap < input.perCallCap) fail('periodCap', 'The period cap cannot be below the per-call cap.');
  if (input.totalCap < input.periodCap) fail('totalCap', 'The total budget cannot be below the period cap.');
  if (!Number.isInteger(input.periodLen) || input.periodLen <= 0) fail('periodLen', 'The period is a whole number of seconds.');
  if (input.classes.length === 0) fail('classes', 'Allow at least one class.');
  if (input.counterparties.length === 0) fail('counterparties', 'Name at least one counterparty.');
  return {
    v: 1,
    perCallCap: input.perCallCap.toString(),
    periodCap: input.periodCap.toString(),
    periodLen: input.periodLen,
    totalCap: input.totalCap.toString(),
    classes: [...new Set(input.classes)],
    counterparties: [...new Set(input.counterparties.map((a) => getAddress(a)))],
    expiry: input.expiry,
    salt: randomSalt().toString(),
    ...(input.label ? { label: input.label } : {}),
  };
}

export function classMaskOf(classes: readonly CommittedClass[]): bigint {
  return classes.reduce((mask, c) => mask | (1n << BigInt(COMMITTED_CLASSES[c])), 0n);
}

/** The circuit's view of a document: field elements, with the counterparty list reduced to a root. */
export function circuitTerms(doc: TermsDocument): CommittedTerms & { counterpartyRoot: bigint } {
  const salt = BigInt(doc.salt);
  if (salt >= SNARK_FIELD) throw new InvalidArgumentError('salt', 'The salt is outside the field.', {});
  return {
    perCallCap: BigInt(doc.perCallCap),
    periodCap: BigInt(doc.periodCap),
    periodLen: BigInt(doc.periodLen),
    totalCap: BigInt(doc.totalCap),
    classMask: classMaskOf(doc.classes),
    counterpartyRoot: counterpartyTree(doc.counterparties).root,
    expiry: BigInt(doc.expiry),
    salt,
  };
}

export type Commitment = { readonly termsCommitment: bigint; readonly counter: bigint };

export function commit(doc: TermsDocument): Commitment {
  return { termsCommitment: termsCommitment(circuitTerms(doc)), counter: initialCounter(doc.salt) };
}

const TERMS_VERSION = 1;
const PAD_TO = 512;

function aad(principal: Address): Uint8Array {
  return new TextEncoder().encode(`bursar.terms.v1:${getAddress(principal)}`);
}

async function termsCryptoKey(termsKey: Uint8Array) {
  return globalThis.crypto.subtle.importKey('raw', termsKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Seals the terms under the principal's terms key. The plaintext is padded to a multiple of
 * 512 bytes so the ciphertext length does not give away how many counterparties there are.
 */
export async function sealTerms(termsKey: Uint8Array, principal: Address, doc: TermsDocument): Promise<Hex> {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const padded = new Uint8Array(Math.ceil((json.length + 1) / PAD_TO) * PAD_TO);
  padded.set(json);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(principal) },
    await termsCryptoKey(termsKey),
    padded,
  );
  return bytesToHex(concatBytes([Uint8Array.of(TERMS_VERSION), iv, new Uint8Array(ciphertext)]));
}

export class TermsLockedError extends Error {
  constructor() {
    super('This viewing key does not open these terms.');
    this.name = 'TermsLockedError';
  }
}

export async function openTerms(termsKey: Uint8Array, principal: Address, sealed: Hex): Promise<TermsDocument> {
  const raw = hexToBytes(sealed);
  if (raw[0] !== TERMS_VERSION || raw.length < 13 + 16) throw new TermsLockedError();
  let plain: ArrayBuffer;
  try {
    plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(1, 13), additionalData: aad(principal) },
      await termsCryptoKey(termsKey),
      raw.slice(13),
    );
  } catch {
    throw new TermsLockedError();
  }
  const bytes = new Uint8Array(plain);
  const end = bytes.indexOf(0);
  return JSON.parse(new TextDecoder().decode(end < 0 ? bytes : bytes.slice(0, end))) as TermsDocument;
}

/** Arguments for `CommittedMandateFactory.create`, ready for `writeContract`. */
export function createArgs(args: {
  principal: Address;
  agent: Address;
  salt: Hex;
  commitment: Commitment;
  sealedTerms: Hex;
}): readonly [Address, Address, Hex, bigint, bigint, Hex] {
  return [args.principal, args.agent, args.salt, args.commitment.termsCommitment, args.commitment.counter, args.sealedTerms];
}

export type SealedTermsRecord = { version: bigint; termsCommitment: bigint; ciphertext: Hex; blockNumber: bigint };

/** The latest `TermsSealed` the account emitted. The console opens it with the viewing key. */
export async function latestSealedTerms(
  client: Pick<PublicClient, 'getLogs'>,
  account: Address,
  fromBlock: bigint = 0n,
): Promise<SealedTermsRecord | null> {
  const logs = await client.getLogs({
    address: account,
    event: committedMandateAccountAbi.find((e) => e.type === 'event' && e.name === 'TermsSealed') as never,
    fromBlock,
    toBlock: 'latest',
  });
  const parsed = parseEventLogs({ abi: committedMandateAccountAbi, logs, eventName: 'TermsSealed' });
  const last = parsed.at(-1);
  if (!last) return null;
  return {
    version: BigInt(last.args.version),
    termsCommitment: last.args.termsCommitment,
    ciphertext: last.args.ciphertext,
    blockNumber: last.blockNumber,
  };
}
