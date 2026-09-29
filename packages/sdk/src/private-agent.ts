/**
 * An agent spending from a private mandate, signing with the stealth key from its hand-off file.
 *
 * Each payment rebuilds the counters from the chain, proves the spend against the terms in the
 * file, seals the job brief to the provider's published viewing key when it has one, and sends
 * `spend` from the stealth address. The stealth address pays its own gas, so it has to hold a
 * little ETH first.
 */

import { canonicalStringify, committedMandateAccountAbi, toCapabilityId } from '@bursar/core';
import { createWalletClient, custom, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { CommittedClass } from './committed.js';
import type { AgentHandoff } from './handoff.js';
import { jobCommit, jobDocument, jobURI, type JobSpec } from './job.js';
import { proveSpend, recoverState, spendArgs } from './prove.js';
import { publishedViewingKey, sealedURI } from './seal.js';

export type PrivatePayment = {
  readonly payee: Address;
  readonly amount: bigint;
  /** A class-prefixed capability label such as `service:gpu.render:1`, or its 32-byte id. */
  readonly capability: string;
  readonly spec: JobSpec;
  readonly spendClass?: CommittedClass;
  /** Seconds the provider has to deliver. Default six hours. */
  readonly deliverWithin?: number;
};

export type PrivatePaymentReceipt = {
  readonly hash: Hex;
  readonly escrowId: bigint;
  readonly sealed: boolean;
  readonly receipt: TransactionReceipt;
};

type Client = Pick<
  PublicClient,
  'getLogs' | 'readContract' | 'getTransaction' | 'getBlock' | 'simulateContract' | 'estimateContractGas' | 'waitForTransactionReceipt' | 'request' | 'chain'
>;

export function privateAgent(handoff: AgentHandoff, client: Client) {
  const account = privateKeyToAccount(handoff.privateKey);
  const wallet = createWalletClient({ account, chain: client.chain, transport: custom({ request: client.request }) });

  async function pay(payment: PrivatePayment): Promise<PrivatePaymentReceipt> {
    const spendClass = payment.spendClass ?? 'service';
    const state = await recoverState(client, handoff.mandate, handoff.terms, BigInt(handoff.fromBlock));
    const document = canonicalStringify(jobDocument(payment.spec), 'spec');
    const viewingKey = await publishedViewingKey(client, payment.payee);
    const inputURI = viewingKey ? await sealedURI(viewingKey, document) : jobURI(payment.spec);

    const latest = await client.getBlock();
    const proven = await proveSpend({
      terms: handoff.terms,
      state,
      mandate: handoff.mandate,
      payee: payment.payee,
      amount: payment.amount,
      spendClass,
      provenAt: latest.timestamp + 90n,
    });
    const args = spendArgs(proven, {
      payee: payment.payee,
      capabilityId: toCapabilityId(payment.capability),
      inputCommit: jobCommit(payment.spec),
      inputURI,
      amount: payment.amount,
      deadline: latest.timestamp + BigInt(payment.deliverWithin ?? 6 * 3600),
      spendClass,
    });
    const { result, request } = await client.simulateContract({
      address: handoff.mandate,
      abi: committedMandateAccountAbi,
      functionName: 'spend',
      args,
      account,
    });
    // Robinhood Chain bills the L1 data inside gasUsed, and a sealed brief is long, so the limit is
    // estimated per call rather than fixed.
    const gas = await client.estimateContractGas({ ...request, account });
    const hash = await wallet.writeContract({ ...request, gas: (gas * 6n) / 5n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`The spend reverted: ${hash}`);
    return { hash, escrowId: result, sealed: viewingKey !== null, receipt };
  }

  return { address: account.address, mandate: handoff.mandate, pay };
}
