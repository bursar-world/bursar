import { getAddress, hashDomain } from 'viem';
import { MICRO_DECIMALS } from '@bursar/core';
import { DomainMismatchError, X402ConfigError } from './errors.js';
import { isRevert } from './issuer.js';
import type { Eip712DomainFields, PaymentChain, TypedDataField } from './ports.js';
import { TRANSFER_METHODS, type TransferMethod } from './types.js';

/**
 * The EIP-712 domain, read from the token.
 *
 * This is the expensive detail. A domain that differs from the token's by one character still
 * produces a well-formed signature, one that recovers to an address nobody holds, and every
 * payment is refused as a bad signature (see `DomainMismatchError`). USDG on Robinhood
 * Chain reports name "Global Dollar" and publishes no version, and the domain assembled with
 * version "1" hashes to the separator the token itself reports. The published x402 examples carry
 * a different token's name.
 *
 * `resolveAsset` is therefore the only supported way to build an `AssetMeta` for production. It
 * asks the token for its name, version and decimals, recomputes the separator locally, and throws
 * if the two disagree. That check is what makes a supplied version safe: it is proved against the
 * token before anything is signed, never trusted because it was configured.
 */
const DOMAIN_WITH_VERSION = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const;

const DOMAIN_WITHOUT_VERSION = [
  { name: 'name', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const;

/** The EIP712Domain field list for a domain, which depends on which fields it actually carries. */
export function domainFields(domain: Eip712DomainFields): readonly TypedDataField[] {
  return domain.version === undefined ? DOMAIN_WITHOUT_VERSION : DOMAIN_WITH_VERSION;
}

/** keccak256 of the encoded domain: the value a token exposes as DOMAIN_SEPARATOR. */
export function computeDomainSeparator(domain: Eip712DomainFields): `0x${string}` {
  const common = {
    name: domain.name,
    chainId: BigInt(domain.chainId),
    verifyingContract: domain.verifyingContract,
  };
  return domain.version === undefined
    ? hashDomain({ domain: common, types: { EIP712Domain: DOMAIN_WITHOUT_VERSION } })
    : hashDomain({
        domain: { ...common, version: domain.version },
        types: { EIP712Domain: DOMAIN_WITH_VERSION },
      });
}

export type AssetMeta = {
  readonly address: `0x${string}`;
  /** EIP-712 domain name as the token reports it. */
  readonly name: string;
  readonly version: string;
  /** Six, always. Anything else is a different asset and the ledger cannot hold it. */
  readonly decimals: typeof MICRO_DECIMALS;
  /** As read from the token, and cross-checked against the locally computed value. */
  readonly domainSeparator: `0x${string}`;
  readonly methods: readonly TransferMethod[];
};

export function assetDomain(asset: AssetMeta, chainId: number): Eip712DomainFields {
  return {
    name: asset.name,
    version: asset.version,
    chainId,
    verifyingContract: asset.address,
  };
}

/**
 * Checks an asset that was built by hand rather than read from the chain.
 *
 * It catches a typo, not a lie: a separator computed from the same wrong name still agrees with
 * itself. Use `resolveAsset` for anything that will move money.
 */
export function assertAssetConsistent(asset: AssetMeta, chainId: number): AssetMeta {
  if (asset.decimals !== MICRO_DECIMALS) {
    throw new X402ConfigError(
      'x402_asset_decimals',
      `settlement asset ${asset.address} reports ${asset.decimals} decimals, expected ${MICRO_DECIMALS}`,
      { asset: asset.address, decimals: asset.decimals },
    );
  }
  if (asset.methods.length === 0) {
    throw new X402ConfigError(
      'x402_asset_no_methods',
      `settlement asset ${asset.address} supports no authorisation path`,
      { asset: asset.address },
    );
  }
  for (const method of asset.methods) {
    if (!TRANSFER_METHODS.includes(method)) {
      throw new X402ConfigError('x402_asset_method', `unknown transfer method ${method}`, {
        asset: asset.address,
        method,
      });
    }
  }
  const computed = computeDomainSeparator(assetDomain(asset, chainId));
  if (computed.toLowerCase() !== asset.domainSeparator.toLowerCase()) {
    throw new DomainMismatchError(asset.address, computed, asset.domainSeparator);
  }
  return asset;
}

export type ResolveAssetOptions = {
  /**
   * Where Permit2 lives on this chain. Given one, `resolveAsset` reports the permit2 path only if
   * the address holds code. The canonical deployment holds code on Robinhood Chain, checked
   * 2026-09-22.
   */
  readonly permit2?: `0x${string}`;
  /**
   * The EIP-712 version to assemble the domain with when the token does not publish one.
   *
   * Set it only for a token whose `version()` does not answer. The assembled domain is hashed and
   * compared against the token's own `DOMAIN_SEPARATOR` before this function returns, and a
   * version that does not reproduce it is refused.
   */
  readonly version?: string;
};

/**
 * What a domain is assembled with when the token publishes no version.
 *
 * One is what the great majority of EIP-712 contracts carry, and it is what USDG's separator on
 * Robinhood Chain reproduces. Nothing is signed against it until the separator agrees.
 */
const UNPUBLISHED_VERSION = '1';

/**
 * Ask the token what it is, then confirm the answer hashes to the separator it publishes.
 *
 * The supported authorisation paths are probed rather than assumed, so a token that implements
 * part of the interface degrades to the paths it really has instead of failing at settlement
 * time. USDG answers `authorizationState` and `nonces`. What is probed here is the signing
 * surface and nothing else: the token's issuer controls are `paused()` and `isFrozen(address)`,
 * they are read nowhere on this path, and a resolved asset is not a statement that a given payer
 * may move it.
 */
export async function resolveAsset(
  chain: PaymentChain,
  configured: `0x${string}`,
  options: ResolveAssetOptions = {},
): Promise<AssetMeta> {
  // Checksummed before anything else, because the resolved address becomes a map key that payer
  // addresses, already checksummed on the way in, are looked up against.
  let token: `0x${string}`;
  try {
    token = getAddress(configured);
  } catch {
    throw new X402ConfigError('x402_address_invalid', `settlement asset ${configured} is not an address`, {
      asset: configured,
    });
  }
  const identity = await chain.tokenIdentity(token);
  if (identity.decimals !== MICRO_DECIMALS) {
    throw new X402ConfigError(
      'x402_asset_decimals',
      `settlement asset ${token} reports ${identity.decimals} decimals, expected ${MICRO_DECIMALS}`,
      { asset: token, decimals: identity.decimals },
    );
  }

  const version = identity.version ?? options.version ?? UNPUBLISHED_VERSION;
  const domain: Eip712DomainFields = {
    name: identity.name,
    version,
    chainId: chain.chainId,
    verifyingContract: token,
  };
  const computed = computeDomainSeparator(domain);
  if (computed.toLowerCase() !== identity.domainSeparator.toLowerCase()) {
    throw new DomainMismatchError(token, computed, identity.domainSeparator, {
      name: identity.name,
      version,
      versionPublished: identity.version !== undefined,
    });
  }

  const methods = await probeMethods(chain, token, options.permit2);
  if (methods.length === 0) {
    throw new X402ConfigError(
      'x402_asset_no_methods',
      `settlement asset ${token} implements no authorisation path this scheme can use`,
      { asset: token },
    );
  }

  return Object.freeze({
    address: token,
    name: identity.name,
    version,
    decimals: MICRO_DECIMALS,
    domainSeparator: identity.domainSeparator,
    methods: Object.freeze(methods),
  });
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const ZERO_NONCE = `0x${'00'.repeat(32)}` as const;

async function probeMethods(
  chain: PaymentChain,
  token: `0x${string}`,
  permit2: `0x${string}` | undefined,
): Promise<TransferMethod[]> {
  const found: TransferMethod[] = [];

  // A view call against the zero address returns for any token that implements the interface and
  // reverts for one that does not, so the test is whether the call answered at all. The returned
  // value carries no signal: an unspent nonce is legitimately `false` and a fresh account's permit
  // nonce is legitimately zero. The ABI says what a contract could have, not what it does.
  if (await answered(() => chain.authorizationState(token, ZERO_ADDRESS, ZERO_NONCE))) {
    found.push('eip3009');
  }
  if (await answered(() => chain.permitNonce(token, ZERO_ADDRESS))) {
    found.push('eip2612');
  }
  if (permit2 !== undefined) {
    // No revert is possible on eth_getCode, so any failure is the chain not answering, and a path
    // dropped for that reason would stay dropped until the next restart.
    if (await chain.hasCode(permit2)) found.push('permit2');
  }
  return found;
}

async function answered(read: () => Promise<unknown>): Promise<boolean> {
  try {
    await read();
    return true;
  } catch (error) {
    // Only the contract refusing the call says the interface is missing. A timeout says nothing
    // about the token, and failing startup is better than serving without EIP-3009 until restart.
    if (isRevert(error)) return false;
    throw error;
  }
}
