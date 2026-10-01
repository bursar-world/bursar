import { encodeFunctionData, getContract, parseEventLogs } from 'viem';
import type { Address, Chain, GetContractReturnType, Hex, PublicClient, Transport } from 'viem';
import { CURRENT_CONTRACT_SET, ZERO_MICRO, contractSetAtLeast, contractSetOfEscrow, escrowAbi, micro } from '@bursar/core';
import type { ContractSet, Micro } from '@bursar/core';

import { canonicalStringify, commitCanonical, toDataUri } from './commit.js';
import { openConnection, requireSigner, type Connection, type ConnectOptions } from './connection.js';
import { CallRefusedError, InvalidArgumentError, MissingEventError } from './errors.js';
import { formatDuration, toDate } from './format.js';
import { checkAddress, checkBytes32, checkEscrowId } from './guards.js';
import { logsFrom } from './receipt.js';
import { sendCall, type ExplainRevert, type Sent } from './send.js';
import { toLockStatus, type Lock } from './types.js';

export type ReleaseArgs = {
  readonly id: bigint;
  /** Committed as canonical JSON. Supply this or `outputCommit`, never both. */
  readonly output?: unknown;
  readonly outputCommit?: Hex;
  /**
   * Where the payer fetches the delivered output. The chain stores the string, not the payload.
   * Left out with `output`, the bytes are published inline and travel with the release.
   */
  readonly outputURI?: string;
};

type EscrowContract = GetContractReturnType<
  typeof escrowAbi,
  PublicClient<Transport, Chain>,
  Address
>;

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const;

/** The escrow's own terms, fixed at deployment. Read once; they cannot change under a caller. */
export type EscrowTerms = {
  readonly settlementAsset: Address;
  readonly minTtl: bigint;
  readonly maxTtl: bigint;
  readonly disputeWindow: bigint;
  /**
   * The smallest lock the escrow opens, sized so that contesting one always costs a bond. Escrows
   * before v3 refuse only an empty lock, so theirs reads as one micro-USDG.
   */
  readonly minLock: Micro;
  readonly feeBps: number;
  readonly resolverFeeBps: number;
  readonly disputeBondBps: number;
};

/** A payout the escrow booked and has now paid. */
export type OwedClaimReceipt = Sent & { readonly party: Address; readonly amount: Micro };

/** What an escrow before v3 answers for `minLock`: it refuses a lock of zero and nothing else. */
const ONE_MICRO = micro(1n);

/**
 * The escrow from the provider's side of the trade.
 *
 * A payment arrives as a lock against a deadline. Releasing it commits to what was delivered and
 * pays out in the same call, so there is no second step the payer has to take for the provider to
 * be paid. Everything else here is an exit for a job that did not go that way.
 */
export class EscrowClient {
  readonly address: Address;
  readonly connection: Connection;
  readonly terms: EscrowTerms;
  /** The build this escrow runs. Only v3 books payouts as owed. */
  readonly contractSet: ContractSet;

  readonly #escrow: EscrowContract;

