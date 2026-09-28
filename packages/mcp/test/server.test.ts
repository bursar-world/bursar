import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { checkMandate, createContext, createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { callTool, toolsFor } from '../src/tools.js';
import { PROVIDER, createFakeGateway } from './fakes.js';
import type { FakeGateway } from './fakes.js';
import { createFakeNode } from './node.js';

const RELAY_TOKEN = 'a-long-relay-token';

const ENV = {
  RHC_RPC_PRIMARY: 'http://primary.test',
  RHC_RPC_FALLBACK: 'http://fallback.test',
  MANDATE_ACCOUNT: '0x00000000000000000000000000000000000acc01',
  // Named, because nothing is deployed on 4663 yet and there is no record to read it from.
  MANDATE_ESCROW: '0x8E298457cDFc1Cb9ef6253D36d3BD5cFEf10F915',
  BURSAR_RELAY_URL: 'https://relay.test',
  BURSAR_RELAY_TOKEN: RELAY_TOKEN,
};

async function connect(fake: FakeGateway, canSign = true): Promise<Client> {
  const server = createServer({
    gateway: fake.gateway,
    resolver: null,
    provider: null,
    secrets: [RELAY_TOKEN],
    canSign: { mandate: canSign, resolver: canSign, provider: canSign },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return client;
}

describe('the server over an in-memory transport', () => {
  it('advertises the whole loop with its schemas', async () => {
    const client = await connect(createFakeGateway());

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'mandate_inspect',
      'mandate_quote_spend',
      'mandate_pay_provider',
      'mandate_buy_stock',
      'mandate_list_settlements',
      'mandate_get_settlement',
      'mandate_open_dispute',
      'mandate_hire_agent',
      'mandate_get_dispute',
    ]);
    expect(tools[2]?.inputSchema.required).toContain('deliverWithinSeconds');
  });

  it('advertises only what it can carry out when no signer is configured', async () => {
    const client = await connect(createFakeGateway(), false);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'mandate_inspect',
      'mandate_quote_spend',
      'mandate_list_settlements',
      'mandate_get_settlement',
      'mandate_get_dispute',
    ]);
  });

  it('carries a call through to the gateway and returns its json', async () => {
    const fake = createFakeGateway();
    const client = await connect(fake);

    const result = await client.callTool({
      name: 'mandate_pay_provider',
      arguments: {
        provider: PROVIDER,
        capability: 'search.web:1',
        input: { city: 'Paris' },
        amount: '1000000',
        deliverWithinSeconds: 300,
      },
    });

    expect(result.isError).toBe(false);
    expect(fake.orders[0]?.amount).toBe(1_000_000n);
    expect(JSON.parse(String((result.content as { text: string }[])[0]?.text))).toMatchObject({
      settlementId: '42',
      status: 'held',
    });
  });

  it('reports a rejected argument as a tool error rather than a protocol failure', async () => {
    const fake = createFakeGateway();
    const client = await connect(fake);

    const result = await client.callTool({ name: 'mandate_get_settlement', arguments: { settlementId: '0' } });

    expect(result.isError).toBe(true);
    expect(fake.reads).toHaveLength(0);
  });
});

describe('the context the server runs on', () => {
  it('binds the tools to the configured mandate without holding a key', async () => {
    const node = createFakeNode();
    const context = createContext(loadConfig(ENV), { fetchFn: node.fetchFn, onDiagnostic: () => undefined });

    expect(context.canSign).toEqual({ mandate: true, resolver: true, provider: true });
    expect(context.secrets).toContain(RELAY_TOKEN);
    expect((await context.gateway?.inspect())?.account.toLowerCase()).toBe(ENV.MANDATE_ACCOUNT);
  });

  it('reports an rpc failover on the diagnostic channel, with the endpoint redacted', async () => {
    const lines: string[] = [];
    const node = createFakeNode();
    const failing = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      if (String(input).includes('primary')) throw new Error('connection refused');

      return node.fetchFn(input as string, init);
    }) as typeof fetch;

    const context = createContext(loadConfig(ENV), { fetchFn: failing, onDiagnostic: (line) => lines.push(line) });

    await context.gateway?.inspect();

    expect(lines.join('\n')).toContain('fallback_used');
    expect(lines.join('\n')).not.toContain(RELAY_TOKEN);
  });
});

