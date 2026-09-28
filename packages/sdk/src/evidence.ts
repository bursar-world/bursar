/**
 * What a party to a disputed lock hands the resolvers, and how anyone checks who handed it over.
 *
 * A lock disputed before release has no output on chain: the payer froze it, so the payee never
 * got to call `release`. The delivery has to reach the resolvers another way, and that way cannot
 * be trusted on the carrier's word. So the payee signs a typed statement of what it delivered and
 * where, and the resolver service checks the signature against the payee the escrow recorded. The
 * payee's own key is the only thing that can say "this was my delivery", which is the claim a
 * ruling rests on.
 *
 * The domain is bound to one escrow on one chain. A statement signed for a lock on another escrow
 * does not verify here even when the ids happen to match.
 */

import { getAddress, isAddressEqual, recoverTypedDataAddress } from 'viem';
import type { Address, Hex, LocalAccount, TypedDataDomain } from 'viem';

import { InvalidArgumentError } from './errors.js';
import { UINT64_MAX, checkAddress, checkBytes32, checkEscrowId } from './guards.js';

/** Fixed by the resolver service. Changing either invalidates every signature already collected. */
export const EVIDENCE_DOMAIN_NAME = 'Bursar Evidence';
export const EVIDENCE_DOMAIN_VERSION = '1';

export const DELIVERY_EVIDENCE_TYPES = {
  DeliveryEvidence: [
    { name: 'escrowId', type: 'uint256' },
    { name: 'inputCommit', type: 'bytes32' },
    { name: 'outputCommit', type: 'bytes32' },
    { name: 'outputURI', type: 'string' },
    { name: 'deliveredAt', type: 'uint64' },
  ],
} as const;

export const PAYER_STATEMENT_TYPES = {
  PayerStatement: [
    { name: 'escrowId', type: 'uint256' },
    { name: 'reason', type: 'string' },
  ],
} as const;

/**
 * Long enough for a delivery carried inline as a data URI at the sidecar's default inline size,
 * base64 included, with room to spare. Anything larger belongs at a URL.
 */
export const MAX_OUTPUT_URI_CHARS = 32_768;

/** A statement, not a brief. Resolvers publish it; they do not score it. */
export const MAX_STATEMENT_CHARS = 2_000;

export type DeliveryEvidence = {
  readonly escrowId: bigint;
  /** Has to equal the lock's own `inputCommit`, or the delivery answers some other job. */
  readonly inputCommit: Hex;
  /** Hash of the canonical JSON of the delivered output, as `release` would have committed it. */
  readonly outputCommit: Hex;
  /** Where the payer, and anyone else, can fetch the output. A data URI carries it inline. */
  readonly outputURI: string;
  /** The payee's own claim, in unix seconds. Recorded and published, never scored. */
  readonly deliveredAt: bigint;
};

export type PayerStatement = {
  readonly escrowId: bigint;
  readonly reason: string;
};

export type EvidenceSubmission =
  | {
      readonly kind: 'delivery';
      readonly chainId: number;
      readonly escrow: Address;
      readonly evidence: DeliveryEvidence;
      readonly signature: Hex;
    }
  | {
      readonly kind: 'payer-statement';
      readonly chainId: number;
      readonly escrow: Address;
      readonly statement: PayerStatement;
      readonly signature: Hex;
    };

/** The JSON a submission travels as. Every uint is a decimal string, because JSON has no bigint. */
export type EvidenceWire =
  | {
      readonly kind: 'delivery';
      readonly chainId: number;
      readonly escrow: string;
      readonly evidence: {
        readonly escrowId: string;
        readonly inputCommit: string;
        readonly outputCommit: string;
        readonly outputURI: string;
        readonly deliveredAt: string;
      };
      readonly signature: string;
    }
  | {
      readonly kind: 'payer-statement';
      readonly chainId: number;
      readonly escrow: string;
      readonly statement: { readonly escrowId: string; readonly reason: string };
      readonly signature: string;
    };

export function evidenceDomain(escrow: Address, chainId: number): TypedDataDomain {
  return {
    name: EVIDENCE_DOMAIN_NAME,
    version: EVIDENCE_DOMAIN_VERSION,
    chainId,
    verifyingContract: checkAddress('escrow', escrow),
  };
}

/** The exact object a wallet signs, so a browser, a sidecar and the service hash the same thing. */
export function deliveryEvidenceTypedData(escrow: Address, chainId: number, evidence: DeliveryEvidence) {
  return {
    domain: evidenceDomain(escrow, chainId),
    types: DELIVERY_EVIDENCE_TYPES,
    primaryType: 'DeliveryEvidence',
    message: checkDelivery(evidence),
  } as const;
}

export function payerStatementTypedData(escrow: Address, chainId: number, statement: PayerStatement) {
  return {
    domain: evidenceDomain(escrow, chainId),
    types: PAYER_STATEMENT_TYPES,
    primaryType: 'PayerStatement',
    message: checkStatement(statement),
  } as const;
}

/** Signs delivery evidence with a key held in this process, as a provider's sidecar does. */
export async function signDeliveryEvidence(
  account: LocalAccount,
  escrow: Address,
  chainId: number,
  evidence: DeliveryEvidence,
): Promise<EvidenceSubmission> {
  const signature = await account.signTypedData(deliveryEvidenceTypedData(escrow, chainId, evidence));

  return { kind: 'delivery', chainId, escrow: getAddress(escrow), evidence, signature };
}

export async function signPayerStatement(
  account: LocalAccount,
  escrow: Address,
  chainId: number,
  statement: PayerStatement,
): Promise<EvidenceSubmission> {
  const signature = await account.signTypedData(payerStatementTypedData(escrow, chainId, statement));

  return { kind: 'payer-statement', chainId, escrow: getAddress(escrow), statement, signature };
}

