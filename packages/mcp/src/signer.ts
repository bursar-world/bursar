/**
 * Signing inside this process, for an operator who has no relay to point at.
 *
 * A relay is a second service to run and keep running, and this repository ships none, so gating
 * every write tool behind one left an agent able to read a mandate and never able to pay through
 * it. A key held here is the same custody decision the SDK already offers a developer, made
 * deliberately through `BURSAR_SIGNER=local`, and it keeps the operator's key inside one process.
 * `BURSAR_RELAY_URL` stays the answer for a deployment that wants the key out of this process
 * entirely.
 *
 * What the key can do is fixed here rather than at the call site. Three calls are encoded, all
 * three against the one mandate account this signer was configured for, so a tool argument cannot
 * point it at another account or turn it into a general-purpose transaction sender. Everything
 * past that is the mandate's own: it counts the spend against its windows, and it reverts what
 * its limits refuse whatever this process was told to send.
 */

import { mandateAccountAbi, mandateAccountAbiV1, viemChain } from '@bursar/core';
import type { RhcChain, RhcPublicClient } from '@bursar/core';
import { createWalletClient, custom, encodeFunctionData, parseEventLogs } from 'viem';
import type { Account, Address, Hex, TransactionReceipt, WalletClient } from 'viem';
import { nonceManager, privateKeyToAccount } from 'viem/accounts';

import { ToolError } from './errors.js';
import { refusalForSelector } from './reasons.js';
import { isJsonObject } from './schema.js';
import type {
  RelayApproval,
  RelayDisputeRequest,
  RelaySpendReceipt,
  RelaySpendRequest,
  RelayTransactionReceipt,
  SpendRelay,
} from './relay.js';

export type LocalSignerOptions = {
  readonly client: RhcPublicClient;
  readonly chain: RhcChain;
  /** The one mandate this signer acts on. A request naming another account is refused here. */
  readonly account: Address;
  /** Never written anywhere, and scrubbed from everything this server prints. */
  readonly key: Hex;
  /** How long a spend waits for its receipt before it is reported as submitted and unconfirmed. */
  readonly receiptTimeoutMs?: number;
};

const DEFAULT_RECEIPT_TIMEOUT_MS = 60_000;

/** An approval the principal registered on chain carries no signature; the contract reads its own. */
const NO_SIGNATURE: Hex = '0x';

