import {
  BursarError,
  rhcChain,
  rhcRpcProviders,
  deploymentForChain,
  deploymentsForChain,
  envVar,
  isBursarError,
  loadEnv,
  optional,
  withDefault,
} from '@bursar/core';
import type { RhcChain, EnvSource, RpcProvider } from '@bursar/core';
import type { Address, Hex } from 'viem';

export type RelayConfig = {
  readonly url: string;
  readonly token: string | undefined;
  readonly timeoutMs: number;
};

/**
 * A key this process holds and signs with.
 *
 * Off by default and turned on by naming it: `BURSAR_SIGNER=local` is the operator saying the key
 * belongs in this process. See `signer.ts` for what the key is allowed to do once it is here.
 */
export type LocalSignerConfig = {
  readonly key: Hex;
};

/**
 * How the settlement history is read. The hosted Blockscout index is a paid tier, so a server
 * without a key can still answer every contract read and will say so on the one tool
 * that cannot be answered without it.
 */
export type IndexConfig = {
  readonly apiKey: string | undefined;
  /** Overrides the per-chain default base. For a self-hosted Blockscout, never the human site. */
  readonly baseUrl: string | undefined;
};

/**
 * A resolver this server acts for.
 *
 * `account` is the address the operator's signer holds. It is inside every commitment a resolver
 * seals, so a server pointed at one address while the signer holds another writes commitments that
 * can never be revealed. It is named rather than inferred for that reason.
 */
export type ResolverConfig = {
  readonly account: Address;
  readonly registry: Address;
};

export type ProviderConfig = {
  readonly account: Address;
  readonly registry: Address;
  readonly reputation: Address;
};

export type McpConfig = {
  readonly chain: RhcChain;
  readonly providers: readonly RpcProvider[];
  /** Null when this server serves a resolver or a provider and no mandate. */
  readonly account: Address | null;
  /** The escrow of the deployment that answers for the chain, or MANDATE_ESCROW. */
  readonly escrow: Address;
  /**
   * Every escrow a mandate may settle through: MANDATE_ESCROW alone when it is set, otherwise the
   * escrow of every live deployment on the chain, newest first. A mandate on the previous contract
   * set keeps reading.
   */
  readonly escrows: readonly Address[];
  readonly settlementAsset: Address;
  /** Null unless this server acts for a resolver. */
  readonly resolver: ResolverConfig | null;
  /** Null unless this server acts for a provider. */
  readonly provider: ProviderConfig | null;
  /** Null unless the operator pointed this server at a signer of their own over HTTP. */
  readonly relay: RelayConfig | null;
  /** Null unless the operator put a key in this process. It signs for the mandate and nothing else. */
  readonly signer: LocalSignerConfig | null;
  readonly index: IndexConfig;
};

const HEX32 = /^0x[0-9a-fA-F]{64}$/u;

const SCHEMA = {
  // Mainnet by default because it is the only Robinhood Chain network with a USDG contract.
  // Naming testnet is refused outright, by `rhcChain`, with the reason.
  RHC_NETWORK: withDefault(envVar.oneOf(['testnet', 'mainnet']), 'mainnet'),
  MANDATE_ACCOUNT: optional(envVar.address()),
  MANDATE_ESCROW: optional(envVar.address()),
  BURSAR_SETTLEMENT_ASSET: optional(envVar.address()),
  // The addresses the relay signs as, for the two roles that act on their own behalf rather than
  // a mandate's. Naming one turns its tools on; the registries default to the recorded deployment.
  BURSAR_RESOLVER_ACCOUNT: optional(envVar.address()),
  BURSAR_ORACLE_REGISTRY: optional(envVar.address()),
  BURSAR_PROVIDER_ACCOUNT: optional(envVar.address()),
  BURSAR_AGENT_REGISTRY: optional(envVar.address()),
  BURSAR_REPUTATION: optional(envVar.address()),
  // Which signer this server writes through, if any. Unset reads and never writes.
  BURSAR_SIGNER: optional(envVar.oneOf(['relay', 'local'])),
  BURSAR_SIGNER_KEY: optional(envVar.string({ minLength: 66, pattern: HEX32, secret: true })),
  BURSAR_RELAY_URL: optional(envVar.url({ protocols: ['http:', 'https:'] })),
  BURSAR_RELAY_TOKEN: optional(envVar.string({ minLength: 8, secret: true })),
  BURSAR_RELAY_TIMEOUT_MS: withDefault(envVar.int({ min: 1_000, max: 120_000 }), 30_000),
  // The names `@bursar/core` reads the index under, declared here so one missing variable is
  // reported with the rest rather than at the first history lookup.
  BLOCKSCOUT_API_KEY: optional(envVar.string({ minLength: 8, secret: true })),
  BLOCKSCOUT_API_BASE: optional(envVar.url({ protocols: ['https:'], secret: false })),
} as const;

