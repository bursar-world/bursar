import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeRelayData, shieldedPoolAbi, withdrawalContext, type WireProof } from '@bursar/sdk';
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeEventTopics,
  parseEther,
  parseUnits,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { GAS_DROP_WINDOW_MS, GasDropLedger, handle, Relayer, RelayRefusal, type RelayerConfig } from '../src/index.js';

const RELAY: Address = '0xEb4978Cab69FF3B958f6Fd1B852C1Ae3d4Ba84f2';
const RELAYER: Address = '0xc8FB46218bA6750EBF8cE7Cc8f7a56D7C7F99630';
const RECIPIENT: Address = '0x88466ccD4688ddb6413DBBA420Af2B0696892388';
const OTHER: Address = '0x1111111111111111111111111111111111111111';
const BLOCKED: Address = '0x000000000000000000000000000000000000dEaD';
const ASP_ROOT = 777n;
const NULLIFIER = 555n;
const RELAY_HASH = `0x${'ab'.repeat(32)}` as Hex;
const DROP_HASH = `0x${'cd'.repeat(32)}` as Hex;
const DROP = parseEther('0.00015');
/** 50 USDG: large enough for a drop to fit under the relay's fee cap. */
const AMOUNT = 50_000_000n;
/** Robinhood Chain's base fee on an ordinary day, 0.031 gwei. */
const GAS_PRICE = 31_362_000n;
/** At 2,000 USDG per ETH the drop is 0.3 USDG; with the transfer that carries it at GAS_PRICE, 0.301318. */
const DROP_FEE = 300_000n;
const QUOTED_DROP_FEE = '301318';
/** 50 bps of AMOUNT is 0.25 USDG; the drop on top is 0.55 USDG, which is 110 bps of AMOUNT. */
const GAS_FEE_BPS = 110n;

const config: RelayerConfig = {
  chainId: 4663,
  relay: RELAY,
  pool: '0x9F9914dd397a9e9462Dd7cB6891Ab835119297C7',
  entrypoint: '0xADc02737378a86c0fB8231964C658A7AB81eeaa2',
  registry: '0xe10b6f6B275de231345c20D14Ab812db62151b00',
  scope: 869543705072628544128504902837391379516070938188476514926978342993992889566n,
  feeRecipient: RELAYER,
  feeBps: 50,
  gasDropWei: DROP,
  gasDropsPerDay: 2,
  ethPrice: parseUnits('2000', 6),
  minWithdrawal: 10_000n,
};

const fileLedger = (now: () => number) => new GasDropLedger(join(mkdtempSync(join(tmpdir(), 'relayer-')), 'gas-drops.jsonl'), now);

type Overrides = {
  recipient?: Address;
  feeBps?: bigint;
  feeRecipient?: Address;
  amount?: bigint;
  processooor?: Address;
  aspRoot?: bigint;
  context?: bigint;
  gasDrop?: boolean;
  nullifier?: bigint;
};

/** A withdrawal of AMOUNT at the relayer's fee, or at the fee that also pays for a drop when it asks for gas. */
function request(overrides: Overrides = {}) {
  const withdrawal = {
    processooor: overrides.processooor ?? RELAY,
    data: encodeRelayData({
      recipient: overrides.recipient ?? RECIPIENT,
      feeRecipient: overrides.feeRecipient ?? RELAYER,
      relayFeeBPS: overrides.feeBps ?? (overrides.gasDrop ? GAS_FEE_BPS : 50n),
    }),
  };
  const context = overrides.context ?? withdrawalContext(withdrawal, config.scope);
  const signals = [1n, overrides.nullifier ?? NULLIFIER, overrides.amount ?? AMOUNT, 2n, 1n, overrides.aspRoot ?? ASP_ROOT, 1n, context];
  const proof: WireProof = { pA: ['1', '2'], pB: [['3', '4'], ['5', '6']], pC: ['7', '8'], pubSignals: signals.map(String) };
  return { withdrawal, proof, ...(overrides.gasDrop === undefined ? {} : { gasDrop: overrides.gasDrop }) };
}

