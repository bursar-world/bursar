import process from 'node:process';

import { AllProvidersDownError, BursarError, committedMandateAccountAbi, createRhcClient, mandateAccountAbi } from '@bursar/core';
import type { RpcPoolEvent } from '@bursar/core';
import { contractSaidNo } from '@bursar/sdk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, secretsOf } from './config.js';
import type { McpConfig } from './config.js';
import { createExplorerIndex } from './explorer.js';
import { createChainGateway } from './gateway.js';
import { createPrivateGateway } from './private.js';
import { createProviderGateway } from './provider.js';
import { createResolverGateway } from './resolver.js';
import { createHttpRelay } from './relay.js';
import { createLocalSigner } from './signer.js';
import { callTool, redactSecrets, toolsFor } from './tools.js';
import type { ToolContext } from './tools.js';

const SERVER_NAME = 'bursar';
const SERVER_VERSION = '0.1.0';

export function createServer(context: ToolContext): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolsFor(context) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callTool(context, request.params.name, request.params.arguments);

    return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError };
  });

  return server;
}

export type ContextOptions = {
  readonly fetchFn?: typeof fetch;
  readonly onDiagnostic?: (line: string) => void;
};

/**
 * Binds the tools to the chain and to whichever signer the operator configured: one they run
 * themselves over HTTP, one this process holds a key for, or none, which serves the reads alone.
 */
export function createContext(config: McpConfig, options: ContextOptions = {}): ToolContext {
  const secrets = secretsOf(config);
  const report = options.onDiagnostic ?? writeDiagnostic;
  const { client } = createRhcClient({
    chain: config.chain,
    providers: config.providers,
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    onEvent: (event: RpcPoolEvent) => {
      // An endpoint degrading is the sort of thing that goes unnoticed until it is the only one
      // left, so every failover says so on stderr. stdout carries the protocol and nothing else.
      report(redactSecrets(JSON.stringify({ rpc: event }), secrets));
    },
  });

  const relay =
    config.relay === null
      ? null
      : createHttpRelay({
          url: config.relay.url,
          token: config.relay.token,
          timeoutMs: config.relay.timeoutMs,
          ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
        });

  // A key in this process signs for the mandate and nothing else, so it is bound to the mandate
  // account and never handed to the resolver or provider gateways. Configuration refuses both
  // signers at once, so at most one of these is not null.
  const signer =
    config.signer === null || config.account === null || config.privateMandate !== null
      ? null
      : createLocalSigner({
          client,
          chain: config.chain,
          account: config.account,
          key: config.signer.key,
        });

  const spender = signer ?? relay;

  // A role this server was not configured for gets no gateway at all, so its tools are absent from
  // the list instead of present and unusable.
  return {
    private: config.privateMandate === null ? null : createPrivateGateway({ client, handoff: config.privateMandate.handoff }),
    gateway:
      config.account === null || config.privateMandate !== null
        ? null
        : createChainGateway({
            client,
            account: config.account,
            escrows: config.escrows,
            settlementAsset: config.settlementAsset,
            relay: spender,
            index: createExplorerIndex({
              chainId: config.chain.chainId,
              ...(config.index.baseUrl === undefined ? {} : { baseUrl: config.index.baseUrl }),
              ...(config.index.apiKey === undefined ? {} : { apiKey: config.index.apiKey }),
              ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
            }),
          }),
    resolver:
      config.resolver === null
        ? null
        : createResolverGateway({
            client,
            resolver: config.resolver.account,
            registry: config.resolver.registry,
            escrow: config.escrow,
            relay,
          }),
    provider:
      config.provider === null
        ? null
        : createProviderGateway({
            client,
            provider: config.provider.account,
            registry: config.provider.registry,
            reputation: config.provider.reputation,
            relay,
          }),
    secrets,
    canSign: { mandate: spender !== null, resolver: relay !== null, provider: relay !== null },
    report: (line: string) => report(redactSecrets(line, secrets)),
  };
}

/**
 * Reads MANDATE_ACCOUNT once before serving, and refuses an address that is not a mandate.
 *
 * Without this the server starts, lists its tools, and every call fails later with an error that
 * reads as transient, so an agent retries a condition no retry can clear. A revert and an empty
 * return are both the address answering, and what it said is that it is not a mandate. Only a
 * read no endpoint answered leaves the question open: it is logged and the server starts, and the
 * first tool call reports the address if it is still wrong.
 */
/** True when the read failed on the way to the chain, on every endpoint, rather than at it. */
function noEndpointAnswered(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let node: unknown = error; node instanceof Error && !seen.has(node); node = node.cause) {
    if (node instanceof AllProvidersDownError) return true;
    seen.add(node);
  }
  return false;
}

