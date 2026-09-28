import { defineChain, domainSeparator } from 'viem';
import type { Chain } from 'viem';
import { BursarError } from './errors.js';

/**
 * Robinhood Chain constants.
 *
 * Chain 4663 is an Arbitrum Nitro Orbit network. Gas is ETH and settlement is USDG, which are two
 * different assets held at two different addresses; nothing on this chain shows one balance twice.
 * Every value below was read back from 4663 on 2026-09-21 and 2026-09-22 and each carries the
 * call that produced it. Every field can be overridden from the environment, so a deployment that
 * has to move to a different RPC or explorer does not need a release to do it.
 *
 * Only mainnet settles. Chain 46630 runs, and Permit2 and Multicall3 are deployed there, but the
 * USDG address holds no code, so there is no settlement asset to sign for. Tests run against a
 * local fork of 4663 instead, which is `RHC_MAINNET` with `RHC_MAINNET_RPC_URL` pointed at the
 * fork.
 */
export type RhcNetwork = 'mainnet' | 'testnet';

export type RhcChain = {
  readonly name: string;
  readonly network: RhcNetwork;
  readonly chainId: number;
  readonly rpcUrl: string;
  /**
   * Where a person is sent to look at a transaction. The host answers a Cloudflare JS challenge,
   * so this is a link target and never a fetch target. Code that needs index data reads it through
   * `createIndexClient` in explorer.ts, which talks to a different host behind a key.
   */
  readonly explorer: string;
  /** The settlement asset. A six-decimal ERC-20, and the only asset BURSAR accounts in. */
  readonly usdg: `0x${string}`;
  readonly usdgDecimals: 6;
  readonly permit2: `0x${string}`;
  readonly multicall3: `0x${string}`;
  /**
   * Floor the chain enforces on maxFeePerGas, in wei of ETH. Read from the Nitro gas precompile
   * with `ArbGasInfo.getMinimumGasPrice()`: 20,000,000 wei, or 0.02 gwei. Observed base fee on the
   * same day was 0.0527 gwei, so a transaction priced at the floor alone will not be included.
   */
  readonly minFeeCap: bigint;
};

export const RHC_MAINNET: RhcChain = Object.freeze({
  name: 'Robinhood Chain',
  network: 'mainnet',
  chainId: 4663,
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  usdgDecimals: 6,
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  minFeeCap: 20_000_000n,
});

/**
 * What is known about chain 46630, which is deliberately not an `RhcChain`.
 *
 * `usdg` is null because the address USDG occupies on mainnet holds no code here, and a chain with
 * no settlement asset cannot be handed to anything that prices, signs for or escrows a payment.
 * The type carries that fact rather than a comment, so the compiler stops a caller before the
 * error below has to.
 */
export type RhcTestnet = {
  readonly name: string;
  readonly network: 'testnet';
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly permit2: `0x${string}`;
  readonly multicall3: `0x${string}`;
  readonly minFeeCap: bigint;
  /** No settlement asset is deployed on 46630. `eth_getCode` at the mainnet USDG address is `0x`. */
  readonly usdg: null;
};

export const RHC_TESTNET: RhcTestnet = Object.freeze({
  name: 'Robinhood Chain Testnet',
  network: 'testnet',
  chainId: 46630,
  rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  minFeeCap: 10_000_000n,
  usdg: null,
});

/**
 * Raised the moment a caller selects testnet.
 *
 * Chain 46630 is up, funded from a faucet and will take a deploy. What it will not do is settle:
 * `0x5fc5…d168` holds no code there, so a deployment pointed at it comes up healthy, passes its
 * readiness checks and refuses every payment at the last step, in a place where the message reads
 * like a signature problem. Refusing at configuration is the only cheap place to catch it.
 */
export class TestnetHasNoSettlementAsset extends BursarError {
  constructor(context = 'This deployment') {
    super(
      'rhc_testnet_no_settlement_asset',
      `${context} selected Robinhood Chain testnet (${RHC_TESTNET.chainId}). USDG is not deployed ` +
        `there: ${RHC_MAINNET.usdg} holds no code on ${RHC_TESTNET.chainId}, so nothing on that ` +
        `network can be settled, escrowed or signed for. BURSAR settles on chain ` +
        `${RHC_MAINNET.chainId} only. Tests run against a local fork of ${RHC_MAINNET.chainId}: ` +
        `leave the network at mainnet and point RHC_MAINNET_RPC_URL at the fork.`,
      { testnetChainId: RHC_TESTNET.chainId, mainnetChainId: RHC_MAINNET.chainId, usdg: RHC_MAINNET.usdg },
    );
  }
}

