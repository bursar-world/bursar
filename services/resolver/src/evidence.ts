import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { commitCanonical } from '@bursar/core';
import { deliveryEvidenceTypedData, payerStatementTypedData, verifyDelivery, verifyEvidence } from '@bursar/sdk';
import type { EvidenceSubmission } from '@bursar/sdk';
import { hashTypedData, isAddressEqual, keccak256, toBytes } from 'viem';
import type { Address, Hex } from 'viem';

import { LockStatus } from './chain.js';
import type { ChainPort, LockState, MandateFacts, PayeeFacts } from './chain.js';
import { describeError } from './log.js';
import type { DeliveryCheck, InputCheck, OutputCheck, ValidatorVerdict } from './policy.js';

/** The ceiling on anything this service reads from a URI a party supplied. */
export const MAX_FETCH_BYTES = 1_048_576;

export type Fetched =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'unfetchable'; readonly detail: string }
  | { readonly kind: 'not-public'; readonly detail: string };

export type Fetcher = (uri: string) => Promise<Fetched>;

export type FetcherOptions = {
  readonly timeoutMs: number;
  readonly maxBytes?: number;
  readonly fetch?: typeof fetch;
  readonly resolve?: (host: string) => Promise<readonly string[]>;
};

/**
 * Addresses a URI from a stranger must never make this process connect to. The service sits on a
 * private network next to the console and the facilitator, and a URI is the easiest request
 * forgery there is: "fetch my output" pointed at an internal admin port.
 */
const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6');
}

function isPrivate(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return PRIVATE.check(mapped, 'ipv4');
  return PRIVATE.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Reads a `data:` URI in place, or an `http(s):` URI from a public host, within a size and a time
 * limit. Redirects are refused rather than followed, because the host a redirect lands on is not
 * the host that was checked.
 *
 * A host is resolved and every address it resolves to has to be public. That leaves the window a
 * rebinding resolver can use between this lookup and the connection; the redirect refusal and the
 * size and time caps are what bound it.
 */
export function createFetcher(options: FetcherOptions): Fetcher {
  const maxBytes = options.maxBytes ?? MAX_FETCH_BYTES;
  const doFetch = options.fetch ?? globalThis.fetch;
  const resolve =
    options.resolve ?? (async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address));

  return async (uri) => {
    if (uri.slice(0, 5).toLowerCase() === 'data:') return readDataUri(uri, maxBytes);

    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return { kind: 'unfetchable', detail: 'it is not a URL' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { kind: 'not-public', detail: `${url.protocol} is not a scheme anyone can fetch from` };
    }

    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: readonly string[];
    try {
      addresses = isIP(host) === 0 ? await resolve(host) : [host];
    } catch (error) {
      return { kind: 'unfetchable', detail: `${host} does not resolve: ${describeError(error)}` };
    }
    if (addresses.length === 0 || addresses.some(isPrivate)) {
      return { kind: 'not-public', detail: `${host} resolves to a private address` };
    }

    try {
      const response = await doFetch(url, { redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs) });
      if (!response.ok) return { kind: 'unfetchable', detail: `HTTP ${response.status}` };
      return await readCapped(response, maxBytes);
    } catch (error) {
      return { kind: 'unfetchable', detail: describeError(error) };
    }
  };
}

async function readCapped(response: Response, maxBytes: number): Promise<Fetched> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) return { kind: 'unfetchable', detail: `larger than ${maxBytes} bytes` };

  const reader = response.body?.getReader();
  if (reader === undefined) return { kind: 'ok', text: '' };

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { kind: 'unfetchable', detail: `larger than ${maxBytes} bytes` };
    }
    chunks.push(value);
  }

  return decode(Buffer.concat(chunks));
}

