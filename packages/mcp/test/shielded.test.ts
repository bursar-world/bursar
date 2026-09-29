import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isBursarError, privacyDeployment } from '@bursar/core';
import {
  decodeRelayData,
  depositSecrets,
  deriveShieldedKeys,
  labelOf,
  leanRoot,
  noteOf,
  precommitmentOf,
  withdrawalContext,
} from '@bursar/sdk';
import type { Note, PoolEvents, RelayRequest, ShieldedKeys } from '@bursar/sdk';
import type { Address, Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, secretsOf } from '../src/config.js';
import { createContext } from '../src/server.js';
import { createShieldedGateway, grossUp } from '../src/shielded.js';
import type { WithdrawalProver } from '../src/shielded.js';
import { callTool, toolsFor } from '../src/tools.js';
import type { ToolContext } from '../src/tools.js';

const deployment = privacyDeployment(4663)?.shielded;
if (deployment === undefined) throw new Error('the 4663 record has no shielded pool');
const D = deployment;

const keys = deriveShieldedKeys(`0x${'ab'.repeat(32)}${'cd'.repeat(32)}1b`);
const scope = BigInt(D.scope);
const DEPOSITOR: Address = '0x877c349EFb5926082C413833E8055F0991185c61';
const BLOCKED: Address = '0x000000000000000000000000000000000000dEaD';
const RECIPIENT: Address = '0x88466ccD4688ddb6413DBBA420Af2B0696892388';
const RELAYER_URL = 'https://relayer.example';
const TX: Hex = `0x${'ef'.repeat(32)}`;

const s0 = depositSecrets(keys, scope, 0n);
const s1 = depositSecrets(keys, scope, 1n);
const big = noteOf(100_000n, labelOf(scope, 1n), s0);
const small = noteOf(30_000n, labelOf(scope, 2n), s1);

const deposit = (note: Note, precommitment: bigint, depositor: Address = DEPOSITOR, logIndex = 0) => ({
  depositor,
  commitment: note.commitment,
  label: note.label,
  value: note.value,
  precommitment,
  blockNumber: 10n,
  transactionHash: `0x${'00'.repeat(32)}` as Hex,
  logIndex,
});

// The first deposit's depositor is the one a test may block, which drops it from the rebuilt set.
const FIRST: Address = '0x7062A480732EC7B0F00a3D0c968356e1671dd356';
const events: PoolEvents = {
  deposits: [deposit(big, precommitmentOf(s0), FIRST), deposit(small, precommitmentOf(s1), DEPOSITOR, 1)],
  withdrawals: [],
  ragequits: [],
  leaves: [big.commitment, small.commitment],
  toBlock: 20n,
};

type World = { root: bigint | null; blocked: Address[]; quote: Record<string, unknown> };

function setup(overrides: Partial<World> = {}, relayerUrl: string | null = RELAYER_URL) {
  const world: World = {
    root: leanRoot([big.label, small.label]),
    blocked: [],
    quote: { relay: D.ShieldedRelay, feeRecipient: D.relayer, feeBps: 100, gasDropWei: '150000000000000', chainId: 4663 },
    ...overrides,
  };
  const client = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === 'latestRoot') {
        if (world.root === null) throw new Error('NoRootsAvailable');
        return world.root;
      }
      if (functionName === 'isBlocked') return world.blocked.includes(args?.[0] as Address);
      const values: Record<string, unknown> = { dead: false, MAX_DEPOSIT: 100_000_000n, MAX_TOTAL: 1_000_000_000n, balanceOf: 130_000n };
      if (!(functionName in values)) throw new Error(functionName);
      return values[functionName];
    },
    getLogs: async () => [{ args: { _root: world.root, _timestamp: 1_800_000_000n } }],
  };
  const relayed: RelayRequest[] = [];
  vi.stubGlobal('fetch', async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/quote') return Response.json(world.quote);
    if (path === '/v1/relay') {
      relayed.push(JSON.parse(String(init?.body)) as RelayRequest);
      return Response.json({ transactionHash: TX, gasDropWei: '150000000000000' });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  });
  const proven: Parameters<WithdrawalProver>[0][] = [];
  const prove: WithdrawalProver = async (args) => {
    proven.push(args);
    const change = noteOf(args.note.value - args.amount, args.note.label, args.change);
    return {
      proof: { pA: [1n, 2n], pB: [[3n, 4n], [5n, 6n]], pC: [7n, 8n], pubSignals: [change.commitment, 0n, args.amount, 0n, 0n, 0n, 0n, args.context] },
      change,
    };
  };
  const gateway = createShieldedGateway({
    client: client as never,
    chainId: 4663,
    deployment: D,
    keys,
    relayerUrl,
    aspUrl: null,
    loadEvents: async () => events,
    prove,
  });
  const context: ToolContext = {
    gateway: null,
    resolver: null,
    provider: null,
    shielded: gateway,
    secrets: [keys.masterNullifier.toString(), keys.masterSecret.toString()],
    canSign: { mandate: false, resolver: false, provider: false },
  };
  return { context, relayed, proven };
}

