/**
 * Committed mandates: terms that live off chain behind a Poseidon commitment.
 *
 * The principal writes the terms, the SDK commits to them and seals the readable copy to the
 * principal's viewing key. The account stores the commitment and a counter commitment, and every
 * spend proves it fits (see `@bursar/sdk/prove`). The agent holds the same terms document so it
 * can prove; nobody else sees a cap, a capability or a counterparty.
 */

import {
  MAX_CAPABILITIES,
  capabilityTree,
  counterCommitment,
  counterpartyTree,
  termsCommitment,
  type CommittedTerms,
} from '@bursar/circuits';
import {
  capabilityId,
  classOfLabel,
  committedMandateAccountAbi,
  committedMandateFactoryAbi,
  escrowAbi,
} from '@bursar/core';
import {
  bytesToHex,
  concatBytes,
  getAddress,
  hexToBytes,
  isAddress,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import { InvalidArgumentError } from './errors.js';
import { logsSince } from './logs.js';

export { committedMandateAccountAbi, committedMandateFactoryAbi };

/** The classes a committed mandate can pay: its escrow locks carry services and agent hires. */
export const COMMITTED_CLASSES = ['service', 'hire'] as const;
export type CommittedClass = (typeof COMMITTED_CLASSES)[number];

/** The confidential counter: spend in the current period, lifetime spend, and how many proofs. */
export type CounterState = { period: bigint; spent: bigint; total: bigint; nonce: bigint };

export const FRESH_STATE: CounterState = { period: 0n, spent: 0n, total: 0n, nonce: 0n };

/** The readable terms, as the principal writes them and the viewing key opens them. */
export type TermsDocument = {
  readonly v: 2;
  readonly perCallCap: string;
  readonly periodCap: string;
  readonly periodLen: number;
  readonly totalCap: string;
  /** Capability labels under `service:` or `hire:`. A spend proves its capability is one of them. */
  readonly capabilities: readonly string[];
  readonly counterparties: readonly Address[];
  readonly expiry: number;
  /** Decimal field element. Hides the terms behind the commitment; never reuse one. */
  readonly salt: string;
  /** The counters these terms take over, as decimals. Absent on a mandate's first terms, which start at zero. */
  readonly start?: { readonly period: string; readonly spent: string; readonly total: string; readonly nonce: string };
  readonly label?: string;
};

export type TermsInput = {
  readonly perCallCap: bigint;
  readonly periodCap: bigint;
  readonly periodLen: number;
  readonly totalCap: bigint;
  readonly capabilities: readonly string[];
  readonly counterparties: readonly Address[];
  readonly expiry: number;
  readonly label?: string;
};

const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function randomSalt(): bigint {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(31));
  return BigInt(bytesToHex(raw));
}

/**
 * A capability a committed mandate can allow, as its label. It has to sit in the service or hire
 * namespace, because the class of a spend is read from the label; a bare 32-byte id says nothing
 * about its class and is refused.
 */
export function committedCapability(label: string): string {
  const trimmed = label.trim();
  const spendClass = classOfLabel(trimmed);
  if ((spendClass !== 'service' && spendClass !== 'hire') || trimmed.length <= spendClass.length + 1) {
    throw new InvalidArgumentError('capabilities', 'A capability is a label under service: or hire:, such as service:gpu.render:1.', {
      capability: label,
    });
  }
  return trimmed;
}

/** The classes a document's capabilities fall in, in the order `COMMITTED_CLASSES` lists them. */
export function classesOf(doc: Pick<TermsDocument, 'capabilities'>): CommittedClass[] {
  return COMMITTED_CLASSES.filter((c) => doc.capabilities.some((label) => classOfLabel(label) === c));
}

export function capabilityIdsOf(doc: Pick<TermsDocument, 'capabilities'>): Hex[] {
  return doc.capabilities.map(capabilityId);
}

/**
 * Terms from what the principal typed. `start` is where the counters stand when the terms take
 * effect: leave it out for a new mandate, and pass the carried-over counters when amending.
 */