/** A node where MANDATE_ACCOUNT holds no code: every call to it comes back as `0x`. */
function emptyAccountNode(): typeof fetch {
  return (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { id: number; method: string };
    const result = body.method === 'eth_chainId' ? '0x1237' : '0x';

    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/**
 * A node where MANDATE_ACCOUNT is some other contract, answered as mainnet answers for the Escrow:
 * `escrow()` reverts with no data and `settlementAsset()` returns an address.
 */
function otherContractNode(): typeof fetch {
  return (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { id: number; method: string; params?: [{ data?: string }] };
    const reply =
      body.method === 'eth_chainId'
        ? { result: '0x1237' }
        : body.params?.[0]?.data?.startsWith(ESCROW_SELECTOR)
          ? { error: { code: 3, message: 'execution reverted', data: '0x' } }
          : { result: `0x${'5fc5360d0400a0fd4f2af552add042d716f1d168'.padStart(64, '0')}` };

    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...reply }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/** `escrow()`. */
const ESCROW_SELECTOR = '0xe2fdcc17';

describe('the startup check on MANDATE_ACCOUNT', () => {
  it('refuses a contract whose identity reads revert, in the words it uses for an empty address', async () => {
    const lines: string[] = [];
    const failure = await checkMandate(loadConfig(ENV), {
      fetchFn: otherContractNode(),
      onDiagnostic: (line) => lines.push(line),
    }).catch((error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain(`MANDATE_ACCOUNT is ${ENV.MANDATE_ACCOUNT} on chain 4663`);
    expect(failure?.message).toContain('nothing there answers as a mandate account');
    expect(lines.join('\n')).not.toContain('unchecked');
  });

  it('refuses an address that is not a mandate, naming it and the fix', async () => {
    const failure = await checkMandate(loadConfig(ENV), { fetchFn: emptyAccountNode(), onDiagnostic: () => undefined }).catch(
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain(`MANDATE_ACCOUNT is ${ENV.MANDATE_ACCOUNT} on chain 4663`);
    expect(failure?.message).toContain('nothing there answers as a mandate account');
    expect(failure?.message).not.toMatch(/try (the call )?again/iu);
  });

  it('passes a mandate whose escrow and asset match the configuration', async () => {
    const node = createFakeNode();

    await expect(checkMandate(loadConfig(ENV), { fetchFn: node.fetchFn })).resolves.toBeUndefined();
  });

  it('refuses a MANDATE_ESCROW the mandate does not settle through', async () => {
    const node = createFakeNode();
    const wrong = '0x9999999999999999999999999999999999999999';

    await expect(checkMandate(loadConfig({ ...ENV, MANDATE_ESCROW: wrong }), { fetchFn: node.fetchFn })).rejects.toThrow(
      /settles through the escrow 0x8E29.*configured for 0x9999.*Unset MANDATE_ESCROW/u,
    );
  });

  it('starts when the node does not answer, and says on stderr that the address is unchecked', async () => {
    const lines: string[] = [];
    const down = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;

    await expect(checkMandate(loadConfig(ENV), { fetchFn: down, onDiagnostic: (line) => lines.push(line) })).resolves.toBeUndefined();
    expect(lines.join('\n')).toContain('unchecked');
  });

  it('answers a tool call on a non-mandate with the cause, and logs it for the operator', async () => {
    const lines: string[] = [];
    const context = createContext(loadConfig(ENV), { fetchFn: emptyAccountNode(), onDiagnostic: (line) => lines.push(line) });

    const view = JSON.parse((await callTool(context, 'mandate_inspect', {})).text) as Record<string, unknown>;

    expect(view['error']).toBe('no_contract');
    expect(view['message']).toContain('MANDATE_ACCOUNT');
    expect(view['message']).toContain('Retrying will not change that');
    expect(lines.join('\n')).toContain('mandate_inspect');
  });
});

/**
 * The same server with the key in the process instead of behind a relay. This is the path an
 * operator with no signer of their own runs, and the one the walkthrough could not drive at all.
 */
describe('a server signing with its own key', () => {
  const { BURSAR_RELAY_URL: _url, BURSAR_RELAY_TOKEN: _token, ...WITHOUT_RELAY } = ENV;

  const LOCAL = { ...WITHOUT_RELAY, BURSAR_SIGNER: 'local', BURSAR_SIGNER_KEY: `0x${'7f'.repeat(32)}` };

  it('advertises the tools that spend, and answers one', async () => {
    const node = createFakeNode();
    const context = createContext(loadConfig(LOCAL), { fetchFn: node.fetchFn, onDiagnostic: () => undefined });

    expect(context.canSign).toEqual({ mandate: true, resolver: false, provider: false });

    const result = await callTool(context, 'mandate_pay_provider', {
      provider: PROVIDER,
      capability: 'search.web:1',
      input: { city: 'Paris' },
      amount: '1000000',
      deliverWithinSeconds: 3_600,
    });

    const view = JSON.parse(result.text) as Record<string, unknown>;

    expect(result.isError).toBe(false);
    expect(view['settlementId']).toBe('77');
    expect(view['txHash']).toBe(node.transactions[0]?.hash);
    expect(node.transactions).toHaveLength(1);
  });

  it('never prints the key it signs with', async () => {
    const node = createFakeNode();
    const context = createContext(loadConfig(LOCAL), { fetchFn: node.fetchFn, onDiagnostic: () => undefined });

    const failure = await callTool(context, 'mandate_get_settlement', { settlementId: '404' });

    expect(context.secrets).toContain(LOCAL.BURSAR_SIGNER_KEY);
    expect(failure.text).not.toContain('7f7f7f');
  });

  /**
   * A key this process holds acts on the mandate alone. The resolver and provider writes need a
   * signer holding those addresses, so they stay off the list rather than failing when called.
   */
  it('leaves the resolver and provider writes off the list, and says which signer they need', async () => {
    const node = createFakeNode();
    const context = createContext(
      loadConfig({ ...LOCAL, BURSAR_RESOLVER_ACCOUNT: '0x4444444444444444444444444444444444444444' }),
      { fetchFn: node.fetchFn, onDiagnostic: () => undefined },
    );

    const advertised = toolsFor(context).map((tool) => tool.name);

    expect(advertised).toContain('mandate_pay_provider');
    expect(advertised).toContain('resolver_status');
    expect(advertised).not.toContain('resolver_commit_score');

    const refused = JSON.parse(
      (await callTool(context, 'resolver_commit_score', { disputeId: 4, score: 70 })).text,
    ) as Record<string, unknown>;

    expect(refused['error']).toBe('relay_unconfigured');
    expect(refused['message']).toContain('the resolver address this server votes as');
  });
});

/**
 * The packaged entry point, spoken to over real pipes. This is the shape an MCP client runs, so it
 * catches the failures a linked-pair test cannot: a broken shebang, an import that resolves only in
 * the test runner, or anything written to stdout that is not protocol.
 */
describe('the stdio entry point', () => {
  it('starts, serves a tool list, and keeps stdout clean', async () => {
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url))],
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...ENV, PATH: process.env['PATH'] ?? '' },
      stderr: 'ignore',
    });

    try {
      await client.connect(transport);

      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name)).toContain('mandate_pay_provider');
    } finally {
      await client.close();
    }
  }, 60_000);

  it('refuses to start when it is handed a key, and says so on stderr', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url))],
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...ENV, AGENT_PRIVATE_KEY: `0x${'5c'.repeat(32)}`, PATH: process.env['PATH'] ?? '' },
      stderr: 'pipe',
    });

    await transport.start();

    const said = await new Promise<string>((resolve) => {
      let text = '';

      transport.stderr?.on('data', (chunk: Buffer) => {
        text += chunk.toString();
      });
      transport.onclose = (): void => resolve(text);
    });

    expect(said).toContain('does not take a key under a name something else may also be reading');
    expect(said).not.toContain('5c5c');
  }, 60_000);
});
