import { RHC_MAINNET, createRhcClient, mandateAccountAbi } from '@bursar/core';
import { decodeFunctionData, recoverTransactionAddress, toFunctionSelector } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { isToolError } from '../src/errors.js';
import { createLocalSigner } from '../src/signer.js';
import type { RelaySpendRequest } from '../src/relay.js';
import { ACCOUNT, PROVIDER, createFakeNode, defaultState } from './node.js';
import type { FakeNode, NodeState } from './node.js';

/** A key that exists for this file and nothing else. It has never held anything. */
const KEY: Hex = `0x${'7f'.repeat(32)}`;
const SIGNER = privateKeyToAddress(KEY);

const OTHER_MANDATE: Address = '0x00000000000000000000000000000000000acc02';

function signerFor(node: FakeNode, account: Address = ACCOUNT) {
  const { client } = createRhcClient({
    chain: RHC_MAINNET,
    providers: [
      { name: 'primary', url: 'http://primary.test' },
      { name: 'fallback', url: 'http://fallback.test' },
    ],
    fetchFn: node.fetchFn,
  });

  return createLocalSigner({ client, chain: RHC_MAINNET, account, key: KEY });
}

function spendRequest(overrides: Partial<RelaySpendRequest> = {}): RelaySpendRequest {
  return {
    mandateAccount: ACCOUNT,
    merchant: PROVIDER,
    capabilityId: `0x${'11'.repeat(32)}`,
    inputCommit: `0x${'22'.repeat(32)}`,
    inputURI: 'data:application/json;base64,eyJjaXR5IjoiUGFyaXMifQ==',
    amount: '1000000',
    deadline: '1800000300',
    merchantProof: [],
    approval: null,
    ...overrides,
  };
}

function reverting(selector: string): NodeState {
  const state = defaultState();
  state.writeRevert = toFunctionSelector(selector);

  return state;
}

async function caught(run: Promise<unknown>): Promise<{ code: string; message: string; detail: unknown }> {
  try {
    await run;
  } catch (error) {
    if (isToolError(error)) return { code: error.code, message: error.message, detail: error.detail };

    return { code: 'not-a-tool-error', message: String(error), detail: undefined };
  }

  throw new Error('the call was expected to be refused and was not');
}