export function writeTerms(input: TermsInput, start?: CounterState): TermsDocument {
  const fail = (field: string, message: string) => {
    throw new InvalidArgumentError(field, message, {});
  };
  if (input.perCallCap <= 0n) fail('perCallCap', 'The per-call cap must be above zero.');
  if (input.periodCap < input.perCallCap) fail('periodCap', 'The period cap cannot be below the per-call cap.');
  if (input.totalCap < input.periodCap) fail('totalCap', 'The total budget cannot be below the period cap.');
  if (!Number.isInteger(input.periodLen) || input.periodLen <= 0) fail('periodLen', 'The period is a whole number of seconds.');
  const capabilities = [...new Set(input.capabilities.map(committedCapability))];
  if (capabilities.length === 0) fail('capabilities', 'Allow at least one capability.');
  if (capabilities.length > MAX_CAPABILITIES) fail('capabilities', `Allow at most ${MAX_CAPABILITIES} capabilities.`);
  if (input.counterparties.length === 0) fail('counterparties', 'Name at least one counterparty.');
  return {
    v: 2,
    perCallCap: input.perCallCap.toString(),
    periodCap: input.periodCap.toString(),
    periodLen: input.periodLen,
    totalCap: input.totalCap.toString(),
    capabilities,
    counterparties: [...new Set(input.counterparties.map((a) => getAddress(a)))],
    expiry: input.expiry,
    salt: randomSalt().toString(),
    ...(start
      ? {
          start: {
            period: start.period.toString(),
            spent: start.spent.toString(),
            total: start.total.toString(),
            nonce: start.nonce.toString(),
          },
        }
      : {}),
    ...(input.label ? { label: input.label } : {}),
  };
}

export function startOf(doc: Pick<TermsDocument, 'start'>): CounterState {
  const s = doc.start;
  return s ? { period: BigInt(s.period), spent: BigInt(s.spent), total: BigInt(s.total), nonce: BigInt(s.nonce) } : FRESH_STATE;
}

/**
 * The counters new terms take over from the old: the lifetime total and the nonce always, and the
 * current period's spend only when the period length is unchanged. A different length restarts the
 * period, because period numbers in the old length mean nothing in the new one.
 */
export function carriedState(state: CounterState, previous: Pick<TermsDocument, 'periodLen'>, periodLen: number): CounterState {
  return previous.periodLen === periodLen ? state : { period: 0n, spent: 0n, total: state.total, nonce: state.nonce };
}

/** The circuit's view of a document: field elements, with each list reduced to its tree root. */
export function circuitTerms(doc: TermsDocument): CommittedTerms & { capabilityRoot: bigint; counterpartyRoot: bigint } {
  const salt = BigInt(doc.salt);
  if (salt >= SNARK_FIELD) throw new InvalidArgumentError('salt', 'The salt is outside the field.', {});
  return {
    perCallCap: BigInt(doc.perCallCap),
    periodCap: BigInt(doc.periodCap),
    periodLen: BigInt(doc.periodLen),
    totalCap: BigInt(doc.totalCap),
    capabilityRoot: capabilityTree(capabilityIdsOf(doc)).root,
    counterpartyRoot: counterpartyTree(doc.counterparties).root,
    expiry: BigInt(doc.expiry),
    salt,
  };
}

export type Commitment = { readonly termsCommitment: bigint; readonly counter: bigint; readonly nonce: bigint };

export function commit(doc: TermsDocument): Commitment {
  const start = startOf(doc);
  return { termsCommitment: termsCommitment(circuitTerms(doc)), counter: counterCommitment(start, doc.salt), nonce: start.nonce };
}