const parse = (result: { text: string }) => JSON.parse(result.text) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the shielded key file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bursar-mcp-shielded-'));
  const fileWith = (content: unknown) => {
    const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
    return path;
  };
  const good = (k: ShieldedKeys = keys) => ({
    kind: 'bursar-shielded-keys',
    version: 1,
    chainId: 4663,
    pool: D.ShieldedPool,
    masterNullifier: k.masterNullifier.toString(),
    masterSecret: k.masterSecret.toString(),
  });
  const ENV = { RHC_RPC_PRIMARY: 'https://rpc.mainnet.chain.robinhood.com/k/primary-key', RHC_RPC_FALLBACK: 'https://fallback.example/rpc' };
  const code = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return isBursarError(error) ? error.code : 'not_a_bursar_error';
    }
    return 'no_error';
  };

  it('binds a server on its own and keeps the keys out of every reply', () => {
    const config = loadConfig({ ...ENV, BURSAR_SHIELDED_KEY_FILE: fileWith(good()) });

    expect(config.account).toBeNull();
    expect(config.shielded?.keys).toEqual(keys);
    expect(secretsOf(config)).toContain(keys.masterSecret.toString());
    expect(toolsFor(createContext(config)).map((t) => t.name)).toEqual(['shielded_pool_status', 'shielded_balance']);

    const withRelayer = loadConfig({ ...ENV, BURSAR_SHIELDED_KEY_FILE: fileWith(good()), BURSAR_RELAYER_URL: RELAYER_URL });
    expect(toolsFor(createContext(withRelayer)).map((t) => t.name)).toEqual(['shielded_pool_status', 'shielded_balance', 'shielded_pay']);
  });

  it('refuses a file for another chain or pool, or one that is not a key file', () => {
    expect(code(() => loadConfig({ ...ENV, BURSAR_SHIELDED_KEY_FILE: fileWith({ ...good(), chainId: 1 }) }))).toBe('config_mismatch');
    expect(code(() => loadConfig({ ...ENV, BURSAR_SHIELDED_KEY_FILE: fileWith({ ...good(), pool: RECIPIENT }) }))).toBe('config_mismatch');
    expect(code(() => loadConfig({ ...ENV, BURSAR_SHIELDED_KEY_FILE: fileWith({ ...good(), kind: 'other' }) }))).toBe('env_invalid');
    expect(code(() => loadConfig({ ...ENV, BURSAR_SHIELDED_KEY_FILE: fileWith({ ...good(), masterSecret: '0x12' }) }))).toBe('env_invalid');
    expect(code(() => loadConfig({ ...ENV, BURSAR_SHIELDED_KEY_FILE: join(dir, 'absent.json') }))).toBe('env_invalid');
  });

  it('still needs some role when there is no file', () => {
    expect(code(() => loadConfig(ENV))).toBe('env_invalid');
  });
});

