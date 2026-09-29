import {
  EnvError,
  rhcChain,
  rhcRpcProviders,
  deploymentForChain,
  envVar,
  isBursarError,
  loadEnv,
  optional,
  withDefault,
} from '@bursar/core';
import type { RhcChain, EnvProblem, EnvSource, Micro, RpcProvider } from '@bursar/core';
import type { Address, Hex } from 'viem';

import { normalizeHost } from './executor.js';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * One escrow this payee answers, with the directory its outputs and cursor live in. A lock id is
 * unique only within one escrow, so every escrow keeps its own of both.
 */
export type EscrowWatch = {
  readonly escrow: Address;
  readonly outputScope: string;
  readonly statePath: string;
};

export type SidecarConfig = {
  readonly chain: RhcChain;
  readonly providers: readonly RpcProvider[];
  /**
   * Every escrow this payee answers, in the order configured. One watcher runs per escrow, all
   * signing from the one payee key through one nonce manager.
   */
  readonly escrows: readonly EscrowWatch[];
  /** The first of `escrows`. Its scope and cursor are `outputScope` and `statePath` below. */
  readonly escrow: Address;
  readonly apiBase: string;
  readonly capabilitiesPath: string;
  readonly allowedHosts: ReadonlySet<string>;
  readonly outputDir: string;
  /**
   * `<chainId>-<escrow>`, lowercase. Outputs, and the default cursor, live in a directory of this
   * name under `outputDir`: a lock id is only unique within one escrow on one chain, and an output
   * reused across two of them is a release that commits to somebody else's answer.
   */
  readonly outputScope: string;
  /** Public base for outputs too large to inline. Trailing slash already trimmed. */
  readonly outputBaseUrl: string | undefined;
  readonly statePath: string;
  readonly pollMs: number;
  readonly fetchTimeoutMs: number;
  readonly confirmTimeoutMs: number;
  readonly maxBodyBytes: number;
  readonly maxInlineOutputBytes: number;
  /** Widest span the RPC will accept in one `eth_getLogs`. Lower it for a stricter provider. */
  readonly blockRange: bigint;
  /** Set only to replay. It overrides a stored cursor. */
  readonly startBlock: bigint | undefined;
  readonly finalizeReleases: boolean;
  readonly escalateExpired: boolean;
  readonly escalateMaxBond: Micro | undefined;
  /** Wei of ETH. Gas and settlement are different assets here, so this is not a `Micro`. */
  readonly minGasWei: bigint | undefined;
  readonly gasCheckMs: number;
  /** Where signed delivery evidence goes when a delivered lock is disputed. Unset sends none. */
  readonly evidenceUrl: string | undefined;
};

/**
 * The key is handed back beside the configuration rather than inside it. Nothing that logs, prints
 * or serialises a `SidecarConfig` can reach it, which holds better than remembering to redact a
 * field.
 */
export type LoadedConfig = {
  readonly config: SidecarConfig;
  readonly payeeKey: Hex;
  /**
   * Opens job inputs sealed to this payee's ERC-6538 viewing key. Unset means the key is derived
   * from the payee key's signature over the viewing-key message, which is what a payee that
   * published its meta-address with `scripts/publish-viewing-key.ts` holds.
   */
  readonly viewingKey: Hex | undefined;
};

