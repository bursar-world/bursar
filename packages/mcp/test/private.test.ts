import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isBursarError } from '@bursar/core';
import { agentHandoff, writeTerms } from '@bursar/sdk';
import type { AgentHandoff } from '@bursar/sdk';
import type { PrivatePayment } from '@bursar/sdk/agent';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig, secretsOf } from '../src/config.js';
import { createPrivateGateway } from '../src/private.js';
import { createContext } from '../src/server.js';
import { callTool, toolsFor } from '../src/tools.js';
import type { ToolContext } from '../src/tools.js';

// The pool these suites run against is the v2 record's, which stays in the address book whichever
// set answers for the chain. A newer record that has not recorded its own pool yet would otherwise
// take the shielded tools away mid-suite.
vi.mock('@bursar/core', async (original) => {
  const core = await original<typeof import('@bursar/core')>();
  return { ...core, privacyDeployment: () => core.DEPLOYMENTS['rhc-mainnet-v2'].privacy };
});

const KEY = `0x${'3b'.repeat(32)}` as const;
const AGENT = privateKeyToAccount(KEY).address;
const MANDATE: Address = '0x96f085Adc31984F1eE0F769798FA52465d39f56c';
const PAYEE: Address = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374';
const STRANGER: Address = '0x7062A480732EC7B0F00a3D0c968356e1671dd356';
const ESCROW = '0x8E298457cDFc1Cb9ef6253D36d3BD5cFEf10F915';
const NOW = 1_800_000_000;

const terms = writeTerms({
  perCallCap: 20_000n,
  periodCap: 30_000n,
  periodLen: 86_400,
  totalCap: 50_000n,
  capabilities: ['service:gpu.render:1'],
  counterparties: [PAYEE],
  expiry: NOW + 30 * 86_400,
  label: 'render budget',
});

const handoff = agentHandoff({ chainId: 4663, mandate: MANDATE, privateKey: KEY, terms, fromBlock: 75_627_494 });
const dir = mkdtempSync(join(tmpdir(), 'bursar-mcp-private-'));

function fileWith(content: unknown): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

const ENV = {
  RHC_RPC_PRIMARY: 'https://rpc.mainnet.chain.robinhood.com/k/primary-key',
  RHC_RPC_FALLBACK: 'https://fallback.example/rpc',
  MANDATE_ESCROW: ESCROW,
  BURSAR_SIGNER: 'local',
  BURSAR_AGENT_KEY_FILE: fileWith(handoff),
};

function failure(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    return { code: isBursarError(error) ? error.code : 'not_a_bursar_error', message: error instanceof Error ? error.message : '' };
  }
  return { code: 'no_error', message: '' };
}

describe('a private mandate key file', () => {
  it('binds the server to the mandate and the agent key the file names', () => {
    const config = loadConfig(ENV);

    expect(config.account).toBe(MANDATE);
    expect(config.signer).toEqual({ key: KEY });
    expect(config.privateMandate?.handoff.agent).toBe(AGENT);
    expect(secretsOf(config)).toContain(KEY);
    expect(loadConfig({ ...ENV, MANDATE_ACCOUNT: MANDATE.toLowerCase() }).account).toBe(MANDATE.toLowerCase());
  });

  it('is a key, so it needs BURSAR_SIGNER=local', () => {
    const { BURSAR_SIGNER: _signer, ...unsaid } = ENV;
    expect(failure(() => loadConfig(unsaid)).code).toBe('custody_refused');
    expect(failure(() => loadConfig({ ...ENV, BURSAR_SIGNER: 'relay' })).code).toBe('custody_refused');
  });

  it('refuses a second key, a relay, or a different mandate', () => {
    expect(failure(() => loadConfig({ ...ENV, BURSAR_SIGNER_KEY: `0x${'7f'.repeat(32)}` })).message).toMatch(/both name a key/u);
    expect(failure(() => loadConfig({ ...ENV, BURSAR_RELAY_URL: 'https://relay.example' })).message).toMatch(/both name a signer/u);
    expect(failure(() => loadConfig({ ...ENV, MANDATE_ACCOUNT: STRANGER })).code).toBe('config_mismatch');
  });

  it('refuses a file for another chain', () => {
    const other = fileWith({ ...handoff, chainId: 1 });
    expect(failure(() => loadConfig({ ...ENV, BURSAR_AGENT_KEY_FILE: other })).code).toBe('config_mismatch');
  });

  it('refuses a file whose key is not the agent it names, without quoting the key', () => {
    const edited = fileWith({ ...handoff, agent: STRANGER });
    const result = failure(() => loadConfig({ ...ENV, BURSAR_AGENT_KEY_FILE: edited }));

    expect(result.code).toBe('env_invalid');
    expect(result.message).toMatch(/not the agent it names/u);
    expect(result.message).not.toContain('3b3b');
  });

  it('refuses a file that is missing or not a key file', () => {
    expect(failure(() => loadConfig({ ...ENV, BURSAR_AGENT_KEY_FILE: join(dir, 'absent.json') })).message).toMatch(/could not be read/u);
    expect(failure(() => loadConfig({ ...ENV, BURSAR_AGENT_KEY_FILE: fileWith('{') })).code).toBe('env_invalid');
  });

  it('offers the private tools and none of the tools that read a public mandate', () => {
    const names = toolsFor(createContext(loadConfig(ENV))).map((tool) => tool.name);

    expect(names).toEqual(['private_mandate_inspect', 'private_mandate_pay', 'shielded_pool_status']);
  });
});

