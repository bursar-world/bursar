import { settlementAssetAbi, toMicro } from '@bursar/core';
import type { Micro, RhcPublicClient } from '@bursar/core';
import { parseEventLogs } from 'viem';
import type { Log } from 'viem';
import type { LaneLedger, UnsettledPayment } from '../lanes/ledger.js';

/**
 * Closes out settle claims that nothing else will.
 *
 * A settle claims its authorisation before broadcasting and records the settlement after the
 * receipt. Between the two the process can die, the send can throw with the transaction already
 * accepted, or the receipt wait can run out. Each leaves a guard row with no settlement on it: the
 * nonce is locked for good, any hold it claimed stays claimed, and a transfer that did land exists
 * in no ledger. The token is the authority on which of those it was, so this asks it.
 *
 * Unused on chain, the claim is deleted, which frees the nonce and unclaims the hold with it. Used,
 * the transfer that spent it is found and recorded the way the settle would have recorded it.
 */

/** What reconciliation asks of the ledger. `LaneLedger` satisfies it; a test passes a double. */
export type ReconcileLedger = Pick<
  LaneLedger,
  'unsettledPayments' | 'releasePaymentNonce' | 'settleReservation' | 'recordDirectSettlement'
>;

/** A transfer that spent an authorisation, read off the chain. */
export type LandedTransfer = {
  readonly txHash: `0x${string}`;
  readonly to: `0x${string}`;
  readonly amountMicro: Micro;
};

/** What reconciliation asks of the chain. */
export type AuthorizationChain = {
  /** EIP-3009 `authorizationState`: true once the nonce has been spent. */
  authorizationUsed(payer: `0x${string}`, nonce: `0x${string}`): Promise<boolean>;
  /** The transfer that spent it, from the hash the settle kept when there is one. */
  findTransfer(
    payer: `0x${string}`,
    nonce: `0x${string}`,
    txHash: string | null,
  ): Promise<LandedTransfer | null>;
};

export type ReconcileOptions = {
  readonly ledger: ReconcileLedger;
  readonly chain: AuthorizationChain;
  /** The network this process settles on. A claim on any other is not this chain's to answer. */
  readonly network: string;
  readonly asset: `0x${string}`;
  readonly treasury: string;
  readonly fee: (amountMicro: Micro) => Micro;
  /** How old a claim has to be before it is treated as abandoned rather than in flight. */
  readonly olderThanMs: number;
  readonly log?: (line: string) => void;
};

export type ReconcilePass = {
  readonly checked: number;
  readonly released: number;
  readonly recorded: number;
  readonly unresolved: number;
};

