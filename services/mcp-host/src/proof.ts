import { mandateAccountAbi } from '@bursar/core';
import type { RhcPublicClient } from '@bursar/core';
import { assistantConnectMessage, assistantDisconnectMessage, checkAssistantLabel, contractSaidNo } from '@bursar/sdk';
import { getAddress, isAddress, isHex, recoverMessageAddress } from 'viem';
import type { Address, Hex } from 'viem';

/**
 * Whether the owner of a mandate asked for this.
 *
 * The console builds the message, the wallet signs it, and the host rebuilds the same text from
 * the fields it was sent and recovers the signer. The signer has to be the mandate's principal as
 * the chain reports it now, not as the request claims it; the request's `owner` field is there
 * only so the text can be rebuilt. A signature is good for one connection, for a bounded time.
 */

export class ProofError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 403 | 409 = 401,
  ) {
    super(message);
    this.name = 'ProofError';
  }
}

export type ConnectRequest = {
  readonly mandate: Address;
  readonly owner: Address;
  readonly chainId: number;
  readonly nonce: Hex;
  readonly issuedAt: string;
  readonly label?: string;
  readonly signature: Hex;
};

export type DisconnectRequest = ConnectRequest & { readonly connection: string };

export type ChainReads = {
  /** The principal of a mandate account, or null where the address is not one. */
  principalOf(mandate: Address): Promise<Address | null>;
};

export function createChainReads(client: RhcPublicClient): ChainReads {
  return {
    async principalOf(mandate) {
      try {
        return await client.readContract({ address: mandate, abi: mandateAccountAbi, functionName: 'principal' });
      } catch (error) {
        if (contractSaidNo(error)) return null;
        throw error;
      }
    },
  };
}

export type ProofOptions = {
  readonly chainId: number;
  readonly reads: ChainReads;
  readonly windowSeconds: number;
  readonly now?: () => Date;
};

/** Reads the request body into a typed request, naming the first field that cannot hold. */
export function readConnectRequest(body: unknown): ConnectRequest {
  const object = asObject(body);
  const mandate = address(object, 'mandate');
  const owner = address(object, 'owner');
  const chainId = object['chainId'];
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) throw new ProofError('bad_request', 'chainId is a positive integer.', 400);
  const nonce = object['nonce'];
  if (typeof nonce !== 'string' || !/^0x[0-9a-f]{32}$/u.test(nonce)) throw new ProofError('bad_request', 'nonce is sixteen bytes of lowercase hex.', 400);
  const issuedAt = object['issuedAt'];
  if (typeof issuedAt !== 'string' || Number.isNaN(Date.parse(issuedAt))) throw new ProofError('bad_request', 'issuedAt is an ISO 8601 instant.', 400);
  const signature = object['signature'];
  if (typeof signature !== 'string' || !isHex(signature) || signature.length < 132) throw new ProofError('bad_request', 'signature is the hex of a signed message.', 400);
  const label = object['label'];
  if (label !== undefined && typeof label !== 'string') throw new ProofError('bad_request', 'label is text.', 400);
  let checked: string | undefined;
  try {
    checked = label === undefined ? undefined : checkAssistantLabel(label);
  } catch (error) {
    throw new ProofError('bad_request', error instanceof Error ? error.message : 'label is one line of text.', 400);
  }
  return { mandate, owner, chainId, nonce: nonce as Hex, issuedAt, signature: signature as Hex, ...(checked === undefined ? {} : { label: checked }) };
}

export function readDisconnectRequest(body: unknown): DisconnectRequest {
  const request = readConnectRequest(body);
  const connection = asObject(body)['connection'];
  if (typeof connection !== 'string' || !/^[0-9a-f-]{36}$/u.test(connection)) throw new ProofError('bad_request', 'connection is the id the host gave it.', 400);
  return { ...request, connection };
}

export async function verifyProof(
  request: ConnectRequest | DisconnectRequest,
  options: ProofOptions,
): Promise<{ readonly principal: Address }> {
  if (request.chainId !== options.chainId) {
    throw new ProofError('wrong_chain', `This host serves chain ${options.chainId}, and the message names chain ${request.chainId}.`, 400);
  }

  const now = (options.now ?? (() => new Date()))();
  const issued = new Date(request.issuedAt);
  const age = (now.getTime() - issued.getTime()) / 1_000;
  if (age > options.windowSeconds) {
    throw new ProofError('proof_expired', `The signature is older than ${options.windowSeconds} seconds. Sign a fresh message.`);
  }
  if (age < -120) throw new ProofError('proof_expired', 'The signature is dated in the future. Check the clock and sign again.');

  const fields = { mandate: request.mandate, owner: request.owner, chainId: request.chainId, nonce: request.nonce, issuedAt: request.issuedAt, ...(request.label === undefined ? {} : { label: request.label }) };
  const message = 'connection' in request ? assistantDisconnectMessage({ ...fields, connection: request.connection }) : assistantConnectMessage(fields);

  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message, signature: request.signature });
  } catch {
    throw new ProofError('bad_signature', 'The signature does not read as a signed message.');
  }
  if (signer.toLowerCase() !== request.owner.toLowerCase()) {
    throw new ProofError('bad_signature', 'The signature was not made by the owner the message names.');
  }

  const principal = await options.reads.principalOf(request.mandate);
  if (principal === null) {
    throw new ProofError('no_mandate_account', `${getAddress(request.mandate)} does not answer as a mandate account on chain ${options.chainId}.`, 400);
  }
  if (principal.toLowerCase() !== signer.toLowerCase()) {
    throw new ProofError('not_owner', `The mandate is owned by ${principal}, and the message was signed by ${signer}.`, 403);
  }

  return { principal };
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ProofError('bad_request', 'The body is a JSON object.', 400);
  return body as Record<string, unknown>;
}

function address(object: Record<string, unknown>, field: string): Address {
  const value = object[field];
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) throw new ProofError('bad_request', `${field} is a 0x address.`, 400);
  return getAddress(value);
}
