import { escrowAbi, micro, settlementAssetAbi } from '@bursar/core';
import type { RhcPublicClient, Micro } from '@bursar/core';
import { getAbiItem, zeroAddress } from 'viem';
import type { Address, Chain, Hex, PrivateKeyAccount, Transport, WalletClient } from 'viem';

/** Mirrors `IEscrow.LockStatus`. The uint8 on the wire means nothing without it. */
export const LockStatus = {
  None: 0,
  Locked: 1,
  Released: 2,
  TimedOut: 3,
  Disputed: 4,
  Cancelled: 5,
  Resolved: 6,
} as const;

export type LockStatus = (typeof LockStatus)[keyof typeof LockStatus];

const STATUS_NAMES: Readonly<Record<number, string>> = {
  0: 'none',
  1: 'locked',
  2: 'released',
  3: 'timed_out',
  4: 'disputed',
  5: 'cancelled',
  6: 'resolved',
};

export function lockStatusName(status: number): string {
  return STATUS_NAMES[status] ?? `unknown(${status})`;
}

/**
 * Head of chain as one reading. The timestamp travels with the number because every deadline the
 * sidecar reasons about is a block timestamp, and comparing one of those against the local wall
 * clock is how a worker ends up paying gas for a `finalizeRelease` that reverts `TooEarly`.
 */
export type BlockRef = {
  readonly number: bigint;
  readonly timestamp: bigint;
};

export type LockedLog = {
  readonly id: bigint;
  readonly payee: Address;
  readonly blockNumber: bigint;
};

/**
 * The economics of the deployment being answered, read once at startup. Every field is immutable
 * in the contract except `resolver`, and that can be set once and never re-pointed. One reading
 * stays true for the life of the process.
 */
export type EscrowTerms = {
  readonly settlementAsset: Address;
  /** Charged against the payee's side of a settlement, and against nothing else. */
  readonly feeBps: number;
  /** Taken off the top of a disputed lock, before the refund split. */
  readonly resolverFeeBps: number;
  /** Share of the locked amount a disputer posts as a bond. */
  readonly disputeBondBps: number;
  /** Seconds after a release during which the payer may still contest it. */
  readonly disputeWindow: bigint;
  /** Zero while no oracle registry is wired, in which case `dispute` on an open lock reverts. */
  readonly resolver: Address;
};

export type LockRecord = {
  readonly payer: Address;
  readonly payee: Address;
  readonly disputer: Address;
  readonly capabilityId: Hex;
  readonly inputCommit: Hex;
  readonly outputCommit: Hex;
  readonly inputURI: string;
  readonly outputURI: string;
  readonly amount: Micro;
  readonly deadline: bigint;
  readonly releasedAt: bigint;
  readonly bond: Micro;
  readonly disputedAt: bigint;
  readonly status: number;
  /** True once this lock has moved a reputation counter. One lock is worth exactly one. */
  readonly counted: boolean;
};

export type TxOutcome = {
  readonly hash: Hex;
  readonly status: 'success' | 'reverted';
  readonly blockNumber: bigint;
  readonly gasUsed: bigint;
};

/**
 * A write that did not come back with a receipt, and whether a transaction got out.
 *
 * The difference decides what the caller may do next. With a hash, a signed transaction is on the
 * wire and may still be mined: signing another races its own nonce and pays for both, so the
 * caller has to wait a confirmation window and has spent one of the few attempts a lock is worth.
 * Without one, nothing was signed and nothing is racing, so the same attempt costs a retry and no
 * more. Collapsing the two is how a provider having a bad minute abandons a payable lock.
 */
export class WriteFailed extends Error {
  readonly action: 'release' | 'finalizeRelease' | 'dispute';
  /** The transaction that may still land, or null when none was produced. */
  readonly hash: Hex | null;

  constructor(action: WriteFailed['action'], hash: Hex | null, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'WriteFailed';
    this.action = action;
    this.hash = hash;
    this.cause = cause;
  }
}

/** The transaction a failed write left in flight, or null when it never produced one. */
export function inFlightHash(error: unknown): Hex | null {
  return error instanceof WriteFailed ? error.hash : null;
}

/**
 * The chain surface the loop needs, kept narrow so the loop is testable without a node and so the
 * whole set of calls the sidecar can make against the escrow is visible in one place.
 */
export type EscrowPort = {
  latestBlock(): Promise<BlockRef>;
  terms(): Promise<EscrowTerms>;
  lockedLogs(fromBlock: bigint, toBlock: bigint): Promise<readonly LockedLog[]>;
  getLock(id: bigint): Promise<LockRecord>;
  /** Settlement-asset allowance the payee has given the escrow. A dispute bond is pulled from it. */
  bondAllowance(settlementAsset: Address, owner: Address): Promise<Micro>;
  release(id: bigint, outputCommit: Hex, outputURI: string): Promise<TxOutcome>;
  finalizeRelease(id: bigint): Promise<TxOutcome>;
  dispute(id: bigint): Promise<TxOutcome>;
};

export type EscrowPortOptions = {
  readonly client: RhcPublicClient;
  readonly wallet: WalletClient<Transport, Chain, PrivateKeyAccount>;
  readonly address: Address;
  /** How long to wait for a write to mine before calling it a transient failure. */
  readonly confirmTimeoutMs: number;
  /**
   * The floor chain 4663 enforces on maxFeePerGas, in wei, from the chain record. A transaction
   * priced under it is rejected by the node rather than mined late, and the observed base fee
   * sits above it, so a release that omits this is included right up until the chain is quiet.
   */
  readonly minFeeCap: bigint;
};