/** Checks the shape of a terms document read from a file or a ciphertext. */
export function readTermsDocument(value: unknown): TermsDocument {
  const fail = (message: string): never => {
    throw new InvalidArgumentError('terms', message, {});
  };
  if (typeof value !== 'object' || value === null) return fail('The terms are not an object.');
  const t = value as Record<string, unknown>;
  const whole = (v: unknown) => typeof v === 'string' && /^\d{1,78}$/.test(v);
  const seconds = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (t['v'] !== 2) fail('These terms are not version 2 terms.');
  if (!whole(t['perCallCap']) || !whole(t['periodCap']) || !whole(t['totalCap']) || !whole(t['salt'])) fail('A cap or the salt is not a decimal.');
  if (!seconds(t['periodLen']) || (t['periodLen'] as number) === 0 || !seconds(t['expiry'])) fail('The period or the expiry is not a time.');
  const capabilities = t['capabilities'];
  const committed = (c: unknown) => typeof c === 'string' && (classOfLabel(c) === 'service' || classOfLabel(c) === 'hire');
  if (!Array.isArray(capabilities) || capabilities.length === 0 || !capabilities.every(committed)) {
    fail('The terms list no service or hire capabilities.');
  }
  const counterparties = t['counterparties'];
  if (!Array.isArray(counterparties) || counterparties.length === 0 || !counterparties.every((a) => typeof a === 'string' && isAddress(a))) {
    fail('The terms list no counterparties.');
  }
  const start = t['start'];
  if (start !== undefined) {
    const s = (typeof start === 'object' && start !== null ? start : {}) as Record<string, unknown>;
    if (!(whole(s['period']) && whole(s['spent']) && whole(s['total']) && whole(s['nonce']))) fail('The starting counters are not decimals.');
  }
  if (t['label'] !== undefined && typeof t['label'] !== 'string') fail('The label is not text.');
  return value as TermsDocument;
}

const ENVELOPE = 2;
const PAD_TO = 512;

/** Where a sealed copy belongs: the account and the terms version it is published as. */
export type SealedFor = { readonly account: Address; readonly version: bigint | number };

function aad({ account, version }: SealedFor): Uint8Array {
  return new TextEncoder().encode(`bursar.terms.v2:${getAddress(account)}:${BigInt(version)}`);
}

async function termsCryptoKey(termsKey: Uint8Array) {
  return globalThis.crypto.subtle.importKey('raw', termsKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Seals the terms under the principal's terms key, bound to the account and the version they are
 * published as, so a copy cannot be replayed as another mandate's terms or another version. The
 * plaintext is padded to a multiple of 512 bytes so the length does not give away how many
 * counterparties or capabilities there are.
 */
export async function sealTerms(termsKey: Uint8Array, sealedFor: SealedFor, doc: TermsDocument): Promise<Hex> {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const padded = new Uint8Array(Math.ceil((json.length + 1) / PAD_TO) * PAD_TO);
  padded.set(json);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(sealedFor) },
    await termsCryptoKey(termsKey),
    padded,
  );
  return bytesToHex(concatBytes([Uint8Array.of(ENVELOPE), iv, new Uint8Array(ciphertext)]));
}

export class TermsLockedError extends Error {
  constructor() {
    super('This viewing key does not open these terms.');
    this.name = 'TermsLockedError';
  }
}

export class TermsMismatchError extends Error {
  constructor() {
    super('These terms open, but they are not the terms the mandate committed to.');
    this.name = 'TermsMismatchError';
  }
}

/**
 * Opens a sealed copy and checks it against the commitment the account holds. A copy that opens
 * but commits to anything else is refused, so what the console shows is what every proof is held to.
 */
export async function openTerms(
  termsKey: Uint8Array,
  sealed: SealedFor & { readonly termsCommitment: bigint; readonly ciphertext: Hex },
): Promise<TermsDocument> {
  const raw = hexToBytes(sealed.ciphertext);
  if (raw[0] !== ENVELOPE || raw.length < 13 + 16) throw new TermsLockedError();
  let plain: ArrayBuffer;
  try {
    plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(1, 13), additionalData: aad(sealed) },
      await termsCryptoKey(termsKey),
      raw.slice(13),
    );
  } catch {
    throw new TermsLockedError();
  }
  const bytes = new Uint8Array(plain);
  const end = bytes.indexOf(0);
  let doc: TermsDocument;
  try {
    doc = readTermsDocument(JSON.parse(new TextDecoder().decode(end < 0 ? bytes : bytes.slice(0, end))));
  } catch {
    throw new TermsMismatchError();
  }
  if (commit(doc).termsCommitment !== sealed.termsCommitment) throw new TermsMismatchError();
  return doc;
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

