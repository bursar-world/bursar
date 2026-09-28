/**
 * The resolver's side of a dispute, headless.
 *
 * A resolver posts BRSR, sees the contested jobs, seals a score, publishes it, and closes the
 * vote. Sealing and publishing are two transactions separated by a window, which is what stops a
 * late voter copying an early one, and the thing that joins them is a salt this process generates
 * and the chain never sees until the reveal. Losing it is not recoverable: the commitment cannot
 * be opened and the silence is slashed. Every call that produces a salt hands it straight back
 * and says so.
 */

import { encodeAbiParameters, encodeFunctionData, getContract, keccak256, parseEventLogs } from 'viem';
import type { Address, Chain, GetContractReturnType, Hex, PublicClient, Transport } from 'viem';
import { escrowAbi, micro, oracleRegistryAbi } from '@bursar/core';
import type { Micro } from '@bursar/core';

import { brsr, formatBrsr, type Brsr } from './brsr.js';
import { connectFor, requireSigner, type Connection, type ConnectOptions } from './connection.js';
import { DisputePhase, readTerms, type DisputeTerms } from './dispute.js';
import { CallRefusedError, InvalidArgumentError, UnconfirmedCommitError } from './errors.js';
import { formatDuration, toDate } from './format.js';
import { checkAddress, checkBytes32, checkEscrowId, checkRange, UINT128_MAX } from './guards.js';
import { random32 } from './random.js';
import { logsFrom } from './receipt.js';
import { resolverRefusal } from './refusals.js';
import { sendCall, type ExplainRevert, type Sent } from './send.js';
import { toLockStatus, type LockStatus } from './types.js';

/** Mirrors `IOracleRegistry.ResolverStatus`. */
const STANDING = ['none', 'active', 'unbonding', 'exited'] as const;

export type ResolverStanding = (typeof STANDING)[number];

export const SCORE_MAX = 100;

/** What the registry holds against one address. */
export type ResolverStatus = {
  readonly resolver: Address;
  readonly standing: ResolverStanding;
  /** BRSR at risk. Slashing takes from it, and it is not a deposit that earns a return. */
  readonly bond: Brsr;
  /** The least this address may bond right now, as the staking pool reports it. */
  readonly bondFloor: Brsr;
  /** Whether the pool would accept this bond from this address. False for one governance has barred. */
  readonly bondable: boolean;
  /** Disputes this resolver has been counted as having ruled on. */
  readonly ruled: number;
  readonly slashes: number;
  /** Votes still open against this bond. The bond cannot leave while any stand. */
  readonly openVotes: number;
  readonly unbondingSince: Date | null;
  readonly unbondsAt: Date | null;
  /** Settlement-asset rewards waiting to be claimed. Paid in USDG, never in BRSR. */
  readonly rewards: Micro;
  readonly next: string;
};

/** A dispute a resolver can still act on, with the facts a score is formed from. */
export type OpenDispute = {
  readonly disputeId: bigint;
  readonly settlementId: bigint;
  readonly phase: 'committing' | 'revealing';
  readonly openedAt: Date;
  readonly commitEndsAt: Date;
  readonly revealEndsAt: Date;
  readonly commitCount: number;
  readonly revealCount: number;
  readonly quorum: number;
  readonly maxVoters: number;
  /** Where this resolver stands on it: whether it has sealed a score and whether it has published one. */
  readonly committed: boolean;
  readonly revealed: boolean;
  /** The job itself, as the escrow holds it. This is what the score is about. */
  readonly job: {
    readonly payer: Address;
    readonly provider: Address;
    readonly amount: Micro;
    readonly capabilityId: Hex;
    readonly inputCommit: Hex;
    readonly inputURI: string;
    readonly outputCommit: Hex;
    readonly outputURI: string;
    readonly deliverBy: Date;
    readonly deliveredAt: Date | null;
    readonly openedBy: Address;
    readonly status: LockStatus;
  };
  readonly next: string;
};

/**
 * A sealed score, and the salt that is the only way to open it.
 *
 * Everything needed to reveal is here. Nothing on chain or in this process can reconstruct the
 * salt afterwards, so a resolver that drops this object has lost the vote and part of its bond
 * with it.
 */
