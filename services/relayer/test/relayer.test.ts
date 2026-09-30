import { encodeRelayData, withdrawalContext, type WireProof } from '@bursar/sdk';
import { BaseError, ContractFunctionRevertedError, parseEther, toFunctionSelector, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { handle, Relayer, RelayRefusal, type RelayerConfig } from '../src/index.js';

const RELAY: Address = '0xEb4978Cab69FF3B958f6Fd1B852C1Ae3d4Ba84f2';
const RELAYER: Address = '0xc8FB46218bA6750EBF8cE7Cc8f7a56D7C7F99630';
const RECIPIENT: Address = '0x88466ccD4688ddb6413DBBA420Af2B0696892388';
const BLOCKED: Address = '0x000000000000000000000000000000000000dEaD';
const ASP_ROOT = 777n;
const NULLIFIER = 555n;

const config: RelayerConfig = {
  chainId: 4663,
  relay: RELAY,
  pool: '0x9F9914dd397a9e9462Dd7cB6891Ab835119297C7',
  entrypoint: '0xADc02737378a86c0fB8231964C658A7AB81eeaa2',
  registry: '0xe10b6f6B275de231345c20D14Ab812db62151b00',
  scope: 869543705072628544128504902837391379516070938188476514926978342993992889566n,
  feeRecipient: RELAYER,
  feeBps: 50,
  gasDropWei: parseEther('0.00015'),
  gasDropsPerHour: 1,
  minWithdrawal: 10_000n,
};

function request(overrides: { recipient?: Address; feeBps?: bigint; feeRecipient?: Address; amount?: bigint; processooor?: Address; aspRoot?: bigint; context?: bigint; gasDrop?: boolean } = {}) {
  const withdrawal = {
    processooor: overrides.processooor ?? RELAY,
    data: encodeRelayData({
      recipient: overrides.recipient ?? RECIPIENT,
      feeRecipient: overrides.feeRecipient ?? RELAYER,
      relayFeeBPS: overrides.feeBps ?? 50n,
    }),
  };
  const context = overrides.context ?? withdrawalContext(withdrawal, config.scope);
  const signals = [1n, NULLIFIER, overrides.amount ?? 50_000n, 2n, 1n, overrides.aspRoot ?? ASP_ROOT, 1n, context];
  const proof: WireProof = { pA: ['1', '2'], pB: [['3', '4'], ['5', '6']], pC: ['7', '8'], pubSignals: signals.map(String) };
  return { withdrawal, proof, ...(overrides.gasDrop === undefined ? {} : { gasDrop: overrides.gasDrop }) };
}

function setup(state: { spent?: boolean; blocked?: Address[]; code?: Hex; balance?: bigint; revert?: string } = {}) {
  const client = {
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === 'isBlocked') return (state.blocked ?? []).includes(args![0] as Address);
      if (functionName === 'nullifierHashes') return state.spent ?? false;
      if (functionName === 'latestRoot') return ASP_ROOT;
      throw new Error(functionName);
    }),
    simulateContract: vi.fn(async (req: { value: bigint }) => {
      if (state.revert) {
        const cause = new ContractFunctionRevertedError({
          abi: [{ type: 'error', name: state.revert, inputs: [] }],
          data: toFunctionSelector(`${state.revert}()`),
          functionName: 'relay',
        });
        throw new BaseError('reverted', { cause });
      }
      return { request: req };
    }),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    getCode: vi.fn(async () => state.code),
    getBalance: vi.fn(async () => state.balance ?? 0n),
  };
  const wallet = { account: { address: RELAYER, type: 'local' }, writeContract: vi.fn(async () => `0x${'ab'.repeat(32)}` as Hex) };
  let now = 1_000_000;
  const relayer = new Relayer(client as never, wallet as never, {} as never, config, () => now);
  return { client, wallet, relayer, advance: (ms: number) => (now += ms) };
}