/** The pool's Withdrawn event for one spent note, as it sits in a receipt. */
function withdrawn(nullifier: bigint, address: Address = config.pool) {
  return {
    address,
    topics: encodeEventTopics({ abi: shieldedPoolAbi, eventName: 'Withdrawn', args: { _processooor: RELAY } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [AMOUNT, nullifier, 1n]),
    blockNumber: 1n,
    blockHash: `0x${'bb'.repeat(32)}` as Hex,
    transactionHash: RELAY_HASH,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

type State = {
  spent?: boolean;
  blocked?: Address[];
  code?: Hex;
  balance?: bigint;
  nonce?: number;
  revert?: string;
  /** What the relay receipt shows. `event` is the Withdrawn log for the note the request spent. */
  receipt?: 'event' | 'no-event' | 'other-contract' | 'reverted';
  dropFails?: boolean;
  ledger?: GasDropLedger;
  gasPrice?: bigint;
  config?: Partial<RelayerConfig>;
};

function setup(state: State = {}) {
  let now = 1_000_000;
  const drops = state.ledger ?? fileLedger(() => now);
  let spentNullifier = 0n;
  const client = {
    getGasPrice: vi.fn(async () => state.gasPrice ?? GAS_PRICE),
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === 'isBlocked') return (state.blocked ?? []).includes(args![0] as Address);
      if (functionName === 'nullifierHashes') return state.spent ?? false;
      if (functionName === 'latestRoot') return ASP_ROOT;
      throw new Error(functionName);
    }),
    simulateContract: vi.fn(async (req: { args: readonly [unknown, { pubSignals: readonly bigint[] }] }) => {
      if (state.revert) {
        const cause = new ContractFunctionRevertedError({
          abi: [{ type: 'error', name: state.revert, inputs: [] }],
          data: toFunctionSelector(`${state.revert}()`),
          functionName: 'relay',
        });
        throw new BaseError('reverted', { cause });
      }
      spentNullifier = req.args[1].pubSignals[1]!;
      return { request: req };
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      if (hash !== RELAY_HASH) return { status: 'success', logs: [] };
      const shows = state.receipt ?? 'event';
      if (shows === 'reverted') return { status: 'reverted', logs: [] };
      if (shows === 'no-event') return { status: 'success', logs: [] };
      return { status: 'success', logs: [withdrawn(spentNullifier, shows === 'other-contract' ? OTHER : config.pool)] };
    }),
    getCode: vi.fn(async () => state.code),
    getBalance: vi.fn(async () => state.balance ?? 0n),
    getTransactionCount: vi.fn(async () => state.nonce ?? 0),
  };
  const wallet = {
    account: { address: RELAYER, type: 'local' },
    writeContract: vi.fn(async () => RELAY_HASH),
    sendTransaction: vi.fn(async (_transfer: { to: Address; value: bigint }) => {
      if (state.dropFails) throw new Error('insufficient funds for gas * price + value');
      return DROP_HASH;
    }),
  };
  const logged: string[] = [];
  const relayer = new Relayer(client as never, wallet as never, {} as never, { ...config, ...state.config }, drops, (line) => logged.push(line));
  return { client, wallet, relayer, drops, logged, advance: (ms: number) => (now += ms) };
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
  it('quotes its fee, fee recipient, gas drop, and what a drop adds to the fee at the current gas price', async () => {
    expect(await setup().relayer.quote()).toEqual({
      relay: RELAY,
      feeRecipient: RELAYER,
      feeBps: 50,
      gasDropWei: '150000000000000',
      chainId: 4663,
      gasDropFee: QUOTED_DROP_FEE,
    });
    // Twice the gas price: the 0.3 USDG drop is the same, the transfer that carries it costs twice as much.
    expect((await setup({ gasPrice: GAS_PRICE * 2n }).relayer.quote()).gasDropFee).toBe('302635');

    const off = setup({ config: { gasDropWei: 0n } });
    expect(await off.relayer.quote()).toMatchObject({ gasDropWei: '0', gasDropFee: '0' });
    expect(off.client.getGasPrice).not.toHaveBeenCalled();
  });

  it('refuses to start with gas drops on but nothing to keep the budget or price the drop', () => {
    const start = (overrides: Partial<RelayerConfig>, ledger: GasDropLedger) =>
      new Relayer({} as never, {} as never, {} as never, { ...config, ...overrides }, ledger);

    expect(() => start({}, new GasDropLedger(null))).toThrow(/RELAYER_DATA_DIR/);
    expect(() => start({ ethPrice: 0n }, fileLedger(Date.now))).toThrow(/RELAYER_ETH_PRICE_USDG/);
    // With drops off, neither is needed.
    expect(start({ gasDropWei: 0n, ethPrice: 0n }, new GasDropLedger(null))).toBeInstanceOf(Relayer);
    expect(start({ gasDropsPerDay: 0, ethPrice: 0n }, new GasDropLedger(null))).toBeInstanceOf(Relayer);
  });

  it('relays a valid withdrawal without sending value along with it', async () => {
    const { relayer, client, wallet } = setup();
    const result = await relayer.relay(request());
    expect(result).toEqual({ transactionHash: RELAY_HASH, gasDropWei: '0' });
    expect(client.simulateContract.mock.calls[0]![0]).not.toHaveProperty('value');
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
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

  it('rejects malformed bodies with fixed wording', async () => {
    const { relayer } = setup();
    expect((await refusal(relayer.relay(null))).code).toBe('bad_request');
    const proof = await refusal(relayer.relay({ withdrawal: { processooor: RELAY, data: '0x' }, proof: { pA: [] } }));
    expect(proof.code).toBe('bad_proof');
    expect(proof.message).toBe('The proof is malformed: pA and pC hold two decimal field elements, pB is two by two, and pubSignals is a list.');
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

describe('gas drops', () => {
  it('sends a fresh recipient gas once its withdrawal has landed, as a second transaction', async () => {
    const { relayer, client, wallet, drops } = setup();
    const result = await relayer.relay(request({ gasDrop: true }));
    expect(result).toEqual({ transactionHash: RELAY_HASH, gasDropWei: DROP.toString(), gasDropTransactionHash: DROP_HASH });
    expect(client.simulateContract.mock.calls[0]![0]).not.toHaveProperty('value');
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
    expect(wallet.sendTransaction.mock.calls[0]![0]).toMatchObject({ to: RECIPIENT, value: DROP });
    // The relay landed before the gas went out.
    expect(wallet.writeContract.mock.invocationCallOrder[0]).toBeLessThan(wallet.sendTransaction.mock.invocationCallOrder[0]!);
    expect(client.waitForTransactionReceipt.mock.invocationCallOrder[0]).toBeLessThan(wallet.sendTransaction.mock.invocationCallOrder[0]!);
    expect(drops.hasNote(NULLIFIER)).toBe(true);
    expect(drops.hasRecipient(RECIPIENT)).toBe(true);
    expect(drops.countToday()).toBe(1);
  });

  it('makes the withdrawal pay for its drop: the plain fee is refused with gas, before anything is sent', async () => {
    const { relayer, wallet } = setup();
    const refused = await refusal(relayer.relay(request({ gasDrop: true, feeBps: 50n })));
    expect([refused.status, refused.code]).toEqual([400, 'fee_too_low']);
    expect(refused.message).toContain(`50 basis points plus ${DROP_FEE} atomic USDG, which is ${GAS_FEE_BPS} basis points`);
    expect((await refusal(relayer.relay(request({ gasDrop: true, feeBps: GAS_FEE_BPS - 1n })))).code).toBe('fee_too_low');
    expect(wallet.writeContract).not.toHaveBeenCalled();

    // The same fee without gas is enough, and the fee that covers the drop buys it.
    expect((await relayer.relay(request({ feeBps: 50n }))).gasDropWei).toBe('0');
    expect((await relayer.relay(request({ gasDrop: true, feeBps: GAS_FEE_BPS, nullifier: 556n, recipient: OTHER }))).gasDropWei).toBe(DROP.toString());
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the receipt shows no withdrawal of that note', async () => {
    for (const receipt of ['no-event', 'other-contract'] as const) {
      const { relayer, wallet, logged } = setup({ receipt });
      expect((await relayer.relay(request({ gasDrop: true }))).gasDropWei).toBe('0');
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
      expect(logged[0]).toMatch(/without a Withdrawn event/);
    }
  });

  it('sends nothing when the relay reverted', async () => {
    const { relayer, wallet } = setup({ receipt: 'reverted' });
    expect((await refusal(relayer.relay(request({ gasDrop: true })))).code).toBe('reverted');
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('sends no gas to a contract, a funded address, an address that has transacted, or when not asked', async () => {
    for (const state of [{ code: '0x6080' as Hex }, { balance: DROP }, { nonce: 1 }, {}]) {
      const { relayer, wallet } = setup(state);
      const asked = Object.keys(state).length > 0;
      expect((await relayer.relay(request({ gasDrop: asked }))).gasDropWei).toBe('0');
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it('gives one note gas once, however many times its withdrawal is presented', async () => {
    const { relayer, wallet } = setup();
    await relayer.relay(request({ gasDrop: true }));
    // The chain double never marks the nullifier spent, so this is the ledger alone refusing.
    expect((await relayer.relay(request({ gasDrop: true, recipient: OTHER }))).gasDropWei).toBe('0');
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('gives one recipient gas once', async () => {
    const { relayer, wallet } = setup();
    await relayer.relay(request({ gasDrop: true }));
    expect((await relayer.relay(request({ gasDrop: true, nullifier: 556n }))).gasDropWei).toBe('0');
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('stops at the daily budget, then refuses up front, and opens again a day later', async () => {
    const { relayer, wallet, advance } = setup();
    await relayer.relay(request({ gasDrop: true }));
    await relayer.relay(request({ gasDrop: true, nullifier: 556n, recipient: OTHER }));
    const third = await refusal(relayer.relay(request({ gasDrop: true, nullifier: 557n, recipient: BLOCKED })));
    expect([third.status, third.code]).toEqual([429, 'gas_drops_exhausted']);
    expect(wallet.writeContract).toHaveBeenCalledTimes(2);
    // Without gas the withdrawal still goes through.
    expect((await relayer.relay(request({ nullifier: 557n, recipient: BLOCKED }))).gasDropWei).toBe('0');
    advance(GAS_DROP_WINDOW_MS + 1);
    expect((await relayer.relay(request({ gasDrop: true, nullifier: 558n, recipient: BLOCKED }))).gasDropWei).toBe(DROP.toString());
  });

  it('keeps the budget when the ledger is shared across restarts', async () => {
    let now = 1_000_000;
    const ledger = fileLedger(() => now);
    const first = setup({ ledger });
    await first.relayer.relay(request({ gasDrop: true }));
    await first.relayer.relay(request({ gasDrop: true, nullifier: 556n, recipient: OTHER }));
    const second = setup({ ledger });
    expect((await refusal(second.relayer.relay(request({ gasDrop: true, nullifier: 557n, recipient: BLOCKED })))).code).toBe('gas_drops_exhausted');
    now += GAS_DROP_WINDOW_MS + 1;
    expect((await second.relayer.relay(request({ gasDrop: true, nullifier: 557n, recipient: BLOCKED }))).gasDropWei).toBe(DROP.toString());
  });

  it('reports a transfer that could not be made as no gas, and keeps the withdrawal', async () => {
    const { relayer, logged, drops } = setup({ dropFails: true });
    const result = await relayer.relay(request({ gasDrop: true }));
    expect(result).toEqual({ transactionHash: RELAY_HASH, gasDropWei: '0' });
    expect(logged[0]).toMatch(/was not sent/);
    expect(drops.countToday()).toBe(0);
  });
});
