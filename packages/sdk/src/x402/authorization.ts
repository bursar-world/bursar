import { domainSeparator } from 'viem';
import type { Address, Hex, TypedDataDomain } from 'viem';
import { BursarError, settlementAssetAbi, tokenVersionAbi } from '@bursar/core';
import type { Micro } from '@bursar/core';

import { requireSigner, type Connection } from '../connection.js';
import { checkAddress, checkAmount, checkBytes32, toSeconds } from '../guards.js';
import { random32 } from '../random.js';
import { contractSaidNo } from '../revert.js';

/** EIP-3009. The field order is part of the type hash, so it is not a matter of taste. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export type TransferAuthorization = {
  readonly from: Address;
  readonly to: Address;
  readonly value: Micro;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  /** Single use, enforced by the token. This is what makes a signed payment unreplayable. */
  readonly nonce: Hex;
};

const domains = new Map<string, TypedDataDomain>();

/**
 * The EIP-712 version to assemble a domain with when the token publishes none.
 *
 * USDG is a diamond proxy: `version()` has no facet behind it and reverts with `FacetNotFound`,
 * while `name` and `DOMAIN_SEPARATOR` answer normally. One is what its separator reproduces, and
 * the check below is what makes using it safe rather than a guess.
 */
const UNPUBLISHED_VERSION = '1';

/**
 * The token's own EIP-712 domain, read from the token.
 *
 * A guessed domain does not fail loudly. It produces a well-formed signature that recovers to
 * nobody, and the facilitator reports an invalid signature while the real fault is two fields in
 * the domain. Reading the token and then checking the assembled domain against
 * `DOMAIN_SEPARATOR()` costs three calls once per asset and removes the entire class, including
 * the case where the version did not come from the token at all.
 */
export async function assetDomain(
  connection: Connection,
  asset: Address,
  options: { version?: string } = {},
): Promise<TypedDataDomain> {
  const address = checkAddress('asset', asset);
  const key = `${connection.chain.chainId}:${address.toLowerCase()}`;
  const cached = domains.get(key);
  if (cached) return cached;

  const client = connection.publicClient;
  const [name, published, separator] = await Promise.all([
    client.readContract({ address, abi: settlementAssetAbi, functionName: 'name' }),
    // Only the token declining to answer means "no published version". A node that timed out has
    // said nothing about the token, and reading it as a missing version would end in a domain
    // mismatch that blames the token for a network fault.
    client
      .readContract({ address, abi: tokenVersionAbi, functionName: 'version' })
      .catch((error: unknown) => {
        if (contractSaidNo(error)) return undefined;
        throw error;
      }),
    client.readContract({ address, abi: settlementAssetAbi, functionName: 'DOMAIN_SEPARATOR' }),
  ]);

  const version = published ?? options.version ?? UNPUBLISHED_VERSION;
  const domain: TypedDataDomain = {
    name,
    version,
    chainId: connection.chain.chainId,
    verifyingContract: address,
  };

  if (domainSeparator({ domain }).toLowerCase() !== separator.toLowerCase()) {
    const source =
      published === undefined
        ? 'publishes no version, so version ' +
          `${JSON.stringify(version)} was supplied for it`
        : `reports version ${JSON.stringify(version)}`;

    throw new BursarError(
      'domain_mismatch',
      `Token ${asset} reports name ${JSON.stringify(name)} and ${source}, but its ` +
        'DOMAIN_SEPARATOR is not the one those produce. A payment signed against this domain ' +
        'would be rejected as an invalid signature, so nothing is signed.',
      {
        asset,
        name,
        version,
        versionPublished: published !== undefined,
        chainId: connection.chain.chainId,
        separator,
      },
    );
  }

  domains.set(key, domain);

  return domain;
}

/**
 * Signs a transfer the facilitator broadcasts on the payer's behalf.
 *
 * The payer needs no gas and sends no transaction: the token checks the signature and the nonce
 * when the facilitator submits it. Until then this is a promise to pay that costs nothing to make
 * and nothing to abandon.
 */
export async function signTransferAuthorization(
  connection: Connection,
  asset: Address,
  authorization: TransferAuthorization,
): Promise<Hex> {
  const { walletClient, account } = requireSigner(connection, 'x402 payment');
  const domain = await assetDomain(connection, asset);

  return walletClient.signTypedData({
    account,
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    },
  });
}

/**
 * Headroom between when a payment is signed and when a facilitator judges it.
 *
 * `maxTimeoutSeconds` is the server's budget for doing the work, and a facilitator refuses any
 * authorization that does not outlive that budget measured from the moment it checks. Signing for
 * exactly the budget therefore expires in transit: the request has to reach the resource server
 * and the resource server has to reach the facilitator, and every second of that is subtracted.
 * Thirty covers a slow round trip and a modest clock difference between the two machines.
 */
export const AUTHORIZATION_MARGIN_SECONDS = 30;

/**
 * An authorization valid from a minute ago until `seconds` from now.
 *
 * The backdated start absorbs the clock difference between this process and the chain, which
 * would otherwise reject a payment signed a moment before the block it lands in.
 */
export function authorizationFor(input: {
  from: Address;
  to: Address;
  value: Micro;
  seconds: number;
  now?: number;
  /**
   * Derive it from the request digest to bind this payment to one request. A random nonce is
   * unreplayable but redeemable against anything, which is a bearer token with the payer's
   * money behind it.
   */
  nonce?: Hex;
}): TransferAuthorization {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  // Added as numbers, so a string here concatenates instead of adding and signs an authorization
  // good for the next five centuries. The window is the only thing bounding a signature the payer
  // has already handed out.
  const seconds = Number(toSeconds('seconds', input.seconds));

  return {
    from: checkAddress('from', input.from),
    to: checkAddress('to', input.to),
    value: checkAmount('value', input.value),
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + seconds),
    nonce: input.nonce === undefined ? random32() : checkBytes32('nonce', input.nonce),
  };
}

/** Atomic units cross the wire as decimal strings. JSON numbers do not hold a uint256. */
export function encodeAuthorization(
  authorization: TransferAuthorization,
): Record<string, string> {
  return {
    from: authorization.from,
    to: authorization.to,
    value: authorization.value.toString(),
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
    nonce: authorization.nonce,
  };
}