export type CommitReceipt = {
  readonly disputeId: bigint;
  readonly score: number;
  /** Keep this. Reveal takes the same score and the same salt, and accepts no other pair. */
  readonly salt: Hex;
  readonly commitment: Hex;
  readonly revealFrom: Date;
  readonly revealUntil: Date;
  readonly hash: Hex;
  readonly explorer: string;
  readonly blockNumber: bigint;
  /** Said in words, because a field called `salt` does not tell a caller what happens if it is lost. */
  readonly warning: string;
};

export type ClaimReceipt = Sent & { readonly amount: Micro };

type RegistryContract = GetContractReturnType<
  typeof oracleRegistryAbi,
  PublicClient<Transport, Chain>,
  Address
>;

const STAKING_ABI = [
  {
    type: 'function',
    name: 'minBondOf',
    stateMutability: 'view',
    inputs: [{ name: 'resolver', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isBondable',
    stateMutability: 'view',
    inputs: [
      { name: 'resolver', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/** How far back `openDisputes` walks when the caller names no limit. */
const DEFAULT_DISPUTE_SCAN = 20;

export class ResolverClient {
  /** The `OracleRegistry` this resolver rules through. */
  readonly address: Address;
  readonly connection: Connection;
  readonly terms: DisputeTerms;
  /** BRSR. Bonds are posted in it and slashes are taken from it. */
  readonly bondAsset: Address;
  /** USDG. Resolver rewards are paid in it, because they are a cut of a settlement denominated in it. */
  readonly settlementAsset: Address;
  /** The pool that holds the bond floor. Governance moves it there, never here. */
  readonly staking: Address;

  readonly #registry: RegistryContract;

  constructor(init: {
    address: Address;
    connection: Connection;
    terms: DisputeTerms;
    bondAsset: Address;
    settlementAsset: Address;
    staking: Address;
  }) {
    this.address = init.address;
    this.connection = init.connection;
    this.terms = init.terms;
    this.bondAsset = init.bondAsset;
    this.settlementAsset = init.settlementAsset;
    this.staking = init.staking;
    this.#registry = getContract({
      address: init.address,
      abi: oracleRegistryAbi,
      client: init.connection.publicClient,
    });
  }

  /** The address this client votes as. Reads take an address; writes are this one. */
  get resolver(): Address {
    return requireSigner(this.connection, 'resolver').account.address;
  }

  /** Everything the registry and the staking pool hold against one resolver, in one pass. */
  async status(who?: Address): Promise<ResolverStatus> {
    const resolver = who === undefined ? this.resolver : checkAddress('resolver', who);

    const [record, openVotes, rewards, floor] = await Promise.all([
      this.#registry.read.getResolver([resolver]),
      this.#registry.read.openVotes([resolver]),
      this.#registry.read.rewardsOf([resolver]),
      this.#floor(resolver),
    ]);

    const bond = brsr(record.bond);
    const bondable = await this.#bondable(resolver, bond);
    const standing = STANDING[record.status] ?? 'none';
    const unbondingSince = record.unbondingAt === 0n ? null : toDate(record.unbondingAt);
    const unbondsAt =
      record.unbondingAt === 0n ? null : toDate(record.unbondingAt + this.terms.unbondingPeriod);

    return {
      resolver,
      standing,
      bond,
      bondFloor: floor,
      bondable,
      ruled: record.finalized,
      slashes: record.slashes,
      openVotes,
      unbondingSince,
      unbondsAt,
      rewards: micro(rewards),
      next: standingNote({ standing, bond, floor, bondable, openVotes, unbondsAt, rewards: micro(rewards) }),
    };
  }

  /** The least BRSR this address may bond right now. Governance can raise it under a live resolver. */
  async bondFloor(who?: Address): Promise<Brsr> {
    return this.#floor(who === undefined ? this.resolver : checkAddress('resolver', who));
  }

  /**
   * Disputes still open to a vote, newest first.
   *
   * Read straight off the registry rather than out of an index, so a resolver needs nothing but a
   * node to do its job. The walk starts at the newest dispute and stops after `limit` of them,
   * which is the recent end of the roster and the only end where a window is still open.
   */
  async openDisputes(options: { limit?: number } = {}): Promise<OpenDispute[]> {
    const limit = options.limit ?? DEFAULT_DISPUTE_SCAN;

    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new InvalidArgumentError('limit', `limit must be a positive whole number, received ${limit}.`);
    }

    const next = await this.#registry.read.nextDisputeId();
    const newest = next - 1n;
    if (newest <= 0n) return [];

    const oldest = newest - BigInt(limit) + 1n;
    const ids: bigint[] = [];
    for (let id = newest; id >= (oldest > 1n ? oldest : 1n); id -= 1n) ids.push(id);

    const votes = await Promise.all(ids.map((id) => this.#registry.read.getDispute([id])));
    const voter = this.connection.account?.address;

    const open = ids
      .map((disputeId, index) => ({ disputeId, vote: votes[index] }))
      .filter(
        (entry): entry is { disputeId: bigint; vote: NonNullable<(typeof votes)[number]> } =>
          entry.vote !== undefined &&
          (entry.vote.status === DisputePhase.Committing || entry.vote.status === DisputePhase.Revealing),
      );

    const escrowContract = getContract({
      address: this.connection.addresses.escrow,
      abi: escrowAbi,
      client: this.connection.publicClient,
    });

    return Promise.all(
      open.map(async ({ disputeId, vote }) => {
        const [lock, commitment, revealed] = await Promise.all([
          escrowContract.read.getLock([vote.escrowId]),
          voter === undefined
            ? Promise.resolve<Hex>(`0x${'00'.repeat(32)}`)
            : this.#registry.read.committedBy([disputeId, voter]),
          voter === undefined
            ? Promise.resolve<readonly [boolean, number]>([false, 0])
            : this.#registry.read.revealedBy([disputeId, voter]),
        ]);

        const phase = vote.status === DisputePhase.Committing ? 'committing' : 'revealing';
        const committed = !/^0x0+$/u.test(commitment);

        return {
          disputeId,
          settlementId: vote.escrowId,
          phase,
          openedAt: toDate(vote.openedAt),
          commitEndsAt: toDate(vote.commitEndsAt),
          revealEndsAt: toDate(vote.revealEndsAt),
          commitCount: vote.commitCount,
          revealCount: vote.revealCount,
          quorum: this.terms.quorum,
          maxVoters: this.terms.maxVoters,
          committed,
          revealed: revealed[0],
          job: {
            payer: lock.payer,
            provider: lock.payee,
            amount: micro(lock.amount),
            capabilityId: lock.capabilityId,
            inputCommit: lock.inputCommit,
            inputURI: lock.inputURI,
            outputCommit: lock.outputCommit,
            outputURI: lock.outputURI,
            deliverBy: toDate(lock.deadline),
            deliveredAt: lock.releasedAt === 0n ? null : toDate(lock.releasedAt),
            openedBy: lock.disputer,
            status: toLockStatus(lock.status),
          },
          next: voteNote(phase, committed, revealed[0], vote.commitEndsAt, vote.revealEndsAt),
        } satisfies OpenDispute;
      }),
    );
  }

  /** Joins the roster with a bond in BRSR. The pool has to be willing to accept it from this address. */
  async bond(amount: Brsr): Promise<Sent> {
    return this.#send(
      'register',
      encodeFunctionData({
        abi: oracleRegistryAbi,
        functionName: 'register',
        args: [this.#bondAmount('bond', amount)],
      }),
    );
  }

  /** Tops the bond back up. The total has to clear the floor, not the increment. */
  async increaseBond(amount: Brsr): Promise<Sent> {
    return this.#send(
      'increaseBond',
      encodeFunctionData({
        abi: oracleRegistryAbi,
        functionName: 'increaseBond',
        args: [this.#bondAmount('amount', amount)],
      }),
    );
  }

  /**
   * Seals a score against a dispute and hands back the salt that opens it.
   *
   * The commitment covers the dispute id, this resolver's address, the score and the salt, so a
   * commitment cannot be lifted from the mempool and replayed by another resolver. It is computed
   * here and checked against the registry's own `commitmentHash` before the transaction is sent,
   * and read back off the chain afterwards, because a commitment that does not match the pair held
   * in memory can never be revealed and is slashed as silence.
   */
  async commit(args: { disputeId: bigint; score: number; salt?: Hex }): Promise<CommitReceipt> {
    const disputeId = checkEscrowId('disputeId', args.disputeId);
    const score = checkScore(args.score);
    const salt = args.salt === undefined ? random32() : checkBytes32('salt', args.salt);
    const resolver = this.resolver;
    const commitment = commitmentFor({ disputeId, resolver, score, salt });

    const [onChain, vote] = await Promise.all([
      this.#registry.read.commitmentHash([disputeId, resolver, score, salt]),
      this.#registry.read.getDispute([disputeId]),
    ]);

    if (onChain.toLowerCase() !== commitment.toLowerCase()) {
      throw new CallRefusedError(
        'BadReveal',
        'This package and the registry compute a commitment differently, so a score sealed here ' +
          'could never be revealed and the bond would be slashed for the silence. Nothing was sent. ' +
          'The deployment is ahead of @bursar/sdk; upgrade the package.',
        { registry: this.address, computed: commitment, onChain },
      );
    }

    let sent: Sent;
    let written: Hex;

    // From here the commitment may reach the chain, and the salt is the only thing that opens it.
    // Any failure has to hand the salt back rather than drop it with the stack.
    try {
      sent = await this.#send(
        'commitVote',
        encodeFunctionData({
          abi: oracleRegistryAbi,
          functionName: 'commitVote',
          args: [disputeId, commitment],
        }),
      );

      written = await this.#registry.read.committedBy([disputeId, resolver]);
    } catch (error) {
      throw new UnconfirmedCommitError({ disputeId, score, salt, cause: error });
    }

    if (written.toLowerCase() !== commitment.toLowerCase()) {
      throw new CallRefusedError(
        'AlreadyCommitted',
        `The commitment now on record for dispute ${disputeId} against ${resolver} is not the one ` +
          `this call sealed, so the score and salt held here will not open it. Salt ${salt} and ` +
          `score ${score} are the pair this transaction used; keep them and read the dispute before ` +
          'revealing.',
        {
          registry: this.address,
          disputeId: disputeId.toString(),
          score,
          salt,
          expected: commitment,
          onChain: written,
          hash: sent.hash,
        },
      );
    }

    const revealFrom = toDate(vote.commitEndsAt);
    const revealUntil = toDate(vote.revealEndsAt);

    return {
      disputeId,
      score,
      salt,
      commitment,
      revealFrom,
      revealUntil,
      hash: sent.hash,
      explorer: sent.explorer,
      blockNumber: sent.blockNumber,
      warning: saltWarning(salt, revealFrom, revealUntil, this.terms.revealWindow),
    };
  }

  /** Publishes a sealed score. Only the exact score and salt the commitment was made from open it. */
  async reveal(args: { disputeId: bigint; score: number; salt: Hex }): Promise<Sent> {
    return this.#send(
      'revealVote',
      encodeFunctionData({
        abi: oracleRegistryAbi,
        functionName: 'revealVote',
        args: [checkEscrowId('disputeId', args.disputeId), checkScore(args.score), checkBytes32('salt', args.salt)],
      }),
    );
  }

  /**
   * Closes a vote that reached quorum, which is also what tells the escrow how to split the lock.
   * Permissionless: anyone can pay for it, and the payer of the contested job has the most reason to.
   */
  async finalize(disputeId: bigint): Promise<Sent> {
    return this.#send(
      'finalize',
      encodeFunctionData({
        abi: oracleRegistryAbi,
        functionName: 'finalize',
        args: [checkEscrowId('disputeId', disputeId)],
      }),
    );
  }

  /** Closes a vote that never reached quorum. The escrow refunds the payer in full. */
  async failDispute(disputeId: bigint): Promise<Sent> {
    return this.#send(
      'failDispute',
      encodeFunctionData({
        abi: oracleRegistryAbi,
        functionName: 'failDispute',
        args: [checkEscrowId('disputeId', disputeId)],
      }),
    );
  }

  /** Takes the settlement-asset rewards this resolver has accrued. An exited resolver still collects. */
  async claimRewards(): Promise<ClaimReceipt> {
    const owed = await this.#registry.read.rewardsOf([this.resolver]);
    const sent = await this.#send(
      'claimRewards',
      encodeFunctionData({ abi: oracleRegistryAbi, functionName: 'claimRewards' }),
    );

    const claimed = parseEventLogs({
      abi: oracleRegistryAbi,
      eventName: 'RewardsClaimed',
      logs: logsFrom(sent.receipt.logs, this.address),
    })[0];

    return { ...sent, amount: micro(claimed?.args.amount ?? owed) };
  }

  /**
   * Starts an exit; `completeUnbond` finishes it and `cancelUnbond` calls it off. Stops this resolver
   * being drawn into new disputes and starts the cooldown.
   */
  async requestUnbond(): Promise<Sent> {
    return this.#send(
      'requestUnbond',
      encodeFunctionData({ abi: oracleRegistryAbi, functionName: 'requestUnbond' }),
    );
  }

  /** Finishes the exit. Returns the bond once the cooldown matures and no vote still holds it. */
  async completeUnbond(): Promise<Sent> {
    return this.#send(
      'completeUnbond',
      encodeFunctionData({ abi: oracleRegistryAbi, functionName: 'completeUnbond' }),
    );
  }

  /** Calls the exit off. Puts the resolver back on the roster without touching the bond. */
  async cancelUnbond(): Promise<Sent> {
    return this.#send(
      'cancelUnbond',
      encodeFunctionData({ abi: oracleRegistryAbi, functionName: 'cancelUnbond' }),
    );
  }

  #bondAmount(field: string, amount: Brsr): bigint {
    const checked = checkRange(field, amount, UINT128_MAX);

    if (checked <= 0n) {
      throw new InvalidArgumentError(
        field,
        `${field} must be greater than zero. Bonds are BRSR in its own eighteen decimals, so one ` +
          'whole token is 1000000000000000000n.',
      );
    }

    return checked;
  }

  async #floor(resolver: Address): Promise<Brsr> {
    return brsr(
      await this.connection.publicClient.readContract({
        address: this.staking,
        abi: STAKING_ABI,
        functionName: 'minBondOf',
        args: [resolver],
      }),
    );
  }

  async #bondable(resolver: Address, amount: Brsr): Promise<boolean> {
    return this.connection.publicClient.readContract({
      address: this.staking,
      abi: STAKING_ABI,
      functionName: 'isBondable',
      args: [resolver, amount],
    });
  }

  #send(action: string, data: Hex): Promise<Sent> {
    return sendCall(this.connection, { to: this.address, data, action, explain: this.#explain(action) });
  }

  #explain(action: string): ExplainRevert {
    return async (revert) => {
      if (!revert) return undefined;

      if (revert.errorName === 'BondNotAccepted') {
        const offered = typeof revert.args[0] === 'bigint' ? brsr(revert.args[0]) : undefined;
        const required = typeof revert.args[1] === 'bigint' ? brsr(revert.args[1]) : undefined;

        if (offered !== undefined && required !== undefined) {
          return new CallRefusedError(
            revert.errorName,
            offered >= required
              ? `The staking pool refuses a bond from this address at any size. ${formatBrsr(offered)} ` +
                  `BRSR was offered against a floor of ${formatBrsr(required)}, so the refusal is a bar ` +
                  'governance has placed on the address and not a shortfall. Nothing was bonded.'
              : `${action} offered ${formatBrsr(offered)} BRSR and this address has to post at least ` +
                  `${formatBrsr(required)} BRSR. Nothing was bonded. The floor lives in the staking pool ` +
                  'and governance can raise it under a resolver already on the roster.',
            { registry: this.address, offered: offered.toString(), required: required.toString() },
          );
        }
      }

      const refusal = resolverRefusal(revert.errorName);

      return refusal === null
        ? undefined
        : new CallRefusedError(refusal.code, refusal.message, { registry: this.address, owner: refusal.owner });
    };
  }
}

