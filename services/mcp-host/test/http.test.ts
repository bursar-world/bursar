import { assistantConnectMessage, assistantDisconnectMessage } from '@bursar/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';

import { createConnectionService } from '../src/connections.js';
import type { CreatedConnection } from '../src/connections.js';
import { TOKEN_PATTERN, hashToken } from '../src/crypto.js';
import { createHttpServer, listen } from '../src/http.js';
import type { RunningServer } from '../src/http.js';
import { createMemoryStore } from '../src/store.js';
import { fakeContexts, fakeReads } from './support/fakes.js';

/** The whole surface, over a real socket, against a memory store and a fake chain. */

const KEK = `0x${'ab'.repeat(32)}` as const;
const owner = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
const MANDATE_A = '0x00000000000000000000000000000000000acc01' as const;
const MANDATE_B = '0x00000000000000000000000000000000000acc02' as const;

let running: RunningServer | null = null;
const logged: string[] = [];

afterEach(async () => {
  await running?.close();
  running = null;
  logged.length = 0;
});

async function start(tokenRpm = 120) {
  const store = createMemoryStore();
  const contexts = fakeContexts((key) => privateKeyToAccount(key).address, new Set([MANDATE_A, MANDATE_B]));
  const service = createConnectionService({
    store,
    contexts,
    reads: fakeReads({ [MANDATE_A]: owner.address, [MANDATE_B]: other.address }),
    chainId: 4663,
    kek: KEK,
    publicUrl: 'https://mcp.test',
    proofWindowSeconds: 600,
    connectionsPerHour: 20,
  });
  const server = createHttpServer({
    service,
    chainId: 4663,
    publicUrl: 'https://mcp.test',
    tokenRpm,
    log: (line) => logged.push(line),
    health: async () => ({ status: 'ok' }),
    ready: async () => ({ ready: true, checks: {} }),
  });
  running = await listen(server, '127.0.0.1', 0);
  return { url: `http://127.0.0.1:${running.port}`, store, contexts };
}

async function connect(url: string, mandate: Address, by = owner, label?: string): Promise<Response> {
  const fields = {
    mandate,
    owner: by.address,
    chainId: 4663,
    nonce: `0x${randomBytes(16).toString('hex')}` as Hex,
    issuedAt: new Date().toISOString(),
    ...(label === undefined ? {} : { label }),
  };
  const signature = await by.signMessage({ message: assistantConnectMessage(fields) });
  return fetch(`${url}/connections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...fields, signature }),
  });
}

async function mcpClient(url: string, token: string, inPath = false): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(inPath ? `${url}/mcp/${token}` : `${url}/mcp`), {
    ...(inPath ? {} : { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

describe('opening a connection', () => {
  it('issues a token once, binds it to the mandate, and keeps only its hash', async () => {
    const { url, store } = await start();
    const response = await connect(url, MANDATE_A, owner, 'Claude');
    expect(response.status).toBe(201);
    const created = (await response.json()) as CreatedConnection;

    expect(created.token).toMatch(TOKEN_PATTERN);
    expect(created.connection.mandate.toLowerCase()).toBe(MANDATE_A);
    expect(created.connection.owner).toBe(owner.address);
    expect(created.connection.label).toBe('Claude');
    expect(created.connection.agent).toMatch(/^0x[0-9a-fA-F]{40}$/u);
    expect(created.settings.endpoint).toBe('https://mcp.test/mcp');
    expect(created.settings.endpointWithToken).toBe(`https://mcp.test/mcp/${created.token}`);
    expect(created.settings.claudeCode.command).toContain(`Bearer ${created.token}`);

    const stored = await store.byTokenHash(hashToken(created.token));
    expect(stored?.agent).toBe(created.connection.agent.toLowerCase());
    expect(JSON.stringify(stored)).not.toContain(created.token);
    expect(logged.join('\n')).not.toContain(created.token);

    const listed = (await (await fetch(`${url}/connections?mandate=${MANDATE_A}`)).json()) as { connections: { id: string; agent: string }[] };
    expect(listed.connections.map((c) => c.id)).toEqual([created.connection.id]);
    expect(JSON.stringify(listed)).not.toContain(created.token);
  });

  it('refuses a signature by someone who does not own the mandate, and a reused one', async () => {
    const { url } = await start();
    expect((await connect(url, MANDATE_A, other)).status).toBe(403);

    const fields = { mandate: MANDATE_A, owner: owner.address, chainId: 4663, nonce: `0x${randomBytes(16).toString('hex')}` as Hex, issuedAt: new Date().toISOString() };
    const signature = await owner.signMessage({ message: assistantConnectMessage(fields) });
    const body = JSON.stringify({ ...fields, signature });
    const first = await fetch(`${url}/connections`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const second = await fetch(`${url}/connections`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });
});