/** Where `create` will put the account. The first sealed copy is bound to this address. */
export async function predictAccount(
  client: Pick<PublicClient, 'readContract'>,
  factory: Address,
  args: { principal: Address; agent: Address; salt: Hex; commitment: Commitment },
): Promise<Address> {
  return client.readContract({
    address: factory,
    abi: committedMandateFactoryAbi,
    functionName: 'predict',
    args: [args.principal, args.agent, args.salt, args.commitment.termsCommitment, args.commitment.counter],
  });
}

/**
 * Arguments for `CommittedMandateAccount.amend`: the new commitment, the counter and nonce the new
 * terms start from (their `start`), and the copy sealed for the next version.
 */
export function amendArgs(doc: TermsDocument, sealedTerms: Hex): readonly [bigint, bigint, bigint, Hex] {
  const { termsCommitment: next, counter, nonce } = commit(doc);
  return [next, counter, nonce, sealedTerms];
}

export type SealedTermsRecord = { version: bigint; termsCommitment: bigint; ciphertext: Hex; blockNumber: bigint };

/** The latest `TermsSealed` the account emitted. The console opens it with the viewing key. */
export async function latestSealedTerms(
  client: Pick<PublicClient, 'getLogs'> & Partial<Pick<PublicClient, 'getBlockNumber'>>,
  account: Address,
  fromBlock: bigint = 0n,
): Promise<SealedTermsRecord | null> {
  const logs = await logsSince(
    client,
    account,
    fromBlock,
    committedMandateAccountAbi.find((e) => e.type === 'event' && e.name === 'TermsSealed'),
  );
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

/**
 * Rebuilds the confidential counters from the chain and the current terms, so an agent needs no
 * local state to keep proving. The counters start where the terms say, and every `ProvenSpend`
 * made under the account's current terms version adds its lock's amount in the period of its proof
 * time. Both come from the log, so a spend sent through a wallet contract or a relayer reads the
 * same as one sent directly. The result has to match the account's stored commitment.
 */
export async function recoverState(
  client: Pick<PublicClient, 'getLogs' | 'readContract'> & Partial<Pick<PublicClient, 'getBlockNumber'>>,
  account: Address,
  terms: TermsDocument,
  fromBlock: bigint = 0n,
): Promise<CounterState> {
  const abi = committedMandateAccountAbi;
  const [escrow, nonce, stored, version] = await Promise.all([
    client.readContract({ address: account, abi, functionName: 'escrow' }),
    client.readContract({ address: account, abi, functionName: 'nonce' }),
    client.readContract({ address: account, abi, functionName: 'counter' }),
    client.readContract({ address: account, abi, functionName: 'version' }),
  ]);

  const logs = await logsSince(client, account, fromBlock);
  const spends = parseEventLogs({ abi, logs, eventName: 'ProvenSpend' }).filter((log) => log.args.version === version);

  const periodLen = BigInt(terms.periodLen);
  let state = startOf(terms);
  for (const log of spends) {
    const lock = await client.readContract({ address: escrow, abi: escrowAbi, functionName: 'getLock', args: [log.args.escrowId] });
    const period = log.args.provenAt / periodLen;
    const carried = period === state.period ? state.spent : 0n;
    state = { period, spent: carried + lock.amount, total: state.total + lock.amount, nonce: state.nonce + 1n };
  }

  if (state.nonce !== BigInt(nonce) || counterCommitment(state, terms.salt) !== stored) {
    throw new Error('The recovered counters do not match the account. Are these its current terms?');
  }
  return state;
}