/**
 * The commitment the registry checks a reveal against: `keccak256(abi.encode(disputeId, resolver,
 * score, salt))`. The resolver address sits inside it, so one resolver's sealed score is useless
 * to another that watched it go by.
 */
export function commitmentFor(args: {
  disputeId: bigint;
  resolver: Address;
  score: number;
  salt: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'uint8' }, { type: 'bytes32' }],
      [
        checkEscrowId('disputeId', args.disputeId),
        checkAddress('resolver', args.resolver),
        checkScore(args.score),
        checkBytes32('salt', args.salt),
      ],
    ),
  );
}

function checkScore(score: number): number {
  if (!Number.isSafeInteger(score) || score < 0 || score > SCORE_MAX) {
    throw new InvalidArgumentError(
      'score',
      `score must be a whole number from 0 to ${SCORE_MAX}, where 0 is nothing delivered and ` +
        `${SCORE_MAX} is delivered as agreed. Received ${String(score)}.`,
      { score },
    );
  }

  return score;
}

function saltWarning(salt: Hex, from: Date, until: Date, revealWindow: bigint): string {
  return (
    `Keep salt ${salt}. It is the only way to reveal this score: the commitment on chain covers the ` +
    'dispute id, this resolver address, the score and the salt, and the registry checks all four, so ' +
    'nothing else opens it and nothing can recompute it. Reveal between ' +
    `${from.toISOString()} and ${until.toISOString()}. The reveal window is ` +
    `${formatDuration(revealWindow)} long and it does not reopen. A commitment still sealed when it ` +
    'shuts counts as silence, and part of the bond is taken for it.'
  );
}