describe('the MCP endpoint', () => {
  it('serves the tool set bound to the token’s mandate, with its signer, over a bearer header or the path', async () => {
    const { url, contexts } = await start();
    const a = (await (await connect(url, MANDATE_A)).json()) as CreatedConnection;
    const b = (await (await connect(url, MANDATE_B, other)).json()) as CreatedConnection;

    const clientA = await mcpClient(url, a.token);
    const { tools } = await clientA.listTools();
    expect(tools.map((tool) => tool.name)).toContain('mandate_pay_provider');
    expect(tools.map((tool) => tool.name)).toContain('mandate_inspect');

    const viewA = await clientA.callTool({ name: 'mandate_inspect', arguments: {} });
    const textA = (viewA.content as { text: string }[])[0]?.text ?? '';
    expect(JSON.parse(textA)).toMatchObject({ account: a.connection.mandate, agent: a.connection.agent });

    const clientB = await mcpClient(url, b.token, true);
    const viewB = await clientB.callTool({ name: 'mandate_inspect', arguments: {} });
    const textB = (viewB.content as { text: string }[])[0]?.text ?? '';
    expect(JSON.parse(textB)).toMatchObject({ account: b.connection.mandate, agent: b.connection.agent });
    expect(textB).not.toContain(a.connection.mandate);

    // Each token was bound once, to its own mandate, with the key that signs as its own agent.
    expect(contexts.built.map((built) => [built.mandate, built.agent])).toEqual([
      [a.connection.mandate, a.connection.agent],
      [b.connection.mandate, b.connection.agent],
    ]);
    await clientA.close();
    await clientB.close();
  });

  it('refuses a missing, unknown, malformed or revoked token', async () => {
    const { url } = await start();
    const none = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('Bearer');

    const unknown = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: `Bearer bmcp_${'A'.repeat(43)}` }, body: '{}' });
    expect(unknown.status).toBe(401);
    const malformed = await fetch(`${url}/mcp/not-a-token`, { method: 'POST', body: '{}' });
    expect(malformed.status).toBe(401);

    const created = (await (await connect(url, MANDATE_A)).json()) as CreatedConnection;
    const fields = { mandate: MANDATE_A, owner: owner.address, chainId: 4663, nonce: `0x${randomBytes(16).toString('hex')}` as Hex, issuedAt: new Date().toISOString(), connection: created.connection.id };
    const signature = await owner.signMessage({ message: assistantDisconnectMessage(fields) });
    const revoked = await fetch(`${url}/connections/${created.connection.id}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...fields, signature }),
    });
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { connection: { status: string } }).connection.status).toBe('revoked');

    const after = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(after.status).toBe(401);
    expect(((await after.json()) as { error: string }).error).toBe('token_revoked');
  });

  it('caps requests per token', async () => {
    const { url } = await start(2);
    const created = (await (await connect(url, MANDATE_A)).json()) as CreatedConnection;
    // Connecting is two requests: initialize, then the initialized notification.
    const client = await mcpClient(url, created.token);
    const third = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toMatch(/^\d+$/u);
    await client.close();
  });
});

describe('probes', () => {
  it('answer without a token', async () => {
    const { url } = await start();
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/readyz`)).status).toBe(200);
    expect((await fetch(`${url}/nothing`)).status).toBe(404);
  });
});
