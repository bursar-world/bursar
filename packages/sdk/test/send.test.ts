import { describe, expect, it } from 'vitest';
import { BaseError, RawContractError, WaitForTransactionReceiptTimeoutError, toFunctionSelector } from 'viem';
import type { Address, Hex } from 'viem';

import { RHC_MAINNET } from '@bursar/core';

import { connect } from '../src/connection.js';
import {
  ContractRevertError,
  NoSignerError,
  SubmittedButUnconfirmedError,
  TransactionRevertedError,
} from '../src/errors.js';
import { preflight, sendCall } from '../src/send.js';
import { FAKE_HASH, RHC_DEPLOYMENT, fakeConnection } from './helpers/fake-connection.js';

const base = { id: 0, name: 'elsewhere', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://elsewhere.test'] } } };
const TARGET: Address = '0x1234567890123456789012345678901234567890';
const DATA: Hex = '0xdeadbeef';

function reverting(selector: Hex) {
  return () => {
    throw new BaseError('execution reverted', { cause: new RawContractError({ data: selector }) });
  };
}

describe('sendCall', () => {
  it('simulates before it sends, so a refusal costs nothing', async () => {
    const fake = fakeConnection();

    const sent = await sendCall(fake.connection, { to: TARGET, data: DATA, action: 'setPaused' });

    expect(fake.simulated).toEqual([{ to: TARGET, data: DATA }]);
    expect(fake.sent).toHaveLength(1);
    expect(sent.hash).toBe(FAKE_HASH);
    expect(sent.explorer).toBe(`${RHC_MAINNET.explorer}/tx/${FAKE_HASH}`);
  });

  /**
   * The chain a write names is what viem compares with the wallet's own before signing. Naming the
   * wallet's chain compares it with itself and passes on any network.
   */
  it('names the deployment chain on the write, not the chain the wallet reports', async () => {
    const fake = fakeConnection();
    const elsewhere = { ...fake.connection.walletClient, chain: { ...base, id: 8453 } };
    const connection = { ...fake.connection, walletClient: elsewhere as typeof fake.connection.walletClient };

    await sendCall(connection, { to: TARGET, data: DATA, action: 'spend' });

    expect(fake.sent[0]?.chain?.id).toBe(RHC_MAINNET.chainId);
  });

  it('prices a transaction at the fee floor the chain enforces', async () => {
    // Robinhood Chain's floor is 0.02 gwei, read from the Nitro gas precompile. An estimate from
    // a quiet block can land under it, and a transaction priced below it is refused outright.
    const floor = RHC_MAINNET.minFeeCap;
    const low = fakeConnection({ maxFeePerGas: floor / 2n });
    const high = fakeConnection({ maxFeePerGas: 50_000_000_000n });

    await sendCall(low.connection, { to: TARGET, data: DATA, action: 'spend' });
    await sendCall(high.connection, { to: TARGET, data: DATA, action: 'spend' });

    expect(low.sent[0]?.maxFeePerGas).toBe(floor);
    expect(high.sent[0]?.maxFeePerGas).toBe(50_000_000_000n);
    expect(low.sent[0]?.maxPriorityFeePerGas).toBe(1_000_000_000n);
  });

  it('sends nothing when the simulation reverts', async () => {
    const fake = fakeConnection({ simulate: reverting(toFunctionSelector('IsPaused()')) });

    await expect(
      sendCall(fake.connection, { to: TARGET, data: DATA, action: 'spend' }),
    ).rejects.toThrow(ContractRevertError);
    expect(fake.sent).toHaveLength(0);
  });

  it('names the Solidity error when nothing has a better story for it', async () => {
    const fake = fakeConnection({ simulate: reverting(toFunctionSelector('IsPaused()')) });

    await expect(
      sendCall(fake.connection, { to: TARGET, data: DATA, action: 'spend' }),
    ).rejects.toThrow('spend was refused with IsPaused');
  });

  /**
   * This message is what a caller reads on the money path when the name is one this package has
   * not written a sentence for. Sending them to read the Solidity is not something they can do.
   */
  it('leaves that caller a read they can make', async () => {
    const fake = fakeConnection({ simulate: reverting(toFunctionSelector('IsPaused()')) });
    const failure = await sendCall(fake.connection, { to: TARGET, data: DATA, action: 'spend' }).then(
      () => new Error('the call was expected to fail'),
      (error: unknown) => error as Error,
    );

    expect(failure.message).toContain('read the mandate again before sending the same call a second time');
    expect(failure.message).not.toMatch(/look that name up/iu);
    expect(failure.message).toContain('quote it when you report this');
  });

  it('lets an explanation replace the generic revert', async () => {
    const fake = fakeConnection({ simulate: reverting(toFunctionSelector('IsPaused()')) });

    await expect(
      sendCall(fake.connection, {
        to: TARGET,
        data: DATA,
        action: 'spend',
        explain: async (revert) => new Error(`explained ${revert?.errorName}`),
      }),
    ).rejects.toThrow('explained IsPaused');
  });

  it('refuses to report success for a transaction that mined and failed', async () => {
    const fake = fakeConnection({ receiptStatus: 'reverted' });

    await expect(
      sendCall(fake.connection, { to: TARGET, data: DATA, action: 'spend' }),
    ).rejects.toBeInstanceOf(TransactionRevertedError);
  });

  it('hands back the hash when no receipt arrives, so the caller does not send it twice', async () => {
    const fake = fakeConnection({
      receiptError: new WaitForTransactionReceiptTimeoutError({ hash: FAKE_HASH }),
    });

    const failure = sendCall(fake.connection, { to: TARGET, data: DATA, action: 'spend' });

    await expect(failure).rejects.toBeInstanceOf(SubmittedButUnconfirmedError);
    await expect(failure).rejects.toMatchObject({ hash: FAKE_HASH });
  });

  it('recognises the timeout thrown by a second copy of viem', async () => {
    // What a workspace with two resolved viem copies throws: the same error, from a
    // class this package's `instanceof` does not know. Matched by class, the timeout escapes raw
    // and the caller loses the one error that says do not send this again.
    class ForeignTimeout extends Error {
      override readonly name = 'WaitForTransactionReceiptTimeoutError';
    }

    const fake = fakeConnection({ receiptError: new ForeignTimeout('Timed out while waiting') });

    const failure = sendCall(fake.connection, { to: TARGET, data: DATA, action: 'spend' });

    await expect(failure).rejects.toBeInstanceOf(SubmittedButUnconfirmedError);
    await expect(failure).rejects.toMatchObject({ hash: FAKE_HASH });
  });

  it('reports a receipt it could not read as sent, not as a failure to retry', async () => {
    // The transaction went out before the endpoint refused the receipt read. Passed through raw, a
    // refused connection reads as a failed payment, and a caller that retries pays twice.
    const refused = new Error('connect ECONNREFUSED');
    const fake = fakeConnection({ receiptError: refused });

    const sent = sendCall(fake.connection, { to: TARGET, data: DATA, action: 'spend' });
    await expect(sent).rejects.toBeInstanceOf(SubmittedButUnconfirmedError);
    await expect(sent).rejects.toMatchObject({ cause: refused });
  });
});

describe('preflight', () => {
  it('refuses on a connection with nothing to sign with', async () => {
    await expect(
      preflight(connect({ deployment: RHC_DEPLOYMENT }), { to: TARGET, data: DATA, action: 'setPaused' }),
    ).rejects.toBeInstanceOf(NoSignerError);
  });
});
