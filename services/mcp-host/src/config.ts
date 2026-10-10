import { BursarError, envVar, loadEnv, optional, rhcChain, rhcRpcProviders, withDefault } from '@bursar/core';
import type { EnvSource, RhcChain, RpcProvider } from '@bursar/core';

/**
 * Configuration, read and checked before anything listens.
 *
 * The key-encryption key is the one secret this service cannot run without: every agent key it
 * generates is sealed under it, and a process without it could neither create a connection nor
 * answer one. Everything the per-connection MCP server reads (endpoints, the deployment record,
 * the index key) comes from the same environment, so the hosted tools and the published stdio
 * server are configured the same way.
 */

export const MIGRATE_MODES = ['on-start', 'verify', 'off'] as const;
export type MigrateMode = (typeof MIGRATE_MODES)[number];

const HEX32 = /^0x[0-9a-fA-F]{64}$/u;

/** Names a key must never arrive under, for the same reason the stdio server refuses them. */
const KEY_VARIABLES = ['AGENT_PRIVATE_KEY', 'BURSAR_PRIVATE_KEY', 'PRINCIPAL_PRIVATE_KEY', 'PRIVATE_KEY', 'MNEMONIC', 'BURSAR_SIGNER_KEY'] as const;

const schema = {
  MCP_HOST_HOST: withDefault(envVar.string({ minLength: 1 }), '127.0.0.1'),
  MCP_HOST_PORT: withDefault(envVar.int({ min: 1, max: 65_535 }), 8410),
  /** The address connectors are given. Defaults to the listener, which is right only on a laptop. */
  MCP_HOST_PUBLIC_URL: optional(envVar.url({ protocols: ['http:', 'https:'], secret: false })),
  DATABASE_URL: envVar.url({ protocols: ['postgres:', 'postgresql:'] }),
  MCP_HOST_MIGRATE: withDefault(envVar.oneOf(MIGRATE_MODES), 'on-start'),
  /** 32 bytes of hex. Declared secret so a load failure never echoes it. */
  MCP_HOST_KEK: envVar.string({ pattern: HEX32, secret: true }),
  MCP_HOST_TOKEN_RPM: withDefault(envVar.int({ min: 1, max: 10_000 }), 120),
  MCP_HOST_CONNECTIONS_PER_HOUR: withDefault(envVar.int({ min: 1, max: 1_000 }), 20),
  /** How long an owner's signature stays usable, in seconds. */
  MCP_HOST_PROOF_WINDOW_SECONDS: withDefault(envVar.seconds({ min: 30, max: 3_600 }), 600),
  RHC_NETWORK: withDefault(envVar.oneOf(['testnet', 'mainnet'] as const), 'mainnet'),
  BLOCKSCOUT_API_KEY: optional(envVar.string({ minLength: 8, secret: true })),
} as const;

export type HostConfig = {
  readonly host: string;
  readonly port: number;
  readonly publicUrl: string;
  readonly databaseUrl: string;
  readonly migrate: MigrateMode;
  readonly kek: `0x${string}`;
  readonly tokenRpm: number;
  readonly connectionsPerHour: number;
  readonly proofWindowSeconds: number;
  readonly chain: RhcChain;
  readonly providers: readonly RpcProvider[];
  readonly indexKey: string | null;
};

export class HostConfigError extends BursarError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
    this.name = 'HostConfigError';
  }
}

export function loadConfig(source: EnvSource = process.env): HostConfig {
  const present = KEY_VARIABLES.filter((name) => (source[name] ?? '').trim() !== '');
  if (present.length > 0) {
    throw new HostConfigError(
      'custody_refused',
      `This service generates the keys it signs with and takes none from the environment. Unset ${present.join(', ')}.`,
      { variables: present },
    );
  }
  if ((source['BURSAR_RELAY_URL'] ?? '').trim() !== '') {
    throw new HostConfigError('env_invalid', 'BURSAR_RELAY_URL is set. The hosted server signs with the key of each connection and uses no relay.');
  }

  const env = loadEnv(schema, source);
  const chain = rhcChain(env.RHC_NETWORK, source);
  const providers = rhcRpcProviders(source);
  const publicUrl = (env.MCP_HOST_PUBLIC_URL ?? `http://${env.MCP_HOST_HOST}:${env.MCP_HOST_PORT}`).replace(/\/+$/u, '');

  return {
    host: env.MCP_HOST_HOST,
    port: env.MCP_HOST_PORT,
    publicUrl,
    databaseUrl: env.DATABASE_URL,
    migrate: env.MCP_HOST_MIGRATE,
    kek: env.MCP_HOST_KEK as `0x${string}`,
    tokenRpm: env.MCP_HOST_TOKEN_RPM,
    connectionsPerHour: env.MCP_HOST_CONNECTIONS_PER_HOUR,
    proofWindowSeconds: env.MCP_HOST_PROOF_WINDOW_SECONDS,
    chain,
    providers,
    indexKey: env.BLOCKSCOUT_API_KEY ?? null,
  };
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