function standingNote(state: {
  standing: ResolverStanding;
  bond: Brsr;
  floor: Brsr;
  bondable: boolean;
  openVotes: number;
  unbondsAt: Date | null;
  rewards: Micro;
}): string {
  const owed =
    state.rewards > 0n ? ` There are rewards waiting; claimRewards takes them in USDG.` : '';

  switch (state.standing) {
    case 'none':
      return (
        `This address is not on the roster. Bonding ${formatBrsr(state.floor)} BRSR joins it, and that ` +
        'BRSR is collateral at risk rather than a deposit: a vote that goes silent or lands far from ' +
        'the room loses part of it.'
      );
    case 'unbonding':
      return (
        (state.openVotes > 0
          ? `${state.openVotes} vote${state.openVotes === 1 ? '' : 's'} still hold this bond, so it ` +
            'cannot leave until they settle. '
          : '') +
        (state.unbondsAt === null
          ? 'The cooldown is running.'
          : `The cooldown matures at ${state.unbondsAt.toISOString()}, after which completeUnbond ` +
            'returns the bond. cancelUnbond puts this resolver back on the roster instead.') +
        owed
      );
    case 'exited':
      return `This resolver has left the roster. Bonding again puts it back on, with its history intact.${owed}`;
    default:
      return (
        (state.bondable
          ? `Bonded and able to vote, with ${formatBrsr(state.bond)} BRSR at risk against a floor of ` +
            `${formatBrsr(state.floor)}.`
          : `Bonded with ${formatBrsr(state.bond)} BRSR, which is under the ${formatBrsr(state.floor)} ` +
            'floor this address has to clear, so its votes are refused until increaseBond covers the ' +
            'difference.') + owed
      );
  }
}