/**
 * Names a key must never arrive under.
 *
 * Every one of these is set in shells and deployment environments for something else, so a key
 * reaching this server through one of them would be custody taken by accident. Signing in this
 * process is a decision, and it is made under `BURSAR_SIGNER` and nowhere else.
 */
const KEY_VARIABLES = [
  'AGENT_PRIVATE_KEY',
  'BURSAR_PRIVATE_KEY',
  'PRINCIPAL_PRIVATE_KEY',
  'PRIVATE_KEY',
  'MNEMONIC',
] as const;

export function loadConfig(source: EnvSource = process.env): McpConfig {
  assertNoKeys(source);

  const env = loadEnv(SCHEMA, source);
  const chain = rhcChain(env.RHC_NETWORK, source);
  // Before the escrow, because an operator on a first run has neither and the endpoints are the
  // ones they cannot guess. Resolving them here reports them in the same pass.
  const providers = rhcRpcProviders(source);
  const deployed = deployedContracts(chain.chainId);

  const escrow = env.MANDATE_ESCROW ?? deployed?.escrow;

  if (escrow === undefined) {
    throw new BursarError(
      'env_invalid',
      `MANDATE_ESCROW is required on chain ${chain.chainId}, which has no recorded deployment.`,
      { chainId: chain.chainId },
    );
  }

  const relayUrl = env.BURSAR_RELAY_URL;

  // A token with nowhere to go is a half-written configuration, and the half that is missing is the
  // one that would have let this server spend anything.
  if (relayUrl === undefined && env.BURSAR_RELAY_TOKEN !== undefined) {
    throw new BursarError('env_invalid', 'BURSAR_RELAY_TOKEN is set but BURSAR_RELAY_URL is not.');
  }

  const account = env.MANDATE_ACCOUNT;
  const signer = localSigner(env, account);
  const resolver = resolverConfig(env, deployed, chain.chainId);
  const provider = providerConfig(env, deployed, chain.chainId);

  // A server bound to no role serves nothing. Saying so at startup is better than advertising an
  // empty tool list to a client that will sit there waiting to be told why.
  if (account === undefined && resolver === null && provider === null) {
    throw new BursarError(
      'env_invalid',
      'This server is not bound to anything. Set MANDATE_ACCOUNT to work inside a spending mandate, ' +
        'BURSAR_RESOLVER_ACCOUNT to rule on disputes, or BURSAR_PROVIDER_ACCOUNT to sell capability. ' +
        'One server can carry more than one of them.',
    );
  }

  return {
    chain,
    providers,
    account: account ?? null,
    escrow,
    escrows: env.MANDATE_ESCROW === undefined && deployed !== null ? deployed.escrows : [escrow],
    settlementAsset: env.BURSAR_SETTLEMENT_ASSET ?? deployed?.settlementAsset ?? chain.usdg,
    resolver,
    provider,
    relay:
      relayUrl === undefined
        ? null
        : { url: relayUrl, token: env.BURSAR_RELAY_TOKEN, timeoutMs: env.BURSAR_RELAY_TIMEOUT_MS },
    signer,
    index: { apiKey: env.BLOCKSCOUT_API_KEY, baseUrl: env.BLOCKSCOUT_API_BASE },
  };
}

/**
 * Whether this process holds the key itself.
 *
 * Both halves have to be said out loud. A key that arrived without `BURSAR_SIGNER=local` is a
 * custody decision made by accident, and `local` with no key is a server that would advertise
 * tools it cannot carry out.
 */