const SCHEMA = {
  // Mainnet by default because it is the only Robinhood Chain network with a USDG contract.
  // Naming testnet is refused outright, by `rhcChain`, with the reason.
  RHC_NETWORK: withDefault(envVar.oneOf(['testnet', 'mainnet']), 'mainnet'),

  /** The escrow this payee answers. Falls back to the deployment record for the chain. */
  ESCROW_ADDRESS: optional(envVar.address()),

  /**
   * Several escrows, comma separated, for a payee with locks on more than one deployment: the
   * current escrow and a superseded one it still holds locks on. Joined with ESCROW_ADDRESS when
   * both are set, duplicates dropped.
   */
  ESCROW_ADDRESSES: optional(envVar.list()),

  /** The provider's own key. Signs releases, nothing else, and never a payer's authorisation. */
  PAYEE_PRIVATE_KEY: envVar.string({ pattern: HEX32, secret: true }),

  /** The viewing private key sealed job inputs are opened with. Defaults to one derived from the payee key. */
  SIDECAR_VIEWING_KEY: optional(envVar.string({ pattern: HEX32, secret: true })),

  /** Where the capability implementations are served. */
  API_BASE: envVar.url(),
  CAPABILITIES_PATH: withDefault(envVar.string(), 'capabilities.json'),

  /**
   * Hosts an input URI may be fetched from. Nothing is implied, loopback included: the URI is the
   * payer's, and loopback is where this machine keeps what it does not publish.
   */
  ALLOWED_HOSTS: optional(envVar.list()),

  OUTPUT_DIR: withDefault(envVar.string(), './out'),
  OUTPUT_BASE_URL: optional(envVar.url()),
  STATE_PATH: optional(envVar.string()),

  POLL_MS: withDefault(envVar.int({ min: 250, max: 600_000 }), 2_000),
  FETCH_TIMEOUT_MS: withDefault(envVar.int({ min: 100, max: 600_000 }), 10_000),
  CONFIRM_TIMEOUT_MS: withDefault(envVar.int({ min: 1_000, max: 600_000 }), 60_000),
  MAX_BODY_BYTES: withDefault(envVar.int({ min: 1, max: 64 * 1_048_576 }), 1_048_576),

  /**
   * The chain charges 16 gas per non-zero calldata byte, so 4 KB of inline output costs roughly a
   * third of the gas of the lock and release round trip itself. Anything larger is published
   * rather than carried.
   */
  MAX_INLINE_OUTPUT_BYTES: withDefault(envVar.int({ min: 0, max: 131_072 }), 4_096),

  MAX_BLOCK_RANGE: withDefault(envVar.int({ min: 1, max: 100_000 }), 1_000),
  START_BLOCK: optional(envVar.bigint({ min: 0n })),

  /**
   * The reputation counter that raises this payee's cap is written by `finalizeRelease`, not by
   * `release`, whenever a dispute window is open. Turn it off only when something else finalises.
   */
  FINALIZE_RELEASES: withDefault(envVar.boolean(), true),

  /**
   * Whether to contest a lock whose deadline passed with work already delivered. It posts a bond
   * and risks losing it, so it is off until an operator says otherwise.
   */
  ESCALATE_EXPIRED: withDefault(envVar.boolean(), false),
  ESCALATE_MAX_BOND: optional(envVar.micro()),

  /**
   * Warn below this fee budget, in wei of ETH. Unset means no floor, because no default can know
   * the workload.
   *
   * Named in wei rather than in the settlement asset, and renamed from MIN_GAS_BALANCE so that a
   * configuration written for a chain where gas was USDG fails loudly. Read as micro-USD it would
   * have been off by twelve orders of magnitude, which is a floor no balance ever falls below.
   */
  MIN_GAS_WEI: optional(envVar.bigint({ min: 0n })),
  GAS_CHECK_MS: withDefault(envVar.int({ min: 1_000, max: 86_400_000 }), 300_000),

  /**
   * The resolver service's evidence inbox. A payer who disputes before this payee releases leaves
   * no output on chain, and without evidence the resolvers read the job as undelivered.
   */
  SIDECAR_EVIDENCE_URL: optional(envVar.url({ protocols: ['https:', 'http:'], secret: false })),
} as const;

/**
 * Reads the whole environment and reports every problem in one pass, the sidecar's own variables
 * and the shared chain and RPC ones together. An operator setting this service up for the first
 * time fixes one list.
 *
 * Two questions the schema cannot answer on its own are settled here: which escrow this payee
 * answers, and whether the escalation switch was turned on without the ceiling that bounds it.
 */