describe('the shielded tools', () => {
  it('reads the pool', async () => {
    const view = parse(await callTool(setup().context, 'shielded_pool_status', {}));

    expect(view).toMatchObject({
      pool: D.ShieldedPool,
      open: true,
      balance: { usdg: '0.13' },
      caps: { perDeposit: { usdg: '100.00' }, poolTotal: { usdg: '1000.00' } },
      associationSet: { root: leanRoot([big.label, small.label]).toString(), index: 0, postedAt: '2027-01-15T08:00:00Z' },
      relayer: { feeBps: 100, gasDropEth: '0.00015' },
    });
  });

  it('says when no root has been posted', async () => {
    const view = parse(await callTool(setup({ root: null }).context, 'shielded_pool_status', {}));
    expect(view['associationSet']).toBeNull();
  });

  it('splits the balance into approved and awaiting approval, rebuilding the set the root covers', async () => {
    // The provider has posted only the first deposit so far.
    const view = parse(await callTool(setup({ root: leanRoot([big.label]) }).context, 'shielded_balance', {}));

    expect(view).toMatchObject({ spendable: { usdg: '0.10' }, awaitingApproval: { usdg: '0.03' } });
    expect(view['notes']).toEqual([
      { label: big.label.toString(), value: { micro: '100000', usdg: '0.10' }, approved: true },
      { label: small.label.toString(), value: { micro: '30000', usdg: '0.03' }, approved: false },
    ]);
    expect(JSON.stringify(view)).not.toContain(keys.masterSecret.toString());
  });

  it('pays from the smallest covering deposit through the relayer, the fee on top', async () => {
    const { context, relayed, proven } = setup();
    const result = parse(await callTool(context, 'shielded_pay', { recipient: RECIPIENT, amount: '20000', gasDrop: true }));

    expect(result).toMatchObject({
      status: 'sent',
      txHash: TX,
      received: { micro: '20000' },
      relayerFee: { micro: '202' },
      withdrawn: { micro: '20202' },
      gasDropEth: '0.00015',
      leftInNote: { micro: '9798' },
    });
    expect(proven[0]?.note.label).toBe(small.label);
    expect(proven[0]?.aspLabels).toEqual([big.label, small.label]);

    const request = relayed[0]!;
    expect(request.gasDrop).toBe(true);
    expect(request.withdrawal.processooor).toBe(D.ShieldedRelay);
    expect(decodeRelayData(request.withdrawal.data)).toEqual({ recipient: RECIPIENT, feeRecipient: D.relayer, relayFeeBPS: 100n });
    expect(proven[0]?.context).toBe(withdrawalContext(request.withdrawal, scope));
  });

  it('refuses what one deposit cannot cover, or a deposit not approved yet', async () => {
    expect(parse(await callTool(setup().context, 'shielded_pay', { recipient: RECIPIENT, amount: '100000' }))['error']).toBe(
      'amount_above_note',
    );
    const pending = setup({ root: leanRoot([small.label]), blocked: [FIRST] });
    expect(parse(await callTool(pending.context, 'shielded_pay', { recipient: RECIPIENT, amount: '50000' }))['error']).toBe(
      'note_not_approved',
    );
    expect(pending.relayed).toHaveLength(0);
  });

  it('refuses a blocked recipient, a stale set, and a relayer for another contract', async () => {
    const pay = (world: Partial<World>) =>
      callTool(setup(world).context, 'shielded_pay', { recipient: RECIPIENT, amount: '1000' }).then((r) => parse(r)['error']);

    expect(await pay({ blocked: [RECIPIENT] })).toBe('recipient_blocked');
    expect(await pay({ root: 12345n })).toBe('association_set_unavailable');
    expect(await pay({ quote: { relay: BLOCKED, feeRecipient: D.relayer, feeBps: 0, gasDropWei: '0', chainId: 4663 } })).toBe(
      'relayer_mismatch',
    );
  });

  it('never pays without a relayer', async () => {
    const { context, relayed } = setup({}, null);

    expect(toolsFor(context).map((t) => t.name)).toEqual(['shielded_pool_status', 'shielded_balance']);
    expect(parse(await callTool(context, 'shielded_pay', { recipient: RECIPIENT, amount: '1000' }))['error']).toBe(
      'relayer_unconfigured',
    );
    expect(relayed).toHaveLength(0);
  });

  it('says so when no float is configured', async () => {
    const { context } = setup();
    const bare: ToolContext = { ...context, shielded: { ...context.shielded!, float: null } };
    expect(parse(await callTool(bare, 'shielded_balance', {}))['error']).toBe('shielded_unconfigured');
  });
});

describe('grossUp', () => {
  it('leaves the recipient at least the amount after the fee', () => {
    for (const bps of [0n, 1n, 100n, 500n, 9_999n]) {
      for (const amount of [1n, 999n, 20_000n, 123_456_789n]) {
        const gross = grossUp(amount, bps);
        expect(gross - (gross * bps) / 10_000n).toBeGreaterThanOrEqual(amount);
        expect(gross - 1n - ((gross - 1n) * bps) / 10_000n).toBeLessThan(amount);
      }
    }
  });
});