type Chain = { agent: Address; paused: boolean; revoked: boolean; gas: bigint };

function gatewayFor(chain: Partial<Chain> = {}, file: AgentHandoff = handoff) {
  const state: Chain = { agent: AGENT, paused: false, revoked: false, gas: 50_000_000_000_000n, ...chain };
  const payments: PrivatePayment[] = [];
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      const values: Record<string, unknown> = {
        agent: state.agent,
        paused: state.paused,
        revoked: state.revoked,
        nonce: 2n,
        version: 1n,
        settlementAsset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
        balanceOf: 30_000n,
        escrow: ESCROW,
        minLock: 10_000n,
      };
      if (!(functionName in values)) throw new Error(functionName);
      return values[functionName];
    },
    getBalance: async () => state.gas,
  };
  const gateway = createPrivateGateway({
    client: client as never,
    handoff: file,
    now: () => NOW,
    agentOf: () => ({
      address: AGENT,
      pay: async (payment: PrivatePayment) => {
        payments.push(payment);
        return { hash: `0x${'ab'.repeat(32)}`, escrowId: 12n, sealed: true, receipt: {} as never };
      },
    }),
  });
  const context: ToolContext = {
    gateway: null,
    resolver: null,
    provider: null,
    private: gateway,
    secrets: [KEY],
    canSign: { mandate: false, resolver: false, provider: false },
  };
  return { context, payments };
}

const parse = (result: { text: string }) => JSON.parse(result.text) as Record<string, unknown>;