const LOCKED_EVENT = getAbiItem({ abi: escrowAbi, name: 'Locked' });

export function createEscrowPort(options: EscrowPortOptions): EscrowPort {
  const { client, wallet, address, confirmTimeoutMs, minFeeCap } = options;

  /**
   * Priced per write rather than once, because the base fee moves between one lock and the next
   * and a cached price is either stale or too high. Falls through to viem's own estimate when the
   * chain declares no floor or the estimate already clears it.
   */
  async function fees(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
    if (minFeeCap <= 0n) return {};

    const estimate = await client.estimateFeesPerGas();
    if (estimate.maxFeePerGas === undefined) return {};

    return {
      maxFeePerGas: estimate.maxFeePerGas < minFeeCap ? minFeeCap : estimate.maxFeePerGas,
      ...(estimate.maxPriorityFeePerGas === undefined
        ? {}
        : { maxPriorityFeePerGas: estimate.maxPriorityFeePerGas }),
    };
  }

  /**
   * Every write is confirmed before the next one is prepared. The transport fails over between two
   * independent RPC providers, and a provider that never saw the previous transaction reports a
   * stale pending nonce, which would sign a replacement for one already in flight.
   */
  async function confirm(hash: Hex): Promise<TxOutcome> {
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: confirmTimeoutMs });

    return {
      hash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
    };
  }

  /**
   * Signs, broadcasts and waits, reporting which half failed.
   *
   * A write that never produced a hash is a call the node refused or the transport dropped, and
   * nothing is in flight. A write that has a hash and no receipt is a transaction the chain may
   * still mine. The caller has to treat them differently and can only do that if this says which
   * one happened.
   */
  async function send(action: WriteFailed['action'], write: () => Promise<Hex>): Promise<TxOutcome> {
    let hash: Hex;
    try {
      hash = await write();
    } catch (cause) {
      throw new WriteFailed(action, null, cause);
    }

    try {
      return await confirm(hash);
    } catch (cause) {
      throw new WriteFailed(action, hash, cause);
    }
  }

  return {
    latestBlock: async () => {
      const block = await client.getBlock({ blockTag: 'latest', includeTransactions: false });

      return { number: block.number, timestamp: block.timestamp };
    },

    terms: async () => {
      const [settlementAsset, feeBps, resolverFeeBps, disputeBondBps, disputeWindow, resolver] = await Promise.all([
        client.readContract({ address, abi: escrowAbi, functionName: 'settlementAsset' }),
        client.readContract({ address, abi: escrowAbi, functionName: 'feeBps' }),
        client.readContract({ address, abi: escrowAbi, functionName: 'resolverFeeBps' }),
        client.readContract({ address, abi: escrowAbi, functionName: 'disputeBondBps' }),
        client.readContract({ address, abi: escrowAbi, functionName: 'disputeWindow' }),
        client.readContract({ address, abi: escrowAbi, functionName: 'resolver' }),
      ]);

      return { settlementAsset, feeBps, resolverFeeBps, disputeBondBps, disputeWindow, resolver };
    },

    lockedLogs: async (fromBlock, toBlock) => {
      const logs = await client.getLogs({
        address,
        event: LOCKED_EVENT,
        args: { payee: wallet.account.address },
        fromBlock,
        toBlock,
        strict: true,
      });

      return logs.map((entry) => ({
        id: entry.args.id,
        payee: entry.args.payee,
        blockNumber: entry.blockNumber,
      }));
    },

    getLock: async (id) => {
      const lock = await client.readContract({ address, abi: escrowAbi, functionName: 'getLock', args: [id] });

      return {
        payer: lock.payer,
        payee: lock.payee,
        disputer: lock.disputer,
        capabilityId: lock.capabilityId,
        inputCommit: lock.inputCommit,
        outputCommit: lock.outputCommit,
        inputURI: lock.inputURI,
        outputURI: lock.outputURI,
        // The settlement asset is six-decimal USDG and the contract stores atomic units, so this
        // uint128 is already micro-USD. Branding it here keeps ETH, which is gas and a different
        // asset entirely, out of everything downstream.
        amount: micro(lock.amount),
        deadline: lock.deadline,
        releasedAt: lock.releasedAt,
        bond: micro(lock.bond),
        disputedAt: lock.disputedAt,
        status: lock.status,
        counted: lock.counted,
      };
    },

    bondAllowance: async (settlementAsset, owner) => {
      const allowance = await client.readContract({
        address: settlementAsset,
        abi: settlementAssetAbi,
        functionName: 'allowance',
        args: [owner, address],
      });

      return micro(allowance);
    },

    release: async (id, outputCommit, outputURI) =>
      send('release', async () =>
        wallet.writeContract({
          address,
          abi: escrowAbi,
          functionName: 'release',
          args: [id, outputCommit, outputURI],
          ...(await fees()),
        }),
      ),

    finalizeRelease: async (id) =>
      send('finalizeRelease', async () =>
        wallet.writeContract({
          address,
          abi: escrowAbi,
          functionName: 'finalizeRelease',
          args: [id],
          ...(await fees()),
        }),
      ),

    dispute: async (id) =>
      send('dispute', async () =>
        wallet.writeContract({
          address,
          abi: escrowAbi,
          functionName: 'dispute',
          args: [id],
          ...(await fees()),
        }),
      ),
  };
}

/** A dispute over a still-locked payment reverts `NotResolver` when none is wired. */
export function hasResolver(terms: EscrowTerms): boolean {
  return terms.resolver.toLowerCase() !== zeroAddress;
}
