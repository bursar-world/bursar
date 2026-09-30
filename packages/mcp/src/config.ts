import {
  BursarError,
  privacyDeployment,
  rhcChain,
  rhcRpcProviders,
  deploymentForChain,
  deploymentsForChain,
  envVar,
  isBursarError,
  loadEnv,
  optional,
  parseDeployment,
  rwaDeployment,
  withDefault,
} from '@bursar/core';
import type {
  Deployment,
  EnvSource,
  PrivacyDeployment,
  RhcChain,
  RpcProvider,
  RwaDeployment,
  ShieldedDeployment,
} from '@bursar/core';
import { readAgentHandoff } from '@bursar/sdk';
import type { AgentHandoff, ShieldedKeys } from '@bursar/sdk';
import { readFileSync } from 'node:fs';
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

/**
 * A private mandate this server spends from as its agent. The agent's key and the readable terms
 * it proves against both come from the key file the owner exported, so neither is typed into the
 * environment.
 */
export type PrivateMandateConfig = {
  readonly handoff: AgentHandoff;
};

/**
 * The shielded USDG pool on this chain. `keys` is the float a principal handed this agent: the note
 * master keys of a shielded balance, read from BURSAR_SHIELDED_KEY_FILE. Without it the server can
 * only read the pool.
 */
export type ShieldedConfig = {
  readonly deployment: ShieldedDeployment;
  readonly keys: ShieldedKeys | null;
  /** services/relayer. Every shielded payment goes through it; none is sent from this process. */
  readonly relayerUrl: string | null;
  /** services/asp. Optional: the set is rebuilt from chain data when it is absent or disagrees. */
  readonly aspUrl: string | null;
};

export const SHIELDED_KEYS_KIND = 'bursar-shielded-keys';

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
  /** MANDATE_ESCROW, or the escrow of the record this server reads. */
  readonly escrow: Address;
  /**
   * Every escrow a mandate may settle through: MANDATE_ESCROW alone when it is set, or the escrow of
   * the record BURSAR_RECORD names. Otherwise the escrow of every live deployment on the chain,
   * newest first, so a mandate on the previous contract set keeps reading.
   */
  readonly escrows: readonly Address[];
  readonly settlementAsset: Address;
  /**
   * The stock and treasury lane of the record this server reads, with its collateral lane if it has
   * one. Null when that record carries none, and the tools that need it are then refused or absent.
   */
  readonly rwa: RwaDeployment | null;
  /** Null unless this server acts for a resolver. */
  readonly resolver: ResolverConfig | null;
  /** Null unless this server acts for a provider. */
  readonly provider: ProviderConfig | null;
  /** Null unless the operator pointed this server at a signer of their own over HTTP. */
  readonly relay: RelayConfig | null;
  /** Null unless the operator put a key in this process. It signs for the mandate and nothing else. */
  readonly signer: LocalSignerConfig | null;
  /** Null unless BURSAR_AGENT_KEY_FILE names a private mandate's key file. */
  readonly privateMandate: PrivateMandateConfig | null;
  /** Null when the record this server reads has no shielded pool. */
  readonly shielded: ShieldedConfig | null;
  readonly index: IndexConfig;
};

const HEX32 = /^0x[0-9a-fA-F]{64}$/u;