export function loadConfig(source: EnvSource = process.env): LoadedConfig {
  const problems: EnvProblem[] = [];

  const env = capture(() => loadEnv(SCHEMA, source), problems);
  const providers = capture(() => rhcRpcProviders(source), problems);
  const chain = capture(() => rhcChain(env?.RHC_NETWORK ?? 'mainnet', source), problems);

  const named = namedEscrows(env?.ESCROW_ADDRESS, env?.ESCROW_ADDRESSES, problems);
  const recorded = named.length === 0 && chain !== undefined ? knownEscrow(chain, problems) : undefined;
  const escrowList: readonly Address[] = named.length > 0 ? named : recorded === undefined ? [] : [recorded];
  const escrow = escrowList[0];

  if (escrowList.length > 1 && env?.STATE_PATH !== undefined) {
    problems.push({
      name: 'STATE_PATH',
      reason: `is set while ${escrowList.length} escrows are configured, and one cursor cannot serve them all`,
      expected: 'unset, so each escrow keeps its own cursor under OUTPUT_DIR/<chainId>-<escrow>/',
    });
  }

  if (env?.ESCALATE_EXPIRED === true && env.ESCALATE_MAX_BOND === undefined) {
    problems.push({
      name: 'ESCALATE_MAX_BOND',
      reason: 'is not set while ESCALATE_EXPIRED is true',
      expected: 'the largest dispute bond this payee will post, in micro-USD atomic units',
    });
  }

  if (env === undefined || providers === undefined || chain === undefined || !escrow || problems.length > 0) {
    throw new EnvError(problems);
  }

  const outputDir = env.OUTPUT_DIR;
  const escrows: EscrowWatch[] = escrowList.map((address) => {
    const scope = `${chain.chainId}-${address.toLowerCase()}`;
    return {
      escrow: address,
      outputScope: scope,
      statePath: escrowList.length === 1 && env.STATE_PATH !== undefined ? env.STATE_PATH : `${trimSlashes(outputDir)}/${scope}/cursor.json`,
    };
  });
  const [first] = escrows as [EscrowWatch, ...EscrowWatch[]];

  return {
    // Checked against the 32-byte hex pattern by the schema above, which is what makes `Hex` true.
    payeeKey: env.PAYEE_PRIVATE_KEY as Hex,
    viewingKey: env.SIDECAR_VIEWING_KEY as Hex | undefined,
    config: {
      chain,
      providers,
      escrows,
      escrow: first.escrow,
      apiBase: trimSlashes(env.API_BASE),
      capabilitiesPath: env.CAPABILITIES_PATH,
      allowedHosts: allowedHosts(env.ALLOWED_HOSTS),
      outputDir,
      outputScope: first.outputScope,
      outputBaseUrl: env.OUTPUT_BASE_URL === undefined ? undefined : trimSlashes(env.OUTPUT_BASE_URL),
      statePath: first.statePath,
      pollMs: env.POLL_MS,
      fetchTimeoutMs: env.FETCH_TIMEOUT_MS,
      confirmTimeoutMs: env.CONFIRM_TIMEOUT_MS,
      maxBodyBytes: env.MAX_BODY_BYTES,
      maxInlineOutputBytes: env.MAX_INLINE_OUTPUT_BYTES,
      blockRange: BigInt(env.MAX_BLOCK_RANGE),
      startBlock: env.START_BLOCK,
      finalizeReleases: env.FINALIZE_RELEASES,
      escalateExpired: env.ESCALATE_EXPIRED,
      escalateMaxBond: env.ESCALATE_MAX_BOND,
      minGasWei: env.MIN_GAS_WEI,
      gasCheckMs: env.GAS_CHECK_MS,
      evidenceUrl: env.SIDECAR_EVIDENCE_URL,
    },
  };
}

/**
 * Runs one resolver and folds whatever it complains about into the shared report. A missing chain
 * parameter is the same kind of mistake as a missing sidecar variable, so it is presented the same
 * way instead of terminating the pass that would have found the rest.
 */
function capture<T>(resolve: () => T, problems: EnvProblem[]): T | undefined {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof EnvError) {
      problems.push(...error.problems);
      return undefined;
    }

    // Only the chain-parameter errors fold in. Others name a variable too (two RPC names for one
    // host does), and they carry their own explanation, which a generic "not usable" would lose.
    if (isBursarError(error) && error.code.startsWith('rhc_')) {
      const variable = error.details['variable'];
      if (typeof variable === 'string') {
        const network = error.details['network'];
        problems.push({
          name: variable,
          reason: error.code === 'rhc_unconfigured' ? 'is not set' : 'is not usable',
          expected: `a Robinhood Chain ${typeof network === 'string' ? network : 'mainnet'} chain parameter`,
        });
        return undefined;
      }
    }

    throw error;
  }
}

/**
 * A payee on a chain the address book covers should never have to paste an address it already
 * holds. On a fork, or on a chain with no record, the lookup fails and the operator is asked for
 * the escrow by name, because a bare chain-id miss says nothing useful about what to fix.
 *
 * The record that answers for the chain is the current one. A payee still holding locks on a
 * superseded escrow lists both in ESCROW_ADDRESSES: the calls a payee makes (release,
 * finalizeRelease, dispute) are the same on both.
 */
function knownEscrow(chain: RhcChain, problems: EnvProblem[]): Address | undefined {
  try {
    return deploymentForChain(chain.chainId).contracts.Escrow;
  } catch (error) {
    if (!isBursarError(error)) throw error;
    problems.push({
      name: 'ESCROW_ADDRESS',
      reason: `is not set and there is no deployment record for chain ${chain.chainId}`,
      expected: 'a 20-byte hex address',
    });
    return undefined;
  }
}

/** ESCROW_ADDRESS then ESCROW_ADDRESSES, each checked, duplicates dropped whatever their case. */
function namedEscrows(
  single: Address | undefined,
  list: readonly string[] | undefined,
  problems: EnvProblem[],
): readonly Address[] {
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const entry of [...(single === undefined ? [] : [single]), ...(list ?? [])]) {
    if (!ADDRESS.test(entry)) {
      problems.push({ name: 'ESCROW_ADDRESSES', reason: `has an entry that is not a 20-byte hex address (${entry})`, expected: 'comma-separated 20-byte hex addresses' });
      continue;
    }
    if (seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    out.push(entry as Address);
  }
  return out;
}

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function allowedHosts(configured: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((configured ?? []).map(normalizeHost).filter((host) => host !== ''));
}