function voteNote(
  phase: 'committing' | 'revealing',
  committed: boolean,
  revealed: boolean,
  commitEndsAt: bigint,
  revealEndsAt: bigint,
): string {
  if (revealed) return 'This resolver has published its score here. Nothing further to send.';

  if (committed) {
    return phase === 'committing'
      ? `Sealed. Reveal the same score and salt after ${toDate(commitEndsAt).toISOString()} and before ` +
          `${toDate(revealEndsAt).toISOString()}. A commitment left sealed past that is slashed.`
      : `Reveal the same score and salt before ${toDate(revealEndsAt).toISOString()}. A commitment left ` +
          'sealed past that is slashed.';
  }

  return phase === 'committing'
    ? `Open for a sealed score until ${toDate(commitEndsAt).toISOString()}. Nothing is at stake until ` +
        'one is committed.'
    : 'The commit window has shut and this resolver did not seal a score, so it takes no part in this ' +
        'vote and nothing is at stake on it.';
}

/** Opens a resolver client against the dispute layer this deployment's escrow rules through. */
export async function resolver(options: Connection | ConnectOptions = {}): Promise<ResolverClient> {
  const connection = connectFor(options, 'resolver()');
  const address = await getContract({
    address: connection.addresses.escrow,
    abi: escrowAbi,
    client: connection.publicClient,
  }).read.resolver();

  if (/^0x0+$/u.test(address)) {
    throw new CallRefusedError(
      'NotResolver',
      `Escrow ${connection.addresses.escrow} has no dispute layer wired to it, so there is nothing ` +
        'here to resolve for. A job that is never delivered is still refunded once its delivery ' +
        'deadline passes.',
      { escrow: connection.addresses.escrow },
    );
  }

  const read = getContract({ address, abi: oracleRegistryAbi, client: connection.publicClient }).read;
  const [terms, bondAsset, settlementAsset, staking] = await Promise.all([
    readTerms(connection.publicClient, address),
    read.bondAsset(),
    read.settlementAsset(),
    read.staking(),
  ]);

  if (terms === null) {
    throw new CallRefusedError('BadConfig', `${address} does not answer as a dispute registry.`, {
      registry: address,
    });
  }

  if (/^0x0+$/u.test(staking)) {
    throw new CallRefusedError(
      'StakingNotSet',
      `Dispute registry ${address} has no staking pool wired to it, so it holds no bond floor and ` +
        'nobody can bond. The deployer closes that pairing once. Report it to the operator.',
      { registry: address },
    );
  }

  return new ResolverClient({ address, connection, terms, bondAsset, settlementAsset, staking });
}