async function refusal(promise: Promise<unknown>): Promise<RelayRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RelayRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('relayer', () => {
  it('quotes its fee, fee recipient and gas drop', () => {
    expect(setup().relayer.quote()).toEqual({ relay: RELAY, feeRecipient: RELAYER, feeBps: 50, gasDropWei: '150000000000000', chainId: 4663 });
  });

  it('relays a valid withdrawal and sends gas to a fresh recipient', async () => {
    const { relayer, client, wallet } = setup();
    const result = await relayer.relay(request({ gasDrop: true }));
    expect(result).toEqual({ transactionHash: `0x${'ab'.repeat(32)}`, gasDropWei: '150000000000000' });
    expect(client.simulateContract.mock.calls[0]![0].value).toBe(parseEther('0.00015'));
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
  });

  it('sends no gas to a contract, a funded address, or when not asked', async () => {
    for (const state of [{ code: '0x6080' as Hex }, { balance: parseEther('0.001') }, {}]) {
      const { relayer } = setup(state);
      const asked = Object.keys(state).length > 0;
      expect((await relayer.relay(request({ gasDrop: asked }))).gasDropWei).toBe('0');
    }
  });

  it('rate-limits gas drops', async () => {
    const { relayer, advance } = setup();
    await relayer.relay(request({ gasDrop: true }));
    expect((await refusal(relayer.relay(request({ gasDrop: true })))).code).toBe('gas_drops_exhausted');
    advance(3_600_001);
    expect((await relayer.relay(request({ gasDrop: true }))).gasDropWei).toBe('150000000000000');
  });

  it.each([
    [{ processooor: RECIPIENT }, 'wrong_processooor'],
    [{ feeRecipient: RECIPIENT }, 'wrong_fee_recipient'],
    [{ feeBps: 10n }, 'fee_too_low'],
    [{ amount: 9_999n }, 'below_minimum'],
    [{ context: 1n }, 'context_mismatch'],
    [{ aspRoot: 1n }, 'stale_association_set'],
    [{ recipient: RELAY }, 'bad_recipient'],
    [{ recipient: config.pool }, 'bad_recipient'],
    [{ recipient: config.entrypoint }, 'bad_recipient'],
  ] as const)('refuses %o before sending', async (overrides, code) => {
    const { relayer, wallet } = setup();
    expect((await refusal(relayer.relay(request(overrides)))).code).toBe(code);
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it('refuses a blocked recipient without sending, so the note is untouched', async () => {
    const { relayer, wallet, client } = setup({ blocked: [BLOCKED] });
    const r = await refusal(relayer.relay(request({ recipient: BLOCKED })));
    expect([r.status, r.code]).toEqual([403, 'recipient_blocked']);
    expect(client.simulateContract).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it('refuses a spent note and a withdrawal the pool would reject', async () => {
    expect((await refusal(setup({ spent: true }).relayer.relay(request()))).code).toBe('already_spent');
    const r = await refusal(setup({ revert: 'InvalidProof' }).relayer.relay(request()));
    expect(r.code).toBe('would_revert');
    expect(r.message).toMatch(/InvalidProof/);
  });

  it('rejects malformed bodies', async () => {
    const { relayer } = setup();
    expect((await refusal(relayer.relay(null))).code).toBe('bad_request');
    expect((await refusal(relayer.relay({ withdrawal: { processooor: RELAY, data: '0x' }, proof: { pA: [] } }))).code).toBe('bad_proof');
    expect((await refusal(relayer.relay({ ...request(), gasDrop: 'yes' }))).code).toBe('bad_request');
  });

  it('maps refusals to HTTP replies', async () => {
    const { relayer } = setup({ spent: true });
    const health = async () => ({ ok: true });
    expect(await handle(relayer, 'POST', '/v1/relay', async () => request(), health)).toMatchObject({ status: 409, body: { error: 'already_spent' } });
    expect((await handle(relayer, 'GET', '/v1/quote', async () => null, health)).status).toBe(200);
    expect((await handle(relayer, 'GET', '/nope', async () => null, health)).status).toBe(404);
  });
});