export async function reconcile(options: ReconcileOptions): Promise<ReconcilePass> {
  const log = options.log ?? (() => undefined);
  const due = await options.ledger.unsettledPayments(options.olderThanMs);

  let released = 0;
  let recorded = 0;
  let unresolved = 0;
  for (const payment of due) {
    try {
      const outcome = await reconcileOne(options, payment, log);
      if (outcome === 'released') released += 1;
      else if (outcome === 'recorded') recorded += 1;
      else unresolved += 1;
    } catch (error) {
      unresolved += 1;
      log(
        `reconcile failed payer=${payment.payerWallet} nonce=${payment.nonce} reason=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { checked: due.length, released, recorded, unresolved };
}

async function reconcileOne(
  options: ReconcileOptions,
  payment: UnsettledPayment,
  log: (line: string) => void,
): Promise<'released' | 'recorded' | 'unresolved'> {
  if (payment.network !== options.network) {
    log(`reconcile skipped payer=${payment.payerWallet} nonce=${payment.nonce}: claimed on ${payment.network}`);
    return 'unresolved';
  }

  const used = await options.chain.authorizationUsed(payment.payerWallet, payment.nonce);
  if (!used) {
    await options.ledger.releasePaymentNonce(payment.network, payment.payerWallet, payment.nonce);
    log(`reconcile released payer=${payment.payerWallet} nonce=${payment.nonce}: unused on chain`);
    return 'released';
  }

  const transfer = await options.chain.findTransfer(payment.payerWallet, payment.nonce, payment.txHash);
  if (!transfer) {
    // Spent, and the transaction that spent it is out of reach. The claim stays: releasing it
    // would say the payment never happened. An operator reconciles it from the explorer.
    log(`reconcile unresolved payer=${payment.payerWallet} nonce=${payment.nonce}: spent, transfer not found`);
    return 'unresolved';
  }

  const feeMicro = options.fee(transfer.amountMicro);
  const settlement = payment.reservationId
    ? (
        await options.ledger.settleReservation({
          reservationId: payment.reservationId,
          claim: payment.claim,
          asset: options.asset,
          feeMicro,
          payment: {
            amountMicro: transfer.amountMicro,
            payerWallet: payment.payerWallet,
            merchantWallet: transfer.to,
          },
          txHash: transfer.txHash,
          treasury: options.treasury,
        })
      ).settlement
    : await options.ledger.recordDirectSettlement({
        network: payment.network,
        asset: options.asset,
        payerWallet: payment.payerWallet,
        merchantWallet: transfer.to,
        amountMicro: transfer.amountMicro,
        feeMicro,
        txHash: transfer.txHash,
        nonce: payment.nonce,
        treasury: options.treasury,
      });

  log(`reconcile recorded payer=${payment.payerWallet} tx=${transfer.txHash} settlement=${settlement.id}`);
  return 'recorded';
}

/**
 * How far back to look for the transfer when the settle kept no hash.
 *
 * Only reached when the send threw before a hash came back. Reconciliation picks a claim up within
 * minutes of its settle, so the transfer, if there is one, is recent; the bound keeps the log query
 * inside what an RPC provider will answer in one call.
 */
const LOOKBACK_BLOCKS = 100_000n;

/** The chain side, read through the process's own RPC pool. */
export function chainAuthorizations(client: RhcPublicClient, asset: `0x${string}`): AuthorizationChain {
  const transferIn = (logs: readonly Log[], payer: `0x${string}`, nonce: `0x${string}`): LandedTransfer | null => {
    const events = parseEventLogs({
      abi: settlementAssetAbi,
      eventName: ['AuthorizationUsed', 'Transfer'],
      logs: logs.filter((entry) => sameAddress(entry.address, asset)),
    });
    const spent = events.some(
      (event) =>
        event.eventName === 'AuthorizationUsed' &&
        sameAddress(event.args.authorizer, payer) &&
        event.args.nonce.toLowerCase() === nonce.toLowerCase(),
    );
    if (!spent) return null;

    for (const event of events) {
      if (event.eventName !== 'Transfer' || !sameAddress(event.args.from, payer) || !event.transactionHash) continue;
      return { txHash: event.transactionHash, to: event.args.to, amountMicro: toMicro(event.args.value) };
    }
    return null;
  };

  const fromReceipt = async (
    hash: `0x${string}`,
    payer: `0x${string}`,
    nonce: `0x${string}`,
  ): Promise<LandedTransfer | null> => {
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      return receipt.status === 'success' ? transferIn(receipt.logs, payer, nonce) : null;
    } catch {
      // Dropped or replaced; the log search below finds whatever did spend the nonce.
      return null;
    }
  };

  return {
    authorizationUsed: (payer, nonce) =>
      client.readContract({
        address: asset,
        abi: settlementAssetAbi,
        functionName: 'authorizationState',
        args: [payer, nonce],
      }),

    async findTransfer(payer, nonce, txHash) {
      if (txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        const known = await fromReceipt(txHash as `0x${string}`, payer, nonce);
        if (known) return known;
      }

      const head = await client.getBlockNumber();
      const used = await client.getContractEvents({
        address: asset,
        abi: settlementAssetAbi,
        eventName: 'AuthorizationUsed',
        args: { authorizer: payer, nonce },
        fromBlock: head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n,
        toBlock: head,
      });
      const hash = used.at(-1)?.transactionHash;
      return hash ? fromReceipt(hash, payer, nonce) : null;
    },
  };
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