function localSigner(env: Env, account: Address | undefined): LocalSignerConfig | null {
  const mode = env.BURSAR_SIGNER;
  const key = env.BURSAR_SIGNER_KEY;

  if (mode !== 'local') {
    if (key === undefined) return null;

    throw new BursarError(
      'custody_refused',
      'BURSAR_SIGNER_KEY is set and BURSAR_SIGNER is not local, so this server has been handed a key ' +
        'it was not told to hold. Set BURSAR_SIGNER=local to sign in this process, or unset the key ' +
        'and point BURSAR_RELAY_URL at a signer of your own.',
    );
  }

  if (key === undefined) {
    throw new BursarError(
      'env_invalid',
      'BURSAR_SIGNER=local signs in this process and BURSAR_SIGNER_KEY is not set, so there is nothing ' +
        'to sign with.',
    );
  }

  // Two signers leave open which key spent the money. The operator answers that here, before the
  // server has to guess.
  if (env.BURSAR_RELAY_URL !== undefined) {
    throw new BursarError(
      'env_invalid',
      'BURSAR_SIGNER=local and BURSAR_RELAY_URL both name a signer. Keep the one that should send ' +
        "this mandate's transactions and unset the other.",
    );
  }

  if (account === undefined) {
    throw new BursarError(
      'env_invalid',
      'BURSAR_SIGNER=local signs for one mandate and MANDATE_ACCOUNT is not set. The key in this ' +
        'process cannot act for a resolver or a provider; those roles sign through BURSAR_RELAY_URL.',
    );
  }

  // HEX32 is the shape viem's own key parser accepts, checked above by the schema.
  return { key: key as Hex };
}

type Deployed = ReturnType<typeof deployedContracts>;
type Env = ReturnType<typeof loadEnv<typeof SCHEMA>>;

function resolverConfig(env: Env, deployed: Deployed, chainId: number): ResolverConfig | null {
  const account = env.BURSAR_RESOLVER_ACCOUNT;
  if (account === undefined) return null;

  const registry = env.BURSAR_ORACLE_REGISTRY ?? deployed?.oracleRegistry;

  if (registry === undefined) {
    throw new BursarError(
      'env_invalid',
      `BURSAR_ORACLE_REGISTRY is required on chain ${chainId}, which has no recorded deployment to ` +
        'take the dispute registry from.',
      { chainId },
    );
  }

  return { account, registry };
}

function providerConfig(env: Env, deployed: Deployed, chainId: number): ProviderConfig | null {
  const account = env.BURSAR_PROVIDER_ACCOUNT;
  if (account === undefined) return null;

  const registry = env.BURSAR_AGENT_REGISTRY ?? deployed?.agentRegistry;
  const reputation = env.BURSAR_REPUTATION ?? deployed?.reputation;

  if (registry === undefined || reputation === undefined) {
    throw new BursarError(
      'env_invalid',
      `BURSAR_AGENT_REGISTRY and BURSAR_REPUTATION are required on chain ${chainId}, which has no ` +
        'recorded deployment to take them from.',
      { chainId },
    );
  }

  return { account, registry, reputation };
}

/** Every secret the process knows, so a message on its way out can be scrubbed of all of them. */
export function secretsOf(config: McpConfig): readonly string[] {
  const secrets = config.providers.map((provider) => provider.url);

  if (config.relay?.token !== undefined) secrets.push(config.relay.token);
  if (config.signer !== null) secrets.push(config.signer.key);
  if (config.index.apiKey !== undefined) secrets.push(config.index.apiKey);

  return secrets;
}

function assertNoKeys(source: EnvSource): void {
  const present = KEY_VARIABLES.filter((name) => (source[name] ?? '').trim() !== '');

  if (present.length === 0) return;

  throw new BursarError(
    'custody_refused',
    `This server does not take a key under a name something else may also be reading. Unset ` +
      `${present.join(', ')}. To sign in this process, set BURSAR_SIGNER=local and BURSAR_SIGNER_KEY; ` +
      'to keep the key out of it, point BURSAR_RELAY_URL at a signer of your own.',
    { variables: present },
  );
}

function deployedContracts(chainId: number): {
  escrow: Address;
  escrows: Address[];
  settlementAsset: Address;
  oracleRegistry: Address;
  agentRegistry: Address;
  reputation: Address;
} | null {
  try {
    const record = deploymentForChain(chainId);

    return {
      escrow: record.contracts.Escrow,
      escrows: deploymentsForChain(chainId).map((d) => d.contracts.Escrow),
      settlementAsset: record.settlementAsset,
      oracleRegistry: record.contracts.OracleRegistry,
      agentRegistry: record.contracts.AgentRegistry,
      reputation: record.contracts.Reputation,
    };
  } catch (error) {
    // A chain with no committed deployment is normal before launch day; the addresses come from env.
    if (isBursarError(error) && error.code === 'deployment_unknown') return null;

    throw error;
  }
}