const SCHEMA = {
  // Mainnet by default because it is the only Robinhood Chain network with a USDG contract.
  // Naming testnet is refused outright, by `rhcChain`, with the reason.
  RHC_NETWORK: withDefault(envVar.oneOf(['testnet', 'mainnet']), 'mainnet'),
  MANDATE_ACCOUNT: optional(envVar.address()),
  // A deployment record as the deploy scripts write it, for a deployment this package has not
  // recorded. Every address the server takes from a record then comes from this one.
  BURSAR_RECORD: optional(envVar.string({ minLength: 1 })),
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
  // A private mandate's key file, exported by the owner's console. It carries the agent key, so it
  // is read only under BURSAR_SIGNER=local, like the key above.
  BURSAR_AGENT_KEY_FILE: optional(envVar.string({ minLength: 1 })),
  BURSAR_RELAY_URL: optional(envVar.url({ protocols: ['http:', 'https:'] })),
  // A shielded balance the principal handed this agent, and the services it spends through. The
  // relayer (services/relayer) is a different thing from the signer relay above: it submits pool
  // withdrawals from its own wallet and never holds a key of this server's.
  BURSAR_SHIELDED_KEY_FILE: optional(envVar.string({ minLength: 1 })),
  BURSAR_RELAYER_URL: optional(envVar.url({ protocols: ['http:', 'https:'] })),
  BURSAR_ASP_URL: optional(envVar.url({ protocols: ['http:', 'https:'] })),
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
  const deployed = deployedContracts(chain.chainId, env.BURSAR_RECORD);

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

  const privateMandate = privateMandateConfig(env, chain.chainId);
  const account = env.MANDATE_ACCOUNT ?? privateMandate?.handoff.mandate;
  const signer = privateMandate === null ? localSigner(env, account) : { key: privateMandate.handoff.privateKey };
  const resolver = resolverConfig(env, deployed, chain.chainId);
  const provider = providerConfig(env, deployed, chain.chainId);
  const shielded = shieldedConfig(env, chain.chainId, deployed?.privacy);

  // A server bound to no role serves nothing. Saying so at startup is better than advertising an
  // empty tool list to a client that will sit there waiting to be told why.
  if (account === undefined && resolver === null && provider === null && shielded?.keys == null) {
    throw new BursarError(
      'env_invalid',
      'This server is not bound to anything. Set MANDATE_ACCOUNT to work inside a spending mandate, ' +
        'BURSAR_RESOLVER_ACCOUNT to rule on disputes, BURSAR_PROVIDER_ACCOUNT to sell capability, or ' +
        'BURSAR_SHIELDED_KEY_FILE to spend a shielded balance. One server can carry more than one of them.',
    );
  }

  return {
    chain,
    providers,
    account: account ?? null,
    escrow,
    escrows: env.MANDATE_ESCROW === undefined && deployed !== null ? deployed.escrows : [escrow],
    settlementAsset: env.BURSAR_SETTLEMENT_ASSET ?? deployed?.settlementAsset ?? chain.usdg,
    rwa: deployed?.rwa ?? null,
    resolver,
    provider,
    relay:
      relayUrl === undefined
        ? null
        : { url: relayUrl, token: env.BURSAR_RELAY_TOKEN, timeoutMs: env.BURSAR_RELAY_TIMEOUT_MS },
    signer,
    privateMandate,
    shielded,
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

/**
 * Reads the key file of a private mandate.
 *
 * The file is a key, so it takes the same spoken decision as BURSAR_SIGNER_KEY: BURSAR_SIGNER=local.
 * It is the only key the server holds, and it names its own mandate, so a second key, a relay or
 * a different MANDATE_ACCOUNT leaves open which one was meant and is refused.
 */
function privateMandateConfig(env: Env, chainId: number): PrivateMandateConfig | null {
  const path = env.BURSAR_AGENT_KEY_FILE;
  if (path === undefined) return null;

  if (env.BURSAR_SIGNER !== 'local') {
    throw new BursarError(
      'custody_refused',
      'BURSAR_AGENT_KEY_FILE holds an agent key and BURSAR_SIGNER is not local, so this server has been ' +
        'handed a key it was not told to hold. Set BURSAR_SIGNER=local to sign in this process.',
    );
  }

  if (env.BURSAR_SIGNER_KEY !== undefined) {
    throw new BursarError(
      'env_invalid',
      'BURSAR_AGENT_KEY_FILE and BURSAR_SIGNER_KEY both name a key. A private mandate signs with the key ' +
        'in its file; unset BURSAR_SIGNER_KEY.',
    );
  }

  if (env.BURSAR_RELAY_URL !== undefined) {
    throw new BursarError(
      'env_invalid',
      'BURSAR_AGENT_KEY_FILE and BURSAR_RELAY_URL both name a signer. Keep the one that should send this ' +
        "mandate's transactions and unset the other.",
    );
  }

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new BursarError('env_invalid', `BURSAR_AGENT_KEY_FILE names ${path}, and it could not be read.`, { path });
  }

  let handoff: AgentHandoff;
  try {
    handoff = readAgentHandoff(text);
  } catch (error) {
    // The reader's sentences name the field and never the key, so they are safe to pass on.
    const reason = error instanceof Error ? error.message : 'It is not a key file.';
    throw new BursarError('env_invalid', `BURSAR_AGENT_KEY_FILE is not a usable agent key file. ${reason}`, { path });
  }

  if (handoff.chainId !== chainId) {
    throw new BursarError(
      'config_mismatch',
      `The key file is for a mandate on chain ${handoff.chainId}, and this server is on chain ${chainId}.`,
      { fileChainId: handoff.chainId, chainId },
    );
  }

  if (env.MANDATE_ACCOUNT !== undefined && env.MANDATE_ACCOUNT.toLowerCase() !== handoff.mandate.toLowerCase()) {
    throw new BursarError(
      'config_mismatch',
      `MANDATE_ACCOUNT is ${env.MANDATE_ACCOUNT} and the key file is for mandate ${handoff.mandate}. ` +
        'Unset MANDATE_ACCOUNT to use the mandate the file names.',
      { account: env.MANDATE_ACCOUNT, fileMandate: handoff.mandate },
    );
  }

  return { handoff };
}

/**
 * The pool on this chain and, when BURSAR_SHIELDED_KEY_FILE is set, the float's keys. The file is
 * the money: whoever reads it can withdraw the balance, so it is kept out of every reply like a key.
 */
function shieldedConfig(env: Env, chainId: number, privacy: PrivacyDeployment | undefined): ShieldedConfig | null {
  const deployment = privacy?.shielded;
  const path = env.BURSAR_SHIELDED_KEY_FILE;

  if (deployment === undefined) {
    if (path === undefined) return null;
    throw new BursarError(
      'env_invalid',
      `BURSAR_SHIELDED_KEY_FILE is set, and the record this server reads for chain ${chainId} has no shielded pool.`,
      { chainId },
    );
  }

  const relayerUrl = env.BURSAR_RELAYER_URL ?? null;
  const aspUrl = env.BURSAR_ASP_URL ?? null;
  if (path === undefined) return { deployment, keys: null, relayerUrl, aspUrl };

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new BursarError('env_invalid', `BURSAR_SHIELDED_KEY_FILE names ${path}, and it could not be read.`, { path });
  }

  return { deployment, keys: readShieldedKeys(text, chainId, deployment.ShieldedPool), relayerUrl, aspUrl };
}

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Parses a shielded key file. Messages never quote the keys. */
export function readShieldedKeys(text: string, chainId: number, pool: Address): ShieldedKeys {
  const bad = (reason: string, detail: Record<string, unknown> = {}) =>
    new BursarError('env_invalid', `BURSAR_SHIELDED_KEY_FILE is not a usable shielded key file. ${reason}`, detail);
  let file: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    file = parsed as Record<string, unknown>;
  } catch {
    throw bad('It is not JSON.');
  }
  if (file['kind'] !== SHIELDED_KEYS_KIND || file['version'] !== 1) {
    throw bad(`Its kind is not ${SHIELDED_KEYS_KIND} version 1.`);
  }
  if (file['chainId'] !== chainId) {
    throw new BursarError(
      'config_mismatch',
      `The shielded key file is for chain ${String(file['chainId'])}, and this server is on chain ${chainId}.`,
      { fileChainId: file['chainId'], chainId },
    );
  }
  if (typeof file['pool'] !== 'string' || file['pool'].toLowerCase() !== pool.toLowerCase()) {
    throw new BursarError(
      'config_mismatch',
      `The shielded key file is for pool ${String(file['pool'])}, and the pool on this chain is ${pool}.`,
      { filePool: file['pool'], pool },
    );
  }
  const scalar = (key: string): bigint => {
    const value = file[key];
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,77}$/u.test(value) || BigInt(value) >= FIELD) {
      throw bad(`${key} is not a field element.`);
    }
    return BigInt(value);
  };
  return { masterNullifier: scalar('masterNullifier'), masterSecret: scalar('masterSecret') };
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
  // The same key as the signer's today; listed on its own so a later split cannot drop it.
  if (config.privateMandate !== null) secrets.push(config.privateMandate.handoff.privateKey);
  if (config.index.apiKey !== undefined) secrets.push(config.index.apiKey);
  if (config.shielded?.keys != null) {
    secrets.push(config.shielded.keys.masterNullifier.toString(), config.shielded.keys.masterSecret.toString());
  }

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