/** Who signed a submission. A malformed signature throws rather than recovering a stranger. */
export async function recoverEvidenceSigner(submission: EvidenceSubmission): Promise<Address> {
  return submission.kind === 'delivery'
    ? recoverTypedDataAddress({
        ...deliveryEvidenceTypedData(submission.escrow, submission.chainId, submission.evidence),
        signature: submission.signature,
      })
    : recoverTypedDataAddress({
        ...payerStatementTypedData(submission.escrow, submission.chainId, submission.statement),
        signature: submission.signature,
      });
}

/**
 * True when `expected` signed the submission. A signature that does not parse is a false, not a
 * throw: to a caller deciding whether to count a delivery the two mean the same thing.
 */
export async function verifyEvidence(submission: EvidenceSubmission, expected: Address): Promise<boolean> {
  try {
    return isAddressEqual(await recoverEvidenceSigner(submission), expected);
  } catch {
    return false;
  }
}

export function encodeEvidence(submission: EvidenceSubmission): EvidenceWire {
  if (submission.kind === 'delivery') {
    const { evidence } = submission;
    return {
      kind: 'delivery',
      chainId: submission.chainId,
      escrow: submission.escrow,
      evidence: {
        escrowId: evidence.escrowId.toString(),
        inputCommit: evidence.inputCommit,
        outputCommit: evidence.outputCommit,
        outputURI: evidence.outputURI,
        deliveredAt: evidence.deliveredAt.toString(),
      },
      signature: submission.signature,
    };
  }

  return {
    kind: 'payer-statement',
    chainId: submission.chainId,
    escrow: submission.escrow,
    statement: { escrowId: submission.statement.escrowId.toString(), reason: submission.statement.reason },
    signature: submission.signature,
  };
}

/**
 * Reads a submission off the wire and checks its shape. The signature is not checked here; that
 * needs the lock, which only the caller has.
 */
export function parseEvidence(body: unknown): EvidenceSubmission {
  const record = object('body', body);
  const kind = record['kind'];
  const chainId = record['chainId'];

  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new InvalidArgumentError('chainId', 'chainId is the chain the escrow is on, as a positive whole number.');
  }

  const escrow = checkAddress('escrow', text('escrow', record['escrow']) as Address);
  const signature = text('signature', record['signature']);
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new InvalidArgumentError('signature', 'signature is a 65-byte 0x hex string.');
  }

  if (kind === 'delivery') {
    const raw = object('evidence', record['evidence']);
    return {
      kind,
      chainId,
      escrow,
      evidence: checkDelivery({
        escrowId: uint('evidence.escrowId', raw['escrowId']),
        inputCommit: text('evidence.inputCommit', raw['inputCommit']) as Hex,
        outputCommit: text('evidence.outputCommit', raw['outputCommit']) as Hex,
        outputURI: text('evidence.outputURI', raw['outputURI']),
        deliveredAt: uint('evidence.deliveredAt', raw['deliveredAt']),
      }),
      signature: signature as Hex,
    };
  }

  if (kind === 'payer-statement') {
    const raw = object('statement', record['statement']);
    return {
      kind,
      chainId,
      escrow,
      statement: checkStatement({
        escrowId: uint('statement.escrowId', raw['escrowId']),
        reason: text('statement.reason', raw['reason']),
      }),
      signature: signature as Hex,
    };
  }

  throw new InvalidArgumentError('kind', 'kind is "delivery" for a payee\'s delivery or "payer-statement" for a payer\'s account.');
}

function checkDelivery(evidence: DeliveryEvidence): DeliveryEvidence {
  const outputURI = evidence.outputURI;
  if (typeof outputURI !== 'string' || outputURI.trim() === '') {
    throw new InvalidArgumentError(
      'outputURI',
      'A delivery names where its output can be fetched. Without one nobody can check the output against its commitment.',
    );
  }
  if (outputURI.length > MAX_OUTPUT_URI_CHARS) {
    throw new InvalidArgumentError(
      'outputURI',
      `outputURI is ${outputURI.length} characters and the limit is ${MAX_OUTPUT_URI_CHARS}. Publish the output at a URL.`,
    );
  }
  if (typeof evidence.deliveredAt !== 'bigint' || evidence.deliveredAt < 0n || evidence.deliveredAt > UINT64_MAX) {
    throw new InvalidArgumentError('deliveredAt', 'deliveredAt is unix seconds as a bigint.');
  }

  return {
    escrowId: checkEscrowId('escrowId', evidence.escrowId),
    inputCommit: checkBytes32('inputCommit', evidence.inputCommit),
    outputCommit: checkBytes32('outputCommit', evidence.outputCommit),
    outputURI,
    deliveredAt: evidence.deliveredAt,
  };
}

function checkStatement(statement: PayerStatement): PayerStatement {
  const reason = typeof statement.reason === 'string' ? statement.reason.trim() : '';
  if (reason === '') {
    throw new InvalidArgumentError('reason', 'A payer statement says what went wrong. An empty one says nothing.');
  }
  if (reason.length > MAX_STATEMENT_CHARS) {
    throw new InvalidArgumentError('reason', `A payer statement is at most ${MAX_STATEMENT_CHARS} characters.`);
  }

  return { escrowId: checkEscrowId('escrowId', statement.escrowId), reason };
}

function object(field: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidArgumentError(field, `${field} is a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function text(field: string, value: unknown): string {
  if (typeof value !== 'string') throw new InvalidArgumentError(field, `${field} is a string.`);
  return value;
}

function uint(field: string, value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) {
    throw new InvalidArgumentError(field, `${field} is a whole number written as a decimal string.`);
  }
  return BigInt(value);
}
