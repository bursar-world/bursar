import type { EnvSource } from '@bursar/core';
import { checkMandate, createContext, loadConfig as loadMcpConfig } from '@bursar/mcp';
import type { ToolContext } from '@bursar/mcp';
import type { Address, Hex } from 'viem';

/**
 * The tool set, bound to one mandate with one key, built the way the stdio server builds it.
 *
 * `@bursar/mcp` reads its binding from an environment, so each connection gets one: the host's
 * own environment for the endpoints, the deployment record and the index key, with the mandate
 * and the key laid over it. Nothing that names a role, a signer or a key file in the host's
 * environment reaches a connection, so a value an operator set for something else cannot widen
 * what a token can do.
 */

const PER_CONNECTION_ONLY = [
  'MANDATE_ACCOUNT',
  'BURSAR_SIGNER',
  'BURSAR_SIGNER_KEY',
  'BURSAR_AGENT_KEY_FILE',
  'BURSAR_RELAY_URL',
  'BURSAR_RELAY_TOKEN',
  'BURSAR_RESOLVER_ACCOUNT',
  'BURSAR_PROVIDER_ACCOUNT',
  'BURSAR_SHIELDED_KEY_FILE',
] as const;

export type ContextFactory = {
  /** Refuses an address that is not a mandate, before any key is made for it. */
  check(mandate: Address): Promise<void>;
  build(mandate: Address, key: Hex): Promise<ToolContext>;
};

function base(source: EnvSource): Record<string, string | undefined> {
  const copy: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source)) {
    if (!(PER_CONNECTION_ONLY as readonly string[]).includes(name)) copy[name] = value;
  }
  return copy;
}

export function createContextFactory(source: EnvSource, report: (line: string) => void): ContextFactory {
  const env = base(source);
  return {
    async check(mandate) {
      await checkMandate(loadMcpConfig({ ...env, MANDATE_ACCOUNT: mandate }), { onDiagnostic: report });
    },
    async build(mandate, key) {
      const config = loadMcpConfig({ ...env, MANDATE_ACCOUNT: mandate, BURSAR_SIGNER: 'local', BURSAR_SIGNER_KEY: key });
      return createContext(config, { onDiagnostic: report });
    },
  };
}
