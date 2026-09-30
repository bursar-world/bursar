import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, encodeErrorResult, http } from 'viem';
import type { Account, Address, Chain, Hex, Transport, WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { RHC_MAINNET, mandateAccountAbi, viemChain } from '@bursar/core';

import { connect, type Connection } from '../src/connection.js';
import { ContractRevertError, GasFailureError, isGasFailure } from '../src/errors.js';
import { gasFailureFrom } from '../src/revert.js';
import { preflight, sendCall } from '../src/send.js';
import { BURNER, BURNER_CODE, startAnvil, type Anvil } from './helpers/anvil.js';
import { RHC_DEPLOYMENT } from './helpers/fake-connection.js';

/**
 * Gas failures, against a node that produces them.
 *
 * The defect this suite exists for reached a caller as "the revert data decoded to nothing this
 * package knows", which points a developer at a contract condition that never fired. Every case
 * below is an error a real EVM threw, because the wording, the class viem wraps it in and the
 * field the numbers land in are the whole problem: none of that survives being written by hand.
 */

/** Loops ten thousand times, about 250,000 gas. Cheap enough to simulate, dear enough to send. */
const GRINDER: Hex = '0x6127105b600190038060035700';
const GRINDER_ADDRESS: Address = '0x000000000000000000000000000000000000c0de';

/** Reverts with DailyCapExceeded(), the refusal the live run was stopped by. */
const DAILY_CAP = encodeErrorResult({ abi: mandateAccountAbi, errorName: 'DailyCapExceeded' });
const REFUSER: Address = '0x000000000000000000000000000000000000dead';
/** PUSH32 selector, MSTORE, then REVERT(0, 4): the four bytes a bare Solidity error comes back as. */
const REFUSER_CODE: Hex = `0x7f${DAILY_CAP.slice(2).padEnd(64, '0')}60005260046000fd`;

const FUNDED_KEY: Hex = `0x${'a1'.repeat(32)}`;
const DUST_KEY: Hex = `0x${'b2'.repeat(32)}`;
const funded = privateKeyToAccount(FUNDED_KEY);
const dust = privateKeyToAccount(DUST_KEY);

/** One ETH. Gas is charged in ETH on Robinhood Chain and in nothing else. */
const ONE_ETH = 10n ** 18n;

/** What a transaction is priced at here. Robinhood Chain publishes no floor, so this stands in. */
const GAS_PRICE = 1_000_000_000n;

let anvil: Anvil;

beforeAll(async () => {
  anvil = await startAnvil();
  // connect() asks the node for code at every contract a supplied record names before it sends
  // anything. One STOP at each is enough to be found.
  for (const address of [...Object.values(RHC_DEPLOYMENT.contracts), RHC_DEPLOYMENT.settlementAsset]) {
    await anvil.setCode(address, '0x00');
  }
  await anvil.setCode(BURNER, BURNER_CODE);
  await anvil.setCode(GRINDER_ADDRESS, GRINDER);
  await anvil.setCode(REFUSER, REFUSER_CODE);
  await anvil.setBalance(funded.address, ONE_ETH);
  // Enough to be a balance and nowhere near enough to pay for a transaction. This is the signer
  // that holds plenty of USDG and no ETH, and a node describes it the same way it describes a
  // gas limit set too low.
  await anvil.setBalance(dust.address, 5_000n);
}, 30_000);

afterAll(async () => {
  await anvil?.stop();
});

function node(): Connection {
  return connect({ deployment: RHC_DEPLOYMENT, rpc: anvil.url, account: FUNDED_KEY });
}

function poorNode(): Connection {
  return connect({ deployment: RHC_DEPLOYMENT, rpc: anvil.url, account: DUST_KEY });
}

/**
 * The same connection with the fee floor removed, which is what Robinhood Chain publishes.
 *
 * Classifying a gas failure needs a price, and on a chain with no floor the only place one comes
 * from is the estimate. A connection that quietly skipped it would call every out-of-ETH signer
 * out of gas.
 */
function noFloor(connection: Connection): Connection {
  return { ...connection, chain: { ...connection.chain, minFeeCap: 0n } };
}

async function thrownBy(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  throw new Error('the action was expected to fail and did not');
}

async function gasErrorFrom(action: () => Promise<unknown>): Promise<GasFailureError> {
  const error = await thrownBy(action);
  if (!(error instanceof GasFailureError)) {
    throw new Error(`expected a gas failure, got ${String(error)}`);
  }

  return error;
}

describe('gasFailureFrom, on failures a node produced', () => {
  it('names a call that consumed everything it was given', async () => {
    const client = createPublicClient({ chain: viemChain(RHC_MAINNET), transport: http(anvil.url) });

    const error = await thrownBy(() =>
      client.call({ account: funded.address, to: BURNER, data: '0x' }),
    );

    expect(gasFailureFrom(error)?.reason).toBe('out-of-gas');
  });

  it('separates an estimate the node refused from an execution that ran out', async () => {
    const client = createPublicClient({ chain: viemChain(RHC_MAINNET), transport: http(anvil.url) });

    const error = await thrownBy(() => client.estimateGas({ account: funded.address, to: BURNER }));
    const signal = gasFailureFrom(error);

    // The node opens this one with "Out of gas", and reading it as an execution failure would
    // send the caller to raise a limit on a transaction that was never built.
    expect(signal?.reason).toBe('estimate-failed');
    expect(signal?.gasNeeded).toBe(30_000_000n);
  });

  it('names a limit below what it costs to admit the transaction, and quotes it', async () => {
    const error = await thrownBy(() => send(funded, { gas: 1_000n }));
    const signal = gasFailureFrom(error);

    expect(signal?.reason).toBe('limit-below-intrinsic');
    expect(signal?.gasLimit).toBe(1_000n);
  });

  it('names a limit no block could hold', async () => {
    const error = await thrownBy(() => send(funded, { gas: 40_000_000n }));
    const signal = gasFailureFrom(error);

    expect(signal?.reason).toBe('limit-above-block');
    expect(signal?.gasLimit).toBe(40_000_000n);
  });

  it('names a sender that cannot pay the fee', async () => {
    const error = await thrownBy(() => send(dust, { gas: 100_000n }));

    expect(gasFailureFrom(error)?.reason).toBe('unfunded');
  });

  it('leaves a contract refusal alone, so a limit never masquerades as a revert', async () => {
    const client = createPublicClient({ chain: viemChain(RHC_MAINNET), transport: http(anvil.url) });

    const error = await thrownBy(() =>
      client.call({ account: funded.address, to: REFUSER, data: '0x' }),
    );

    expect(gasFailureFrom(error)).toBeUndefined();
  });

  it('reports nothing for a failure that has nothing to do with gas', () => {
    expect(gasFailureFrom(new Error('connect ECONNREFUSED'))).toBeUndefined();
    expect(gasFailureFrom(undefined)).toBeUndefined();
  });

  it('reads a node sentence that reached it as a plain error', async () => {
    // The pool re-raises what a provider said without viem's fields around it, and the wording is
    // still the node's.
    const raw = await thrownBy(() =>
      connect({ deployment: RHC_DEPLOYMENT, rpc: anvil.url }).publicClient.call({
        account: funded.address,
        to: BURNER,
      }),
    );

    expect(gasFailureFrom(new Error(String((raw as Error).message)))?.reason).toBe('out-of-gas');
  });
});

/** A transaction sent outside the SDK, to get at the failures a broadcast produces. */
async function send(account: Account, overrides: { gas: bigint }): Promise<Hex> {
  const wallet = createWalletClient({
    account,
    chain: viemChain(RHC_MAINNET),
    transport: http(anvil.url, { retryCount: 0 }),
  });

  return wallet.sendTransaction({
    to: BURNER,
    data: '0x',
    maxFeePerGas: GAS_PRICE,
    maxPriorityFeePerGas: 1n,
    ...overrides,
  });
}

describe('what a caller is left holding', () => {
  // The mined case below spends ETH, and the balance is what several of these assert on.
  beforeEach(async () => {
    await anvil.setBalance(funded.address, ONE_ETH);
  });

  it('tells a funded signer to raise the limit, and says what its balance covers', async () => {
    const error = await gasErrorFrom(() =>
      preflight(node(), { to: BURNER, data: '0x', action: 'spend' }),
    );

    expect(error.reason).toBe('out-of-gas');
    expect(error.sender).toBe(funded.address);
    expect(error.balanceWei).toBe(ONE_ETH);
    expect(error.message).toContain('spend ran out of gas');
    expect(error.message).toContain('Raise the gas limit');
    expect(error.message).toContain('1 ETH');
    expect(error.message).not.toContain('USDG');
  });

  it('tells a signer with no money to fund itself, on the identical node error', async () => {
    const error = await gasErrorFrom(() =>
      preflight(poorNode(), { to: BURNER, data: '0x', action: 'spend' }),
    );

    // Same call, same node, same "out of gas" from the EVM. The balance is the only thing that
    // separates a limit set too low from a signer that cannot pay.
    expect(error.reason).toBe('unfunded');
    expect(error.message).toContain('is out of ETH');
    expect(error.message).toContain('less than 0.000000001 ETH');
    expect(error.message).not.toContain('Raise the gas limit');
  });

  it('tells an out-of-ETH signer that its USDG is not the problem', async () => {
    const error = await gasErrorFrom(() =>
      preflight(poorNode(), { to: BURNER, data: '0x', action: 'spend' }),
    );

    // The fee and the payment are different assets here. A signer can hold every USDG it needs
    // and still be unable to send this, and the message has to say which one to top up.
    expect(error.message).toContain(
      'Fees are charged in ETH and payments settle in USDG, so a signer can hold all the USDG ' +
        'it needs and still be unable to send this. Send ETH to the signer and try again.',
    );
    expect(error.balanceWei).toBe(5_000n);
  });

  it('still separates the two where the chain publishes no fee floor', async () => {
    const error = await gasErrorFrom(() =>
      preflight(noFloor(poorNode()), { to: BURNER, data: '0x', action: 'spend' }),
    );

    // Nothing pins the price on Robinhood Chain, so the estimate is the only number that can
    // decide this. Reading the reason off the node's wording alone reports out-of-gas.
    expect(error.reason).toBe('unfunded');
    expect(error.maxFeePerGas ?? 0n).toBeGreaterThan(0n);
  });

  it('names the signer rather than the mandate account, which does not pay fees', async () => {
    const error = await gasErrorFrom(() =>
      preflight(poorNode(), { to: BURNER, data: '0x', action: 'spend' }),
    );

    expect(error.message).toContain(dust.address);
    expect(error.message).toContain('Funding the mandate account does not help');
  });

  it('catches a fee it cannot cover at the broadcast, where nothing simulated it', async () => {
    const error = await gasErrorFrom(() =>
      sendCall(poorNode(), { to: GRINDER_ADDRESS, data: '0x', action: 'release' }),
    );

    expect(error.reason).toBe('unfunded');
    expect(error.action).toBe('release');
  });

  it('names a transaction that mined and burned its whole limit', async () => {
    const error = await gasErrorFrom(() =>
      sendCall(withGasLimit(node(), 100_000n), {
        to: GRINDER_ADDRESS,
        data: '0x',
        action: 'spend',
      }),
    );

    expect(error.reason).toBe('out-of-gas');
    expect(error.gasLimit).toBe(100_000n);
    expect(error.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(error.message).toContain('execution used the whole 100,000 gas limit');
  });

  it('still reports a contract refusal as a refusal', async () => {
    const error = await thrownBy(() =>
      sendCall(node(), { to: REFUSER, data: '0x', action: 'spend' }),
    );

    expect(error).toBeInstanceOf(ContractRevertError);
    expect(isGasFailure(error)).toBe(false);
    expect((error as ContractRevertError).errorName).toBe('DailyCapExceeded');
  });

  it('lets a caller switch on the reason without matching on message text', async () => {
    const error = await thrownBy(() =>
      preflight(poorNode(), { to: BURNER, data: '0x', action: 'spend' }),
    );

    expect(isGasFailure(error)).toBe(true);
    if (!isGasFailure(error)) throw new Error('unreachable');
    expect(error.code).toBe('gas_failure');
    expect(error.details.reason).toBe('unfunded');
  });
});

/**
 * A connection that sends with a fixed gas limit.
 *
 * `sendCall` lets the node estimate, and an estimate is by definition enough, so the only way to
 * mine an out-of-gas transaction is to pick the limit. Nothing else is stubbed: the node runs the
 * transaction, mines it, and reports the receipt this assertion reads.
 */
function withGasLimit(connection: Connection, gas: bigint): Connection {
  const wallet = connection.walletClient;
  if (!wallet) throw new Error('the connection was opened without a signer');

  const capped = {
    ...wallet,
    sendTransaction: (request: Parameters<typeof wallet.sendTransaction>[0]) =>
      wallet.sendTransaction({ ...request, gas }),
  } as unknown as WalletClient<Transport, Chain, Account>;

  return { ...connection, walletClient: capped };
}