  constructor(init: { address: Address; connection: Connection; terms: EscrowTerms; contractSet?: ContractSet }) {
    this.address = init.address;
    this.connection = init.connection;
    this.terms = init.terms;
    this.contractSet = init.contractSet ?? CURRENT_CONTRACT_SET;
    this.#escrow = getContract({
      address: init.address,
      abi: escrowAbi,
      client: init.connection.publicClient,
    });
  }

  /** The full lock record. An id the escrow never issued decodes to a zeroed struct, not an error. */
  async get(id: bigint): Promise<Lock> {
    const lock = await this.#escrow.read.getLock([checkEscrowId('id', id)]);

    return {
      ...lock,
      amount: micro(lock.amount),
      bond: micro(lock.bond),
      status: toLockStatus(lock.status),
    };
  }

  /** When the lock expires and the payer can reclaim it. */
  async deadlineOf(id: bigint): Promise<Date> {
    return toDate((await this.#escrow.read.getLock([checkEscrowId('id', id)])).deadline);
  }

  /** How much of a lock a dispute would cost the party that opens it. */
  bondFor(amount: Micro): Micro {
    return micro((amount * BigInt(this.terms.disputeBondBps)) / 10_000n);
  }

  /** What a release pays out, after the settlement fee the escrow charges the payee's side. */
  payoutFor(amount: Micro): Micro {
    return micro(amount - (amount * BigInt(this.terms.feeBps)) / 10_000n);
  }

  /**
   * Payee only, up to and including the deadline. Commits to the delivered output and takes the
   * payment in the same transaction.
   */
  async release(args: ReleaseArgs): Promise<Sent> {
    if (args.output !== undefined && args.outputCommit !== undefined) {
      throw new InvalidArgumentError(
        'outputCommit',
        'release() takes either an output to commit or an outputCommit already computed, not both.',
      );
    }

    const outputCommit =
      args.outputCommit !== undefined
        ? checkBytes32('outputCommit', args.outputCommit)
        : args.output !== undefined
          ? commitCanonical(args.output)
          : ZERO_BYTES32;

    // An output committed here is published here, in the same canonical bytes that were hashed.
    // A commitment the payer has nowhere to fetch proves nothing to it: its whole check is to
    // recompute the hash over the delivered bytes.
    const outputURI =
      args.outputURI ?? (args.output === undefined ? '' : toDataUri(canonicalStringify(args.output)));

    return this.#send(
      'release',
      encodeFunctionData({
        abi: escrowAbi,
        functionName: 'release',
        args: [checkEscrowId('id', args.id), outputCommit, outputURI],
      }),
    );
  }

  /**
   * Records a release against the payee's history once the dispute window has closed. Anyone can
   * send it, and the payee has the reason to: the cap that gates its next job is read off exactly
   * these counters.
   */
  async finalizeRelease(id: bigint): Promise<Sent> {
    return this.#send(
      'finalizeRelease',
      encodeFunctionData({ abi: escrowAbi, functionName: 'finalizeRelease', args: [checkEscrowId('id', id)] }),
    );
  }

  /** Permissionless once the deadline passes. Refunds the payer in full. */
  async timeout(id: bigint): Promise<Sent> {
    return this.#send(
      'timeout',
      encodeFunctionData({ abi: escrowAbi, functionName: 'timeout', args: [checkEscrowId('id', id)] }),
    );
  }

  /** Payee only, before the deadline. Returns the funds without waiting the deadline out. */
  async cancel(id: bigint): Promise<Sent> {
    return this.#send(
      'cancel',
      encodeFunctionData({ abi: escrowAbi, functionName: 'cancel', args: [checkEscrowId('id', id)] }),
    );
  }

  /**
   * Contests a lock. Opening a dispute on a live lock posts a bond of `disputeBondBps`, which the
   * caller has to have approved to the escrow first. A payer that is a mandate account contests
   * through `disputeSpend` instead, which posts the bond from the account.
   */
  async dispute(id: bigint): Promise<Sent> {
    return this.#send(
      'dispute',
      encodeFunctionData({ abi: escrowAbi, functionName: 'dispute', args: [checkEscrowId('id', id)] }),
    );
  }

  /**
   * What the escrow is holding for `party` because a settlement could not pay it at the time,
   * usually because the token issuer had frozen the address. Zero on an escrow before v3, which
   * paid every leg at once or not at all.
   */
  async owed(party?: Address): Promise<Micro> {
    const who = this.#party('owed', party);
    if (!contractSetAtLeast(this.contractSet, 'v3')) return ZERO_MICRO;
    return micro(await this.#escrow.read.owed([who]));
  }

  /**
   * Pays out what the escrow is holding for `party`, the caller's own address unless another is
   * named. Anyone may send it and the money only ever goes to `party`, which is what lets a mandate
   * account or a frozen-then-cleared wallet be paid without a call of its own.
   */
  async claim(party?: Address): Promise<OwedClaimReceipt> {
    const who = this.#party('claim', party);

    if (!contractSetAtLeast(this.contractSet, 'v3')) {
      throw new CallRefusedError(
        'ZeroAmount',
        'Nothing is owed on this escrow. It pays each party when a settlement goes through, and a ' +
          'settlement it cannot pay does not go through, so it never holds a payout for later.',
        { escrow: this.address, party: who },
      );
    }

    const sent = await this.#send(
      'claim',
      encodeFunctionData({ abi: escrowAbi, functionName: 'claim', args: [who] }),
      who,
    );

    const claimed = parseEventLogs({
      abi: escrowAbi,
      eventName: 'OwedClaimed',
      logs: logsFrom(sent.receipt.logs, this.address),
    })[0];
    if (!claimed) throw new MissingEventError('OwedClaimed', this.address, sent.hash);

    return { ...sent, party: claimed.args.party, amount: micro(claimed.args.amount) };
  }

  #party(action: string, party: Address | undefined): Address {
    return party === undefined ? requireSigner(this.connection, action).account.address : checkAddress('party', party);
  }

  #send(action: string, data: Hex, party?: Address): Promise<Sent> {
    return sendCall(this.connection, { to: this.address, data, action, explain: this.#explain(action, party) });
  }

  #explain(action: string, party?: Address): ExplainRevert {
    return async (revert) => {
      switch (revert?.errorName) {
        case 'NotPayee':
          return new CallRefusedError(
            revert.errorName,
            `Only the provider named on the lock can ${action} it.`,
          );

        case 'NotPayer':
          return new CallRefusedError(
            revert.errorName,
            `Only the payer on the lock can ${action} it. A lock opened by a mandate account has ` +
              'the account as payer, so the principal goes through disputeSpend.',
          );

        case 'NotParty':
          return new CallRefusedError(
            revert.errorName,
            'Only the payer or the payee on this lock can contest it.',
          );

        case 'BadStatus':
          return new CallRefusedError(
            revert.errorName,
            `The lock is not in a state that admits ${action}. Read it with get() to see where it is.`,
          );

        case 'TooLate':
          return new CallRefusedError(
            revert.errorName,
            action === 'dispute'
              ? 'Too late to contest this lock. A held payment can be contested until its deadline, after ' +
                  'which the payer reclaims it with timeout(); a released one only inside the dispute window ' +
                  `(${formatDuration(this.terms.disputeWindow)}) after the release.`
              : 'The deadline has passed. The payer can reclaim the funds with timeout().',
          );

        case 'TooEarly':
          return new CallRefusedError(
            revert.errorName,
            `Too early. The deadline has to pass before a timeout, and the dispute window ` +
              `(${formatDuration(this.terms.disputeWindow)}) has to close before a release is finalised.`,
          );

        case 'BadBond':
          return new CallRefusedError(
            revert.errorName,
            `Contesting a live lock costs a bond of ${this.terms.disputeBondBps} basis points of ` +
              'the locked amount, and the escrow has to be approved to take it first.',
          );

        case 'ZeroAmount':
          return action === 'claim'
            ? new CallRefusedError(
                revert.errorName,
                `Nothing is owed to ${party ?? 'this address'} here. The escrow holds a payout only when a ` +
                  'settlement could not deliver it, and pays it out once.',
              )
            : undefined;

        default:
          return undefined;
      }
    };
  }
}