/**
 * Runtime bytecode hashes read from 4663 on 2026-09-22. Check them again before routing value
 * through either address: an address holding code is not the same claim as an address holding the
 * code you expect.
 *
 * Multicall3 is byte-identical to the deployment on every other chain this project has measured.
 * Permit2 is not, and cannot be: it caches the chain id in an immutable, so its runtime bytecode
 * differs per chain by construction.
 */
export const RHC_MAINNET_INFRA_HASHES = Object.freeze({
  permit2: '0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca',
  multicall3: '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891',
} as const);

/**
 * Hash of the 170 bytes of runtime code at the USDG address on 4663, read 2026-09-22.
 *
 * USDG is a diamond proxy, so this hashes the dispatcher and nothing else. It answers "is this
 * still the contract we probed", not "does it still behave the way we probed": facets are added
 * and replaced behind a dispatcher without touching it.
 */
export const RHC_MAINNET_USDG_CODE_HASH =
  '0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6' as const;

export type Eip712Domain = {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: `0x${string}`;
};

/**
 * USDG's EIP-712 version, pinned rather than read.
 *
 * `version()` on USDG reverts with `FacetNotFound` (`0x800ab12c`), and so do `eip712Domain()` and
 * `isBlacklisted(address)`: the diamond routes only the selectors its facets declare. Code that
 * asks the token for its domain the way it could on a plain USDC deployment gets a revert with
 * nothing in it to explain why. The version is "1", confirmed by computing the separator below
 * and matching it against what `DOMAIN_SEPARATOR()` returns.
 */
export const USDG_DOMAIN_VERSION = '1' as const;
export const USDG_DOMAIN_NAME = 'Global Dollar' as const;

/**
 * `version()` on its own, for the one call that is allowed to ask.
 *
 * It is deliberately not part of the settlement-asset ABI. That ABI describes what USDG answers,
 * and a caller holding it should have no way to reach a selector that reverts with nothing in it.
 * A token that is not USDG may still publish a version, and a domain assembled from a published
 * version is one fewer thing taken on trust, so the probe stays available and stays separate. Any
 * caller using it must tolerate the revert and must check the assembled domain against the
 * token's own `DOMAIN_SEPARATOR()` before signing anything with it.
 */
export const tokenVersionAbi = [
  {
    type: 'function',
    name: 'version',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
] as const;

/** keccak of the EIP-712 domain struct, the value a token exposes as `DOMAIN_SEPARATOR()`. */
export function eip712DomainSeparator(domain: Eip712Domain): `0x${string}` {
  return domainSeparator({
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
  });
}

/**
 * The domain to sign EIP-3009 authorisations against on 4663. A guessed domain produces a
 * signature that fails verification with nothing to point at, the most expensive mistake on
 * this path.
 */
export const RHC_MAINNET_USDG_DOMAIN: Eip712Domain = Object.freeze({
  name: USDG_DOMAIN_NAME,
  version: USDG_DOMAIN_VERSION,
  chainId: RHC_MAINNET.chainId,
  verifyingContract: RHC_MAINNET.usdg,
});

/** What `DOMAIN_SEPARATOR()` returned from USDG on 4663, read 2026-09-22. */
const USDG_DOMAIN_SEPARATOR_READ_FROM_CHAIN =
  '0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036' as const;

/**
 * The pinned separator, checked against the domain it claims to describe before anything can use
 * it. Both sides are constants, so this can only fail if someone edits the address, the chain id
 * or the version and leaves the other side alone. When that happens the package refuses to load
 * rather than letting every signature fail verification on chain, one at a time.
 */
export const RHC_MAINNET_USDG_DOMAIN_SEPARATOR: `0x${string}` = (() => {
  const computed = eip712DomainSeparator(RHC_MAINNET_USDG_DOMAIN);
  if (computed !== USDG_DOMAIN_SEPARATOR_READ_FROM_CHAIN) {
    throw new BursarError(
      'rhc_usdg_domain_mismatch',
      `The pinned USDG domain does not produce the separator read from chain ${RHC_MAINNET.chainId}. ` +
        `Computed ${computed}, expected ${USDG_DOMAIN_SEPARATOR_READ_FROM_CHAIN}. One of the token ` +
        `address, the chain id, the name "${USDG_DOMAIN_NAME}" or the version ` +
        `"${USDG_DOMAIN_VERSION}" has changed without the other being re-read from the chain.`,
      { computed, expected: USDG_DOMAIN_SEPARATOR_READ_FROM_CHAIN },
    );
  }
  return computed;
})();

export type Caip2 = `eip155:${number}`;

/** CAIP-2 identifier, which is how a self-hosted x402 facilitator addresses a network. */
export function caip2(chainId: number): Caip2 {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new BursarError('caip2_invalid', `Chain id must be a positive integer, got ${chainId}.`, {
      chainId,
    });
  }
  return `eip155:${chainId}`;
}