/**
 * The addresses this server takes from a deployment record, and the record's lanes.
 *
 * A record BURSAR_RECORD names answers for itself, and nothing it leaves out is filled in by chain
 * id: a local rehearsal and a fork of mainnet answer as chain 4663 too, and a lookup would hand them
 * the mainnet escrows, lanes and pool. Unset, the record that answers for the chain is read, the
 * escrows of the sets it replaced are still accepted, and a lane it has not deployed may come from
 * an earlier record of the same build.
 */
function deployedContracts(chainId: number, path: string | undefined): {
  escrow: Address;
  escrows: Address[];
  settlementAsset: Address;
  oracleRegistry: Address;
  agentRegistry: Address;
  reputation: Address;
  rwa: RwaDeployment | undefined;
  privacy: PrivacyDeployment | undefined;
} | null {
  const supplied = path !== undefined;
  const record = supplied ? readRecord(path, chainId) : answeringRecord(chainId);
  if (record === null) return null;

  return {
    escrow: record.contracts.Escrow,
    escrows: supplied ? [record.contracts.Escrow] : deploymentsForChain(chainId).map((d) => d.contracts.Escrow),
    settlementAsset: record.settlementAsset,
    oracleRegistry: record.contracts.OracleRegistry,
    agentRegistry: record.contracts.AgentRegistry,
    reputation: record.contracts.Reputation,
    rwa: supplied ? record.rwa : rwaDeployment(chainId),
    privacy: supplied ? record.privacy : privacyDeployment(chainId),
  };
}