/**
 * Opens a client for an escrow, reading the terms that bound every lock it holds. The connection's
 * escrow unless another is named: the v1 escrow on 4663 still holds locks that have to be read.
 */
export async function escrow(
  options: Connection | ConnectOptions = {},
  at?: Address,
): Promise<EscrowClient> {
  const connection = await openConnection(options, 'escrow()');
  const address = at ?? connection.addresses.escrow;
  const contractSet = contractSetOfEscrow(address) ?? CURRENT_CONTRACT_SET;
  const read = getContract({ address, abi: escrowAbi, client: connection.publicClient }).read;

  const [settlementAsset, minTtl, maxTtl, disputeWindow, minLock, feeBps, resolverFeeBps, disputeBondBps] =
    await Promise.all([
      read.settlementAsset(),
      read.minTtl(),
      read.maxTtl(),
      read.disputeWindow(),
      contractSetAtLeast(contractSet, 'v3') ? read.minLock().then(micro) : Promise.resolve(ONE_MICRO),
      read.feeBps(),
      read.resolverFeeBps(),
      read.disputeBondBps(),
    ]);

  return new EscrowClient({
    address,
    connection,
    contractSet,
    terms: { settlementAsset, minTtl, maxTtl, disputeWindow, minLock, feeBps, resolverFeeBps, disputeBondBps },
  });
}