describe('a key held in this process', () => {
  it('signs the spend as itself, sends it to the mandate, and reads the settlement back', async () => {
    const node = createFakeNode();

    const receipt = await signerFor(node).spend(spendRequest());

    expect(receipt.escrowId).toBe(77n);

    const sent = node.transactions[0];

    expect(node.transactions).toHaveLength(1);
    expect(receipt.txHash).toBe(sent?.hash);
    expect(sent?.to.toLowerCase()).toBe(ACCOUNT.toLowerCase());
    expect(sent?.chainId).toBe(RHC_MAINNET.chainId);
    expect(await recoverTransactionAddress({ serializedTransaction: sent?.raw as `0x02${string}` })).toBe(SIGNER);
  });

  it('encodes the spend the account expects, with the input the caller committed to', async () => {
    const node = createFakeNode();

    await signerFor(node).spend(spendRequest());

    const call = decodeFunctionData({ abi: mandateAccountAbi, data: node.transactions[0]?.data ?? '0x' });

    expect(call.functionName).toBe('spend');
    expect(call.args?.[0]).toEqual({
      merchant: PROVIDER,
      capabilityId: `0x${'11'.repeat(32)}`,
      inputCommit: `0x${'22'.repeat(32)}`,
      inputURI: 'data:application/json;base64,eyJjaXR5IjoiUGFyaXMifQ==',
      amount: 1_000_000n,
      deadline: 1_800_000_300n,
    });
    expect(call.args?.[1]).toEqual([]);
  });

  it("carries the principal's consent as the approved call when there is one", async () => {
    const node = createFakeNode();

    await signerFor(node).spend(
      spendRequest({
        approval: {
          approvalId: `0x${'34'.repeat(32)}`,
          merchant: PROVIDER,
          capabilityId: `0x${'11'.repeat(32)}`,
          amount: '2000000',
          expiry: '1800086400',
          signature: `0x${'ab'.repeat(65)}`,
        },
      }),
    );

    const call = decodeFunctionData({ abi: mandateAccountAbi, data: node.transactions[0]?.data ?? '0x' });

    expect(call.functionName).toBe('spendApproved');
    expect(call.args?.[2]).toEqual({
      approvalId: `0x${'34'.repeat(32)}`,
      merchant: PROVIDER,
      capabilityId: `0x${'11'.repeat(32)}`,
      amount: 2_000_000n,
      expiry: 1_800_086_400n,
    });
    expect(call.args?.[3]).toBe(`0x${'ab'.repeat(65)}`);
  });

  it('sends an approval the principal registered on chain with no signature attached', async () => {
    const node = createFakeNode();

    await signerFor(node).spend(
      spendRequest({
        approval: {
          approvalId: `0x${'34'.repeat(32)}`,
          merchant: PROVIDER,
          capabilityId: `0x${'11'.repeat(32)}`,
          amount: '2000000',
          expiry: '1800086400',
          signature: null,
        },
      }),
    );

    const call = decodeFunctionData({ abi: mandateAccountAbi, data: node.transactions[0]?.data ?? '0x' });

    expect(call.args?.[3]).toBe('0x');
  });

  it('contests a settlement through the account, which is the payer on every lock it opened', async () => {
    const node = createFakeNode();

    const receipt = await signerFor(node).dispute({ mandateAccount: ACCOUNT, escrowId: 5n });

    expect(receipt.txHash).toBe(node.transactions[0]?.hash);
    expect(decodeFunctionData({ abi: mandateAccountAbi, data: node.transactions[0]?.data ?? '0x' })).toEqual({
      functionName: 'disputeSpend',
      args: [5n],
    });
  });

  /**
   * The point of holding the key here rather than behind a general-purpose sender: the only thing
   * it can be made to do is act on the one mandate it was configured for.
   */
  it('refuses to act for any mandate but the one it was configured for, and signs nothing', async () => {
    const node = createFakeNode();
    const signer = signerFor(node);

    const spend = await caught(signer.spend(spendRequest({ mandateAccount: OTHER_MANDATE })));
    const dispute = await caught(signer.dispute({ mandateAccount: OTHER_MANDATE, escrowId: 5n }));

    expect(spend.code).toBe('signer_scope_refused');
    expect(dispute.code).toBe('signer_scope_refused');
    expect(spend.message).toContain(OTHER_MANDATE);
    expect(node.transactions).toHaveLength(0);
  });

  /**
   * The limits are the contract's, and it is asked before the transaction is paid for. A refusal
   * costs a call rather than a reverted transaction, and it arrives in the words a quote uses.
   */
  it('runs the spend against the mandate first, and reports a refusal in the quote’s own words', async () => {
    const node = createFakeNode(reverting('DailyCapExceeded()'));

    const failure = await caught(signerFor(node).spend(spendRequest()));

    expect(failure.code).toBe('mandate_refused');
    expect(failure.message).toContain('The daily budget does not have room for this spend');
    expect(failure.detail).toMatchObject({ revert: 'DailyCapExceeded', subject: 'daily' });
    expect(node.transactions).toHaveLength(0);
  });

  it('reports a spend the mandate refuses because this signer is not its agent', async () => {
    const node = createFakeNode(reverting('NotAgent()'));

    const failure = await caught(signerFor(node).spend(spendRequest()));

    expect(failure.code).toBe('mandate_refused');
    expect(failure.detail).toMatchObject({ revert: 'NotAgent' });
    expect(node.transactions).toHaveLength(0);
  });

  it('names a refusal it has no reading for, without forwarding the node’s own message', async () => {
    const node = createFakeNode(reverting('SomethingNewerThanThisPackage()'));

    const failure = await caught(signerFor(node).spend(spendRequest()));

    expect(failure.code).toBe('mandate_refused');
    expect(failure.message).toBe('The mandate refused this spend for a reason this server does not recognise.');
    expect(failure.detail).toMatchObject({ revert: toFunctionSelector('SomethingNewerThanThisPackage()') });
    expect(failure.message).not.toContain('execution reverted');
  });

  it('refuses a transaction that mined and reverted rather than reporting a settlement', async () => {
    const state = defaultState();
    state.receiptStatus = '0x0';
    const node = createFakeNode(state);

    const failure = await caught(signerFor(node).spend(spendRequest()));

    expect(failure.code).toBe('signer_reverted');
    expect(failure.message).toContain('nothing moved');
  });

  it('pays the fee floor this chain enforces rather than an estimate taken under it', async () => {
    const state = defaultState();
    state.baseFeePerGas = 1_000n;
    const node = createFakeNode(state);

    await signerFor(node).spend(spendRequest());

    expect(node.transactions[0]?.maxFeePerGas).toBe(RHC_MAINNET.minFeeCap);
  });
});