export function createLocalSigner(options: LocalSignerOptions): SpendRelay {
  const signer = accountFor(options.key);
  const timeoutMs = options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  const { client, account } = options;

  // The wallet rides the same pool the reads go through, so a failover moves both together and
  // there is one place an endpoint is configured. viem's own retry is off for the same reason it
  // is off on the read client: the pool retries, and it moves to another provider while it does.
  const wallet: WalletClient = createWalletClient({
    account: signer,
    chain: viemChain(options.chain),
    transport: custom({ request: client.request }, { retryCount: 0 }),
  });

  function assertScope(named: Address): void {
    if (named.toLowerCase() === account.toLowerCase()) return;

    throw new ToolError(
      'signer_scope_refused',
      `This signer acts for mandate ${account} and was asked to act for ${named}. Nothing was signed.`,
      { mandate: account, requested: named },
    );
  }

  /**
   * Runs the call before it is paid for, so a refusal costs nothing.
   *
   * A mandate that would refuse this spend refuses it here with its own error, which is the same
   * name and the same sentence a quote would have given. Sending first would buy that answer as a
   * failed receipt with the reason stripped off it.
   */
  async function preflight(data: Hex): Promise<void> {
    try {
      await client.call({ account: signer, to: account, data });
    } catch (error) {
      throw refused(error);
    }
  }

  async function submit(data: Hex, action: string): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
    await preflight(data);

    let hash: Hex;

    try {
      hash = await wallet.sendTransaction({
        account: signer,
        chain: viemChain(options.chain),
        to: account,
        data,
        ...(await fees()),
      });
    } catch (error) {
      // Broadcasting estimates gas first, so a limit the node rejects and a fee the signer cannot
      // cover both surface here rather than as a receipt.
      throw refused(error);
    }

    return { hash, receipt: await mined(hash, action) };
  }

  /**
   * A chain that enforces a floor on `maxFeePerGas` publishes it as `minFeeCap`, and an estimate
   * taken in a quiet block can land under it. Such a transaction is refused outright rather than
   * mined late, so the floor is applied before the fee is signed over.
   */
  async function fees(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
    const floor = options.chain.minFeeCap;
    if (floor <= 0n) return {};

    const estimate = await client.estimateFeesPerGas();
    if (estimate.maxFeePerGas === undefined) return {};

    return {
      maxFeePerGas: estimate.maxFeePerGas < floor ? floor : estimate.maxFeePerGas,
      ...(estimate.maxPriorityFeePerGas === undefined
        ? {}
        : { maxPriorityFeePerGas: estimate.maxPriorityFeePerGas }),
    };
  }

  async function mined(hash: Hex, action: string): Promise<TransactionReceipt> {
    let receipt: TransactionReceipt;

    try {
      receipt = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
    } catch (error) {
      // Matched by name rather than by class: `instanceof` holds only for the copy of viem that
      // threw, and a workspace resolving two copies is ordinary.
      if (error instanceof Error && error.name === 'WaitForTransactionReceiptTimeoutError') {
        throw new ToolError(
          'signer_unconfirmed',
          `The ${action} was signed and submitted as ${hash}, and no receipt arrived within ` +
            `${timeoutMs}ms. It may still be mining. Read the settlements for this mandate before ` +
            'paying again.',
          { txHash: hash, timeoutMs },
        );
      }

      throw error;
    }

    // viem resolves a reverted receipt as an ordinary result. Without this the caller would read a
    // transaction that failed on chain as one that worked.
    if (receipt.status !== 'success') {
      throw new ToolError(
        'signer_reverted',
        `The ${action} reverted on chain as ${hash}, so nothing moved. The mandate's state changed ` +
          'between the check and the transaction; read it again before retrying.',
        { txHash: hash },
      );
    }

    return receipt;
  }

  return {
    async spend(request: RelaySpendRequest): Promise<RelaySpendReceipt> {
      assertScope(request.mandateAccount);

      const spendRequest = {
        merchant: request.merchant,
        capabilityId: request.capabilityId,
        inputCommit: request.inputCommit,
        inputURI: request.inputURI,
        amount: BigInt(request.amount),
        deadline: BigInt(request.deadline),
      } as const;

      const proof = [...request.merchantProof];
      const approval = request.approval;
      const classed = { ...spendRequest, spendClass: request.spendClass };
      const data =
        request.contractSet === 'v1'
          ? approval === null
            ? encodeFunctionData({ abi: mandateAccountAbiV1, functionName: 'spend', args: [spendRequest, proof] })
            : encodeFunctionData({
                abi: mandateAccountAbiV1,
                functionName: 'spendApproved',
                args: [spendRequest, proof, consent(approval), approval.signature ?? NO_SIGNATURE],
              })
          : approval === null
            ? encodeFunctionData({ abi: mandateAccountAbi, functionName: 'spend', args: [classed, proof] })
            : encodeFunctionData({
                abi: mandateAccountAbi,
                functionName: 'spendApproved',
                args: [classed, proof, consent(approval), approval.signature ?? NO_SIGNATURE],
              });

      const { hash, receipt } = await submit(data, approval === null ? 'spend' : 'spendApproved');
      const spends = parseEventLogs({
        abi: mandateAccountAbi,
        eventName: 'Spent',
        logs: receipt.logs.filter((log) => log.address.toLowerCase() === account.toLowerCase()),
      });

      const spent = spends[0];

      // The escrow assigns the id and the account reports it. A spend that mined without saying
      // which lock it opened leaves the caller unable to follow the job, and guessing an id here
      // would point it at somebody else's.
      if (spent === undefined || spends.length > 1) {
        throw new ToolError(
          'signer_bad_receipt',
          `The spend mined as ${hash} and the mandate reported ${spends.length} settlements against ` +
            'it, where one was expected. Read the settlements for this mandate before paying again.',
          { txHash: hash, spends: spends.length },
        );
      }

      return { escrowId: spent.args.escrowId, txHash: hash };
    },

    async dispute(request: RelayDisputeRequest): Promise<RelayTransactionReceipt> {
      assertScope(request.mandateAccount);

      const { hash } = await submit(
        encodeFunctionData({
          abi: mandateAccountAbi,
          functionName: 'disputeSpend',
          args: [request.escrowId],
        }),
        'disputeSpend',
      );

      return { txHash: hash };
    },
  };
}

function consent(approval: RelayApproval): {
  approvalId: Hex;
  merchant: Address;
  capabilityId: Hex;
  amount: bigint;
  expiry: bigint;
} {
  return {
    approvalId: approval.approvalId,
    merchant: approval.merchant,
    capabilityId: approval.capabilityId,
    amount: BigInt(approval.amount),
    expiry: BigInt(approval.expiry),
  };
}

function accountFor(key: Hex): Account {
  try {
    // A local nonce manager, so two spends signed in the same block get consecutive nonces
    // instead of both claiming the pending one.
    return privateKeyToAccount(key, { nonceManager });
  } catch {
    // The key is never quoted back, here or anywhere else.
    throw new ToolError(
      'signer_key_invalid',
      'BURSAR_SIGNER_KEY is not a 32-byte 0x private key, so this server has nothing to sign with.',
    );
  }
}

/**
 * What a refused call tells the caller.
 *
 * A contract refusal is reported in the words a quote would have used, from the one table this
 * package keeps, so an agent that skipped the quote learns the same thing at the same cost. A
 * revert that carried no reason at all is left as it came and lands on the generic failure, which
 * is the truthful answer: nothing named it.
 */
function refused(error: unknown): unknown {
  const selector = selectorOf(error);
  const refusal = selector === null ? null : refusalForSelector(selector);

  return refusal === null
    ? error
    : new ToolError('mandate_refused', refusal.message, { revert: refusal.code, subject: refusal.subject });
}

/**
 * The four bytes a node returned with a refused call, read by shape.
 *
 * `instanceof` holds only for the copy of viem that threw, and a workspace resolving two copies is
 * ordinary. viem carries the revert payload as `data` on one of the errors in the chain, either as
 * the hex itself or wrapped in one more object.
 */
function selectorOf(error: unknown): Hex | null {
  let node: unknown = error;

  for (let depth = 0; depth < 8 && isJsonObject(node); depth += 1) {
    const carried = node['data'];
    const data = typeof carried === 'string' ? carried : isJsonObject(carried) ? carried['data'] : undefined;

    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
      return data.slice(0, 10) as Hex;
    }

    node = node['cause'];
  }

  return null;
}