function answeringRecord(chainId: number): Deployment | null {
  try {
    return deploymentForChain(chainId);
  } catch (error) {
    // A chain with no committed deployment is normal before launch day; the addresses come from env.
    if (isBursarError(error) && error.code === 'deployment_unknown') return null;

    throw error;
  }
}

/** Reads the record BURSAR_RECORD names, checked the way the address book checks its own. */
function readRecord(path: string, chainId: number): Deployment {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new BursarError('env_invalid', `BURSAR_RECORD names ${path}, and it could not be read.`, { path });
  }

  let record: Deployment;
  try {
    record = parseDeployment(JSON.parse(text) as unknown, path);
  } catch (error) {
    if (!(error instanceof SyntaxError) && !isBursarError(error)) throw error;
    const reason = isBursarError(error) ? error.message : 'It is not JSON.';
    throw new BursarError('env_invalid', `BURSAR_RECORD is not a usable deployment record. ${reason}`, { path });
  }

  if (record.chainId !== chainId) {
    throw new BursarError(
      'config_mismatch',
      `BURSAR_RECORD holds ${record.network}, a deployment on chain ${record.chainId}, and this server is on ` +
        `chain ${chainId}.`,
      { network: record.network, recordChainId: record.chainId, chainId },
    );
  }

  return record;
}