export async function checkMandate(config: McpConfig, options: ContextOptions = {}): Promise<void> {
  const account = config.account;
  if (account === null) return;

  const report = options.onDiagnostic ?? writeDiagnostic;
  const { client } = createRhcClient({
    chain: config.chain,
    providers: config.providers,
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });

  if (config.privateMandate !== null) {
    await checkPrivateMandate(config, client, report);
    return;
  }

  let escrow: `0x${string}`;
  let asset: `0x${string}`;

  try {
    [escrow, asset] = await Promise.all([
      client.readContract({ address: account, abi: mandateAccountAbi, functionName: 'escrow' }),
      client.readContract({ address: account, abi: mandateAccountAbi, functionName: 'settlementAsset' }),
    ]);
  } catch (error) {
    if (contractSaidNo(error)) {
      throw new BursarError(
        'no_mandate_account',
        `MANDATE_ACCOUNT is ${account} on chain ${config.chain.chainId}, and nothing there answers as ` +
          'a mandate account. Set MANDATE_ACCOUNT to the mandate address (not the agent or principal ' +
          'wallet) and start the server again.',
        { address: account, chainId: config.chain.chainId },
      );
    }

    if (!noEndpointAnswered(error)) throw error;

    report(
      redactSecrets(
        `Could not read MANDATE_ACCOUNT ${account} at startup, so it is unchecked; the first tool call ` +
          'will check it again.',
        secretsOf(config),
      ),
    );
    return;
  }

  // The same comparison every tool makes, made once here so a wrong override is a startup failure
  // rather than a refusal on each call.
  const served = config.escrows.find((known) => known.toLowerCase() === escrow.toLowerCase());
  const mismatches = [
    { label: 'escrow', onChain: escrow, configured: served ?? config.escrow, variable: 'MANDATE_ESCROW' },
    { label: 'settlement asset', onChain: asset, configured: config.settlementAsset, variable: 'BURSAR_SETTLEMENT_ASSET' },
  ].filter((pair) => pair.onChain.toLowerCase() !== pair.configured.toLowerCase());

  if (mismatches.length > 0) {
    throw new BursarError(
      'config_mismatch',
      mismatches
        .map(
          (pair) =>
            `Mandate ${account} settles through the ${pair.label} ${pair.onChain}, and this server is ` +
            `configured for ${pair.configured}. Unset ${pair.variable} to use the mandate's own, or correct it.`,
        )
        .join(' '),
      { account, escrow, asset },
    );
  }
}

/**
 * A private mandate is checked by its agent: the account has to answer as a committed mandate and
 * name the key file's agent, or the key in this server spends from nothing.
 */
async function checkPrivateMandate(
  config: McpConfig,
  client: ReturnType<typeof createRhcClient>['client'],
  report: (line: string) => void,
): Promise<void> {
  const handoff = config.privateMandate?.handoff;
  if (handoff === undefined) return;

  let agent: `0x${string}`;
  try {
    agent = await client.readContract({ address: handoff.mandate, abi: committedMandateAccountAbi, functionName: 'agent' });
  } catch (error) {
    if (contractSaidNo(error)) {
      throw new BursarError(
        'no_mandate_account',
        `The key file names mandate ${handoff.mandate} on chain ${config.chain.chainId}, and nothing there ` +
          'answers as a private mandate. Ask the owner for the file again.',
        { address: handoff.mandate, chainId: config.chain.chainId },
      );
    }
    if (!noEndpointAnswered(error)) throw error;
    report(`Could not read mandate ${handoff.mandate} at startup, so it is unchecked; the first tool call will check it again.`);
    return;
  }

  if (agent.toLowerCase() !== handoff.agent.toLowerCase()) {
    throw new BursarError(
      'config_mismatch',
      `Mandate ${handoff.mandate} is run by agent ${agent}, and the key file holds the key of ${handoff.agent}. ` +
        'The owner has moved the mandate to another agent; ask for the new key file.',
      { mandate: handoff.mandate, agent, fileAgent: handoff.agent },
    );
  }
}

/** Reads the environment, connects the server to stdio, and resolves once it is serving. */
export async function start(source: NodeJS.ProcessEnv = process.env): Promise<Server> {
  const config = loadConfig(source);
  await checkMandate(config);
  const server = createServer(createContext(config));

  await server.connect(new StdioServerTransport());

  return server;
}

function writeDiagnostic(line: string): void {
  process.stderr.write(`${line}\n`);
}