describe('the private mandate tools', () => {
  it('reads the terms from the file and the state from the chain', async () => {
    const { context } = gatewayFor();
    const view = parse(await callTool(context, 'private_mandate_inspect', {}));

    expect(view).toMatchObject({
      mandate: MANDATE,
      agent: AGENT,
      agentMatchesFile: true,
      state: 'active',
      provenPayments: 2,
      balance: { usdg: '0.03' },
      agentGas: { enough: true },
      terms: { label: 'render budget', perPayment: { usdg: '0.02' }, period: '1 day', providers: [PAYEE], allowed: ['service'] },
    });
    expect(JSON.stringify(view)).not.toContain('3b3b');
  });

  it('pays through the prover under the class the capability belongs to', async () => {
    const { context, payments } = gatewayFor();
    const result = parse(
      await callTool(context, 'private_mandate_pay', {
        provider: PAYEE,
        capability: 'gpu.render:1',
        amount: '10000',
        task: 'Render one frame.',
        input: { frames: 1 },
      }),
    );

    expect(result).toMatchObject({ status: 'locked', settlementId: '12', briefSealed: true, capability: 'service:gpu.render:1' });
    expect(payments).toEqual([
      {
        payee: PAYEE,
        amount: 10_000n,
        capability: 'service:gpu.render:1',
        spec: { task: 'Render one frame.', acceptance: [], input: { frames: 1 } },
        spendClass: 'service',
        deliverWithin: 21_600,
      },
    ]);
  });

  it('refuses what the terms cannot prove before anything is sent', async () => {
    const { context, payments } = gatewayFor();
    const pay = (args: Record<string, unknown>) =>
      callTool(context, 'private_mandate_pay', { provider: PAYEE, capability: 'gpu.render:1', amount: '10000', task: 'Render.', ...args });

    expect(parse(await pay({ provider: STRANGER }))['error']).toBe('provider_not_allowed');
    expect(parse(await pay({ amount: '20001' }))['error']).toBe('over_per_payment_cap');
    expect(parse(await pay({ spendClass: 'hire' }))['error']).toBe('class_not_allowed');
    expect(parse(await pay({ capability: 'gpu.upscale:1' }))['error']).toBe('capability_not_allowed');
    expect(payments).toHaveLength(0);
  });

  it('refuses a payment the escrow will not lock before proving it', async () => {
    const { context, payments } = gatewayFor();
    const refusal = parse(
      await callTool(context, 'private_mandate_pay', { provider: PAYEE, capability: 'gpu.render:1', amount: '9999', task: 'Render.' }),
    );

    expect(refusal['error']).toBe('below_lock_floor');
    expect(refusal['message']).toContain('no payment under 0.01 USDG');
    expect(payments).toHaveLength(0);
  });

  it('says when the agent has no gas, the owner stopped the mandate, or moved it to another agent', async () => {
    const pay = async (chain: Partial<Chain>) =>
      parse(
        await callTool(gatewayFor(chain).context, 'private_mandate_pay', {
          provider: PAYEE,
          capability: 'gpu.render:1',
          amount: '10000',
          task: 'Render.',
        }),
      )['error'];

    expect(await pay({ gas: 0n })).toBe('agent_needs_gas');
    expect(await pay({ paused: true })).toBe('mandate_paused');
    expect(await pay({ revoked: true })).toBe('mandate_revoked');
    expect(await pay({ agent: STRANGER })).toBe('agent_replaced');
  });

  it('is not offered to a server bound to no private mandate', async () => {
    const { context } = gatewayFor();
    const bare: ToolContext = { ...context, private: null };

    expect(toolsFor(bare)).toEqual([]);
    expect(parse(await callTool(bare, 'private_mandate_inspect', {}))['error']).toBe('private_mandate_unconfigured');
  });
});

describe('the history behind a private mandate', () => {
  it('serves the mandate’s logs from the index when the endpoint refuses the range', async () => {
    const { withIndexedHistory } = await import('../src/private.js');
    const refused = new Error('ranges over 10000 blocks are not supported on free plan');
    const seen: unknown[] = [];
    const client = {
      readContract: async () => 1n,
      getLogs: async (args: unknown) => {
        seen.push(args);
        throw refused;
      },
    };
    const row = (block: bigint, index: number) => ({
      address: MANDATE,
      topics: [`0x${'11'.repeat(32)}`] as `0x${string}`[],
      data: '0x' as const,
      blockNumber: block,
      transactionHash: `0x${'22'.repeat(32)}` as const,
      logIndex: index,
    });
    const index = {
      logsOf: async () => ({ logs: [row(120n, 1), row(120n, 0), row(90n, 0), row(50n, 0)], oldestBlock: 50n, truncated: false }),
    };
    const reader = withIndexedHistory(client as never, index);

    const logs = (await reader.getLogs({ address: MANDATE, fromBlock: 60n, toBlock: 'latest' })) as { blockNumber: bigint; logIndex: number }[];
    expect(logs.map((log) => [log.blockNumber, log.logIndex])).toEqual([[90n, 0], [120n, 0], [120n, 1]]);
    expect(seen).toHaveLength(1);
    // Every other read goes straight through.
    expect(await reader.readContract({} as never)).toBe(1n);
  });

  it('keeps the endpoint’s own refusal when the index cannot serve either', async () => {
    const { withIndexedHistory } = await import('../src/private.js');
    const refused = new Error('ranges over 10000 blocks are not supported on free plan');
    const client = { getLogs: async () => { throw refused; } };
    const index = { logsOf: async () => { throw new Error('history_key_missing'); } };
    await expect(withIndexedHistory(client as never, index).getLogs({ address: MANDATE, fromBlock: 0n, toBlock: 'latest' } as never)).rejects.toBe(refused);
  });
});