export function parseCaip2(id: string): { namespace: 'eip155'; chainId: number } {
  const match = /^eip155:(\d+)$/.exec(id.trim());
  if (!match) {
    throw new BursarError(
      'caip2_invalid',
      `"${id}" is not an eip155 CAIP-2 identifier. BURSAR settles on EVM chains only.`,
      { id },
    );
  }
  // A reference too long for a safe integer would round to some other chain's id.
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new BursarError('caip2_invalid', `"${id}" does not name a chain id this system can represent.`, {
      id,
    });
  }
  return { namespace: 'eip155', chainId };
}

export function isCaip2(id: string): id is Caip2 {
  const match = /^eip155:(\d+)$/.exec(id.trim());
  if (match === null) return false;
  // Agrees with parseCaip2, so a string that passes here never throws there.
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) && chainId > 0;
}

/**
 * A network string with its packaging removed: trimmed and lowercased, and nothing else.
 *
 * Identity is never rewritten here. The x402 protocol's first version predates CAIP-2 and named a
 * handful of chains in words, and an alias table that turns one of those words into a chain id is
 * a guess nothing in this system is in a position to make: Robinhood Chain has no such name, so
 * the table would only ever answer questions about chains BURSAR does not settle on.
 */
export function canonicalNetwork(network: unknown): string {
  return String(network ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Whether two spellings name the same chain.
 *
 * `eip155:4663` and `eip155:04663` are one chain, so two CAIP-2 strings are compared by the id
 * they parse to rather than by their characters. Anything else is an exact match on the normalized
 * form, and an empty network matches nothing at all: a party that named no chain has made no claim
 * about one, and reading that absence as agreement would settle a payment on an unstated network.
 *
 * The client asking whether an offer is on its chain and the facilitator deciding whether to
 * settle it have to reach the same answer, so both read it from here.
 */
export function sameNetwork(a: unknown, b: unknown): boolean {
  const left = canonicalNetwork(a);
  const right = canonicalNetwork(b);

  if (isCaip2(left) && isCaip2(right)) return parseCaip2(left).chainId === parseCaip2(right).chainId;

  return left === right && left.length > 0;
}

/** The chain id a network string names, or null when it is not CAIP-2. */
export function networkChainId(network: unknown): number | null {
  const value = canonicalNetwork(network);
  return isCaip2(value) ? parseCaip2(value).chainId : null;
}

type RhcEnvNames = {
  readonly chainId: string;
  readonly rpcUrl: string;
  readonly explorer: string;
  readonly usdg: string;
  readonly permit2: string;
  readonly multicall3: string;
  readonly minFeeCap: string;
};

/**
 * Per-field overrides on the recorded mainnet values. Unset is the normal case.
 *
 * Only mainnet is named. Testnet has no settlement asset, so there is no deployment to configure
 * there and an override set would be a way of pretending otherwise. A fork of 4663 is configured
 * through these same variables, because a fork is mainnet at a different URL.
 */
const MAINNET_ENV: RhcEnvNames = {
  chainId: 'RHC_MAINNET_CHAIN_ID',
  rpcUrl: 'RHC_MAINNET_RPC_URL',
  explorer: 'RHC_MAINNET_EXPLORER',
  usdg: 'RHC_MAINNET_USDG',
  permit2: 'RHC_MAINNET_PERMIT2',
  multicall3: 'RHC_MAINNET_MULTICALL3',
  minFeeCap: 'RHC_MAINNET_MIN_FEE_CAP',
};

export const RHC_ENV: Readonly<Record<'mainnet', RhcEnvNames>> = Object.freeze({
  mainnet: Object.freeze(MAINNET_ENV),
});

/** The date the recorded values were last read back from the chain, quoted by the error below. */
const READ_ON = '2026-09-22';

/**
 * An override that is present but empty. Leaving a variable unset takes the verified value;
 * setting it to nothing is a shell interpolation that came back blank, and deploying on the
 * default it was meant to replace is worse than stopping.
 */
export class MissingRhcConfig extends BursarError {
  readonly network: 'mainnet';

  constructor(variable: string) {
    const overrides = Object.values(MAINNET_ENV);
    super(
      'rhc_unconfigured',
      `${variable} is set to an empty value. Robinhood Chain parameters default to what was read ` +
        `from chain ${RHC_MAINNET.chainId} on ${READ_ON}, so leave the variable unset to take that ` +
        `or give it a value. Overrides: ${overrides.join(', ')}.`,
      { variable, network: 'mainnet', overrides },
    );
    this.network = 'mainnet';
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;

function override(source: EnvSource, variable: string): string | undefined {
  const value = source[variable];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') throw new MissingRhcConfig(variable);
  return trimmed;
}

function addressOverride(
  source: EnvSource,
  variable: string,
  verified: `0x${string}`,
): `0x${string}` {
  const value = override(source, variable);
  if (value === undefined) return verified;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new BursarError('rhc_config_invalid', `${variable} is not a 20-byte hex address: ${value}`, {
      variable,
      network: 'mainnet',
      value,
    });
  }
  return value as `0x${string}`;
}

/**
 * A URL override, parsed rather than trusted. A typo such as a missing scheme would otherwise
 * surface as a fetch error on the first request instead of at startup, and a `file:` or `javascript:`
 * value has no business being dialled or linked to.
 */
function urlOverride(source: EnvSource, variable: string, verified: string): string {
  const value = override(source, variable);
  if (value === undefined) return verified;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // The value is not echoed: an RPC URL often carries a provider key in its path.
    throw new BursarError('rhc_config_invalid', `${variable} is not a URL.`, { variable, network: 'mainnet' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BursarError('rhc_config_invalid', `${variable} must be an http or https URL.`, {
      variable,
      network: 'mainnet',
      protocol: parsed.protocol,
    });
  }
  return value;
}

/**
 * Resolved on every call, so an override set after import still counts. Defaults are the recorded
 * values, which is what the chain answered when it was read; the environment only has to name
 * what a particular deployment moves.
 */
function resolve(recorded: RhcChain, source: EnvSource): RhcChain {
  const names = MAINNET_ENV;

  // Nothing named, nothing to resolve. Handing back the recorded object keeps one identity per
  // network for callers that compare chains rather than chain ids.
  if (!Object.values(names).some((variable) => source[variable] !== undefined)) return recorded;

  const declaredChainId = override(source, names.chainId);
  // Digits only: Number() would read "0x1237", "4663.0" and "4.663e3" as chain ids.
  const chainId =
    declaredChainId === undefined ? recorded.chainId : /^\d+$/.test(declaredChainId) ? Number(declaredChainId) : NaN;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new BursarError(
      'rhc_config_invalid',
      `${names.chainId} is not a positive integer chain id: ${String(declaredChainId)}`,
      { variable: names.chainId, network: 'mainnet', value: declaredChainId },
    );
  }

  const declaredFeeCap = override(source, names.minFeeCap);
  if (declaredFeeCap !== undefined && !/^\d+$/.test(declaredFeeCap)) {
    throw new BursarError(
      'rhc_config_invalid',
      `${names.minFeeCap} is not a whole number of wei: ${declaredFeeCap}`,
      { variable: names.minFeeCap, network: 'mainnet', value: declaredFeeCap },
    );
  }

  return Object.freeze({
    name: recorded.name,
    network: recorded.network,
    chainId,
    rpcUrl: urlOverride(source, names.rpcUrl, recorded.rpcUrl),
    explorer: urlOverride(source, names.explorer, recorded.explorer),
    usdg: addressOverride(source, names.usdg, recorded.usdg),
    usdgDecimals: 6,
    permit2: addressOverride(source, names.permit2, recorded.permit2),
    multicall3: addressOverride(source, names.multicall3, recorded.multicall3),
    minFeeCap: declaredFeeCap === undefined ? recorded.minFeeCap : BigInt(declaredFeeCap),
  });
}

export function rhcMainnet(source: EnvSource = process.env): RhcChain {
  return resolve(RHC_MAINNET, source);
}

/**
 * Always throws. It exists because callers select a network by name and one of the names has to
 * say no out loud, with the reason, instead of handing back a chain record with a hole in it.
 */
export function rhcTestnet(): never {
  throw new TestnetHasNoSettlementAsset();
}

/** Mainnet is the default because it is the only network that can settle. */
export function rhcChain(network: RhcNetwork = 'mainnet', source: EnvSource = process.env): RhcChain {
  if (network === 'testnet') rhcTestnet();
  return rhcMainnet(source);
}

/**
 * viem's chain descriptor. `nativeCurrency` is ETH at eighteen decimals because that is the gas
 * asset and that is how the node reports it. Ledger amounts are six-decimal micro-USD of USDG and
 * never pass through this field.
 */
export function viemChain(chain: RhcChain): Chain {
  return defineChain({
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [chain.rpcUrl] } },
    blockExplorers: { default: { name: 'Blockscout', url: chain.explorer } },
    contracts: { multicall3: { address: chain.multicall3 } },
    testnet: chain.network === 'testnet',
  });
}

/**
 * The domain to sign EIP-3009 authorisations against, for whichever chain record is in play.
 *
 * Name and version are pinned, never read from the token. USDG is a diamond and does not route
 * `version()`; asking it reverts. Verify the result against the token's own `DOMAIN_SEPARATOR()`
 * once per chain, which for 4663 is already done at import in this module.
 */
export function usdgDomain(chain: RhcChain): Eip712Domain {
  return Object.freeze({
    name: USDG_DOMAIN_NAME,
    version: USDG_DOMAIN_VERSION,
    chainId: chain.chainId,
    verifyingContract: chain.usdg,
  });
}