function readDataUri(uri: string, maxBytes: number): Fetched {
  const comma = uri.indexOf(',');
  if (comma === -1) return { kind: 'unfetchable', detail: 'the data URI has no payload' };

  const header = uri.slice(5, comma).toLowerCase();
  const payload = uri.slice(comma + 1);
  let bytes: Buffer;
  try {
    bytes = header.endsWith(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch {
    return { kind: 'unfetchable', detail: 'the data URI does not decode' };
  }
  if (bytes.byteLength > maxBytes) return { kind: 'unfetchable', detail: `larger than ${maxBytes} bytes` };

  return decode(bytes);
}

function decode(bytes: Uint8Array): Fetched {
  try {
    return { kind: 'ok', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { kind: 'unfetchable', detail: 'the content is not UTF-8' };
  }
}

/**
 * A validator a capability publishes for its output. None is published for any capability yet, and
 * the policy falls back to "well-formed, non-empty JSON" wherever one is missing.
 */
export type CapabilityValidator = (output: unknown, input: unknown) => Exclude<ValidatorVerdict, 'none'>;

export type Validators = ReadonlyMap<string, CapabilityValidator>;

export const NO_VALIDATORS: Validators = new Map();

/** E1 and E2: the chain as it stood at one pinned block, and the job the payer committed to. */
export type Snapshot = {
  readonly block: bigint;
  readonly chainTime: bigint;
  readonly lock: LockState;
  readonly heldInDispute: boolean;
  readonly mandate: MandateFacts | null;
  readonly payee: PayeeFacts;
  readonly input: InputCheck;
  /** keccak256 of the input bytes as fetched. Published so anyone can check what was read. */
  readonly inputHash: Hex | null;
  /** The input document, parsed, for a validator that needs it. Never published. */
  readonly inputDocument: unknown;
};

export async function takeSnapshot(args: {
  readonly chain: ChainPort;
  readonly escrow: Address;
  readonly escrowId: bigint;
  readonly block: bigint;
  readonly chainTime: bigint;
  readonly fetcher: Fetcher;
}): Promise<Snapshot> {
  const { chain, escrow, escrowId, block } = args;
  const lock = await chain.lock(escrow, escrowId, block);
  const [mandate, payee] = await Promise.all([
    chain.mandate(lock.payer, lock.capabilityId, lock.payee, block),
    chain.payee(escrow, lock.payee, block),
  ]);

  const input = await checkInput(lock, args.fetcher);

  return {
    block,
    chainTime: args.chainTime,
    lock,
    heldInDispute: lock.status === LockStatus.Disputed && lock.releasedAt === 0n,
    mandate,
    payee,
    ...input,
  };
}

async function checkInput(
  lock: LockState,
  fetcher: Fetcher,
): Promise<{ input: InputCheck; inputHash: Hex | null; inputDocument: unknown }> {
  if (lock.inputURI.trim() === '') return { input: { kind: 'missing' }, inputHash: null, inputDocument: null };

  const fetched = await fetcher(lock.inputURI);
  if (fetched.kind !== 'ok') return { input: { kind: 'unfetchable', detail: fetched.detail }, inputHash: null, inputDocument: null };

  const inputHash = keccak256(toBytes(fetched.text));
  const parsed = parseJson(fetched.text);
  if (parsed === undefined) return { input: { kind: 'mismatch', detail: 'the input is not JSON' }, inputHash, inputDocument: null };

  const commit = commitCanonical(parsed.value);
  if (commit.toLowerCase() !== lock.inputCommit.toLowerCase()) {
    return { input: { kind: 'mismatch', detail: `it hashes to ${commit}` }, inputHash, inputDocument: null };
  }

  return { input: { kind: 'verified' }, inputHash, inputDocument: parsed.value };
}

/** The digest a submission was signed over. Published as its hash, so anyone can match it to its source. */
export function evidenceHash(submission: EvidenceSubmission): Hex {
  return submission.kind === 'delivery'
    ? hashTypedData(deliveryEvidenceTypedData(submission.escrow, submission.chainId, submission.evidence))
    : hashTypedData(payerStatementTypedData(submission.escrow, submission.chainId, submission.statement));
}

/** P3 to P5's inputs for one piece of delivery evidence. */
export async function checkDelivery(args: {
  readonly submission: Extract<EvidenceSubmission, { kind: 'delivery' }>;
  readonly lock: LockState;
  /**
   * The committed input as it was checked. A validator is consulted only against an input that was
   * read back: one handed nothing would judge the output against a job it never saw, and a refusal
   * there would be a refund for the payer's own omission.
   */
  readonly input: InputCheck;
  readonly inputDocument: unknown;
  readonly fetcher: Fetcher;
  readonly validators: Validators;
  /**
   * Outputs a disclosure grant revealed, keyed by commitment. One that hashes to the commitment
   * the payee signed is the output, whether or not its URI is public.
   */
  readonly disclosedOutputs?: ReadonlyMap<string, unknown>;
}): Promise<DeliveryCheck> {
  const { submission, lock } = args;
  const hash = evidenceHash(submission);
  const signedByPayee = await verifyEvidence(submission, lock.payee);
  const inputMatches = submission.evidence.inputCommit.toLowerCase() === lock.inputCommit.toLowerCase();

  const fetched = await args.fetcher(submission.evidence.outputURI);
  let outcome = outputCheck(fetched, submission.evidence.outputCommit);
  const disclosed = args.disclosedOutputs?.get(submission.evidence.outputCommit.toLowerCase());
  if (outcome.check.kind !== 'verified' && disclosed !== undefined) {
    outcome = { check: { kind: 'verified', wellFormed: nonEmpty(disclosed) }, output: disclosed };
  }

  let validator: ValidatorVerdict = 'none';
  const validate = args.validators.get(lock.capabilityId.toLowerCase());
  if (validate !== undefined && args.input.kind === 'verified' && outcome.check.kind === 'verified') {
    try {
      validator = validate(outcome.output, args.inputDocument);
    } catch {
      // A validator that throws has not passed anything. Treated as a rejection, never as absent.
      validator = 'fail';
    }
  }

  return { hash, signedByPayee, inputMatches, output: outcome.check, validator };
}

function outputCheck(fetched: Fetched, outputCommit: Hex): { check: OutputCheck; output: unknown } {
  if (fetched.kind === 'unfetchable') return { check: { kind: 'unfetchable', detail: fetched.detail }, output: null };
  if (fetched.kind === 'not-public') return { check: { kind: 'not-public', detail: fetched.detail }, output: null };

  const parsed = parseJson(fetched.text);
  if (parsed === undefined) return { check: { kind: 'mismatch', detail: 'the output is not JSON' }, output: null };
  if (!verifyDelivery({ outputCommit, output: parsed.value })) {
    return { check: { kind: 'mismatch', detail: `it hashes to ${commitCanonical(parsed.value)}` }, output: null };
  }

  return { check: { kind: 'verified', wellFormed: nonEmpty(parsed.value) }, output: parsed.value };
}

/** Parsed JSON in a box, so `null` as a document and "did not parse" stay different answers. */
function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

function nonEmpty(value: unknown): boolean {
  if (value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Whether an address is one the operator controls. C-b hangs on this. */
export function isOperatorParty(lock: LockState, operator: readonly Address[] | null): boolean {
  if (operator === null) return false;
  return operator.some((address) => isAddressEqual(address, lock.payer) || isAddressEqual(address, lock.payee));
}
