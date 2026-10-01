/**
 * The dispute layer, from the side that rules on it.
 *
 * A resolver reads the contested jobs off the registry and the escrow, seals a score, publishes it
 * and closes the vote. Sealing and publishing are two transactions with a window between them,
 * which is what stops a late voter copying an early one, and the thing that joins them is a salt
 * generated here that the chain does not see until the reveal.
 *
 * Losing that salt is not recoverable. The commitment cannot be opened, the silence is slashed,
 * and nothing gets it back. So the salt is returned in the reply, in a field
 * of its own and again in a sentence, and the commitment is checked against the registry's own
 * hash before the transaction goes and read back off the chain after it lands.
 */

import { contractSetOfRegistry, escrowAbi, oracleRegistryAbi } from '@bursar/core';
import type { RhcPublicClient } from '@bursar/core';
import { encodeAbiParameters, keccak256 } from 'viem';
import type { Address, Hex } from 'viem';

import { ToolError } from './errors.js';
import { bond as bondView, duration, instant, moneyFromUint } from './format.js';
import type { RelayTransactionReceipt, RoleRelay } from './relay.js';
import { untrusted } from './untrusted.js';
import { statusOf } from './views.js';
import type {
  ActionView,
  CommitView,
  OpenDisputeView,
  OpenDisputesView,
  ResolverGateway,
  ResolverStanding,
  ResolverStatusView,
} from './types.js';

export type ResolverGatewayOptions = {
  readonly client: RhcPublicClient;
  /** The address the relay signs as. It is inside every commitment, so it has to be exact. */
  readonly resolver: Address;
  readonly registry: Address;
  readonly escrow: Address;
  /** Absent when no signer is configured. The reads still answer; the writes are not advertised. */
  readonly relay: RoleRelay | null;
  /** Injected so a suite can seal a known salt. Defaults to the platform CSPRNG. */
  readonly randomSalt?: () => Hex;
};

/** Mirrors `IOracleRegistry.ResolverStatus`. */
const STANDING: readonly ResolverStanding[] = ['none', 'active', 'unbonding', 'exited'];

const DISPUTE_PHASE = { None: 0, Committing: 1, Revealing: 2, Finalized: 3, Failed: 4 } as const;

const ZERO32: Hex = `0x${'00'.repeat(32)}`;

/**
 * The staking pool answers the bond floor. Only the two questions this server asks are declared,
 * because a fuller ABI would invite reads that belong to the token page rather than to a resolver.
 */
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

/**
 * `keccak256(abi.encode(disputeId, resolver, score, salt))`, which is what the registry checks a
 * reveal against. The resolver address is inside it, so one resolver's sealed score is useless to
 * another that watched it go by.
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
      [args.disputeId, args.resolver, args.score, args.salt],
    ),
  );
}

function randomSalt(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createResolverGateway(options: ResolverGatewayOptions): ResolverGateway {
  const { client, resolver, registry, escrow, relay } = options;
  const saltFor = options.randomSalt ?? randomSalt;

  const registryContract = { address: registry, abi: oracleRegistryAbi } as const;
  const escrowContract = { address: escrow, abi: escrowAbi } as const;
  // A vote that misses quorum refunds the payer on the first set and reopens the payment on every
  // later one. An address no record names is taken as the current set, as the mandate reads are.
  const firstSet = contractSetOfRegistry(registry) === 'v1';

  function requireRelay(): RoleRelay {
    if (relay === null) {
      throw new ToolError(
        'relay_unconfigured',
        'This server is reading the dispute layer only. Set BURSAR_RELAY_URL to the signer that holds ' +
          'the resolver address it votes as, then restart it.',
      );
    }

    return relay;
  }

  async function status(): Promise<ResolverStatusView> {
    const [block, reads] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.multicall({
        allowFailure: false,
        contracts: [
          { ...registryContract, functionName: 'getResolver', args: [resolver] },
          { ...registryContract, functionName: 'openVotes', args: [resolver] },
          { ...registryContract, functionName: 'rewardsOf', args: [resolver] },
          { ...registryContract, functionName: 'config' },
          { ...registryContract, functionName: 'staking' },
        ],
      }),
    ]);

    const [record, openVotes, rewards, config, staking] = reads;

    if (/^0x0+$/u.test(staking)) {
      throw new ToolError(
        'registry_unwired',
        'This dispute registry has no staking pool wired to it, so it holds no bond floor and nobody ' +
          'can bond. Nothing an agent sends changes that. Report it to the operator.',
        { registry },
      );
    }

    const [floor, bondable] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: staking, abi: STAKING_ABI, functionName: 'minBondOf', args: [resolver] },
        { address: staking, abi: STAKING_ABI, functionName: 'isBondable', args: [resolver, record.bond] },
      ],
    });

    const standing = STANDING[record.status] ?? 'none';
    const unbondsAt = record.unbondingAt === 0n ? null : record.unbondingAt + config.unbondingPeriod;

    return {
      resolver,
      registry,
      standing,
      bond: bondView(record.bond),
      bondFloor: bondView(floor),
      bondable,
      ruled: record.finalized,
      slashes: record.slashes,
      openVotes,
      unbondsAt: unbondsAt === null ? null : instant(unbondsAt),
      rewards: moneyFromUint(rewards),
      commitWindowSeconds: Number(config.commitWindow),
      revealWindowSeconds: Number(config.revealWindow),
      quorum: config.quorum,
      maxVoters: config.maxVoters,
      maxDeviation: config.maxDeviation,
      slashBps: config.slashBps,
      next: standingNote({
        standing,
        bond: record.bond,
        floor,
        bondable,
        openVotes,
        unbondsAt,
        rewards,
      }),
      observedAt: instant(block.timestamp),
    };
  }

  /**
   * Read straight off the registry rather than out of an index, so a resolver needs nothing but a
   * node to do its job. The walk starts at the newest dispute, which is the only end where a
   * window can still be open.
   */
  async function openDisputes(limit: number): Promise<OpenDisputesView> {
    const [block, [next, config]] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.multicall({
        allowFailure: false,
        contracts: [
          { ...registryContract, functionName: 'nextDisputeId' },
          { ...registryContract, functionName: 'config' },
        ],
      }),
    ]);

    const newest = next - 1n;

    if (newest <= 0n) return { disputes: [], observedAt: instant(block.timestamp) };

    const floor = newest - BigInt(limit) + 1n;
    const ids: bigint[] = [];
    for (let id = newest; id >= (floor > 1n ? floor : 1n); id -= 1n) ids.push(id);

    const votes = await client.multicall({
      allowFailure: false,
      contracts: ids.map((id) => ({ ...registryContract, functionName: 'getDispute', args: [id] }) as const),
    });

    const open = ids
      .map((disputeId, index) => ({ disputeId, vote: votes[index] }))
      .filter(
        (entry): entry is { disputeId: bigint; vote: NonNullable<(typeof votes)[number]> } =>
          entry.vote !== undefined &&
          (entry.vote.status === DISPUTE_PHASE.Committing || entry.vote.status === DISPUTE_PHASE.Revealing),
      );

    if (open.length === 0) return { disputes: [], observedAt: instant(block.timestamp) };

    const details = await client.multicall({
      allowFailure: false,
      contracts: open.flatMap(
        ({ disputeId, vote }) =>
          [
            { ...escrowContract, functionName: 'getLock', args: [vote.escrowId] },
            { ...registryContract, functionName: 'committedBy', args: [disputeId, resolver] },
            { ...registryContract, functionName: 'revealedBy', args: [disputeId, resolver] },
          ] as const,
      ),
    });

    const disputes: OpenDisputeView[] = open.map(({ disputeId, vote }, index) => {
      const lock = details[index * 3] as Extract<(typeof details)[number], { payer: Address }>;
      const commitment = details[index * 3 + 1] as Hex;
      const revealed = details[index * 3 + 2] as readonly [boolean, number];
      const phase = vote.status === DISPUTE_PHASE.Committing ? 'committing' : 'revealing';
      const committed = commitment !== ZERO32;

      return {
        disputeId: disputeId.toString(),
        settlementId: vote.escrowId.toString(),
        phase,
        commitEndsAt: instant(vote.commitEndsAt),
        revealEndsAt: instant(vote.revealEndsAt),
        commitCount: vote.commitCount,
        revealCount: vote.revealCount,
        quorum: config.quorum,
        maxVoters: config.maxVoters,
        committed,
        revealed: revealed[0],
        job: {
          payer: lock.payer,
          provider: lock.payee,
          amount: moneyFromUint(lock.amount),
          capabilityId: lock.capabilityId,
          inputCommit: lock.inputCommit,
          // Both parties to a contested job wrote onto the lock, and a resolver is counterparty to
          // both. What either wrote reaches the model as data, inside an envelope that says so.
          inputURI: lock.inputURI === '' ? '' : untrusted(lock.inputURI, 'the inputURI the payer wrote'),
          outputCommit: lock.outputCommit === ZERO32 ? null : lock.outputCommit,
          outputURI: lock.outputURI === '' ? null : untrusted(lock.outputURI, 'the outputURI the provider wrote'),
          deliverBy: instant(lock.deadline),
          deliveredAt: lock.releasedAt === 0n ? null : instant(lock.releasedAt),
          contestedBy: lock.disputer,
        },
        next: voteNote(phase, committed, revealed[0], vote.commitEndsAt, vote.revealEndsAt, statusOf(lock.status)),
      };
    });

    return { disputes, observedAt: instant(block.timestamp) };
  }

  async function commit(request: { disputeId: bigint; score: number }): Promise<CommitView> {
    // Before anything is read or generated: a salt this process makes and then cannot send is a
    // salt a caller might keep, believing a score was sealed under it.
    const signer = requireRelay();
    const { disputeId, score } = request;
    const salt = saltFor();
    const commitment = commitmentFor({ disputeId, resolver, score, salt });

    const [vote, onChain] = await client.multicall({
      allowFailure: false,
      contracts: [
        { ...registryContract, functionName: 'getDispute', args: [disputeId] },
        { ...registryContract, functionName: 'commitmentHash', args: [disputeId, resolver, score, salt] },
      ],
    });

    if (vote.status !== DISPUTE_PHASE.Committing) {
      throw new ToolError(
        'resolver_refused',
        vote.status === DISPUTE_PHASE.None
          ? `No dispute carries id ${disputeId.toString()}. resolver_list_disputes reports the ones ` +
              'open to a vote. Nothing was sent.'
          : `Dispute ${disputeId.toString()} is no longer taking sealed scores. Nothing was sent, and ` +
              'nothing is at stake on a dispute this resolver never committed to.',
        { disputeId: disputeId.toString() },
      );
    }

    // A commitment this server computes differently from the registry could never be revealed, and
    // the silence costs a bond. One read is cheaper than every way of finding out afterwards.
    if (onChain.toLowerCase() !== commitment.toLowerCase()) {
      throw new ToolError(
        'commitment_mismatch',
        'This server and the dispute registry compute a commitment differently, so a score sealed now ' +
          'could never be revealed and part of the bond would be taken for the silence. Nothing was ' +
          'sent. Report it to the operator.',
        { registry, computed: commitment, onChain },
      );
    }

    let receipt: RelayTransactionReceipt;
    let written: Hex;

    // From here the commitment may reach the chain, and the salt is the only thing that opens it.
    // Whatever fails has to carry the salt out with it rather than drop it.
    try {
      receipt = await signer.resolverCall({
        resolver,
        action: 'commit',
        disputeId: disputeId.toString(),
        commitment,
      });

      written = await client.readContract({
        ...registryContract,
        functionName: 'committedBy',
        args: [disputeId, resolver],
      });
    } catch (error) {
      throw unconfirmedCommit(error, { disputeId, score, salt });
    }

    if (written.toLowerCase() !== commitment.toLowerCase()) {
      throw new ToolError(
        'commitment_mismatch',
        `The commitment now on record for dispute ${disputeId.toString()} against ${resolver} is not ` +
          `the one this call sealed, so the salt below will not open it. Salt ${salt} and score ` +
          `${score} are the pair this transaction used: keep them, and read the dispute before ` +
          'revealing anything.',
        { disputeId: disputeId.toString(), salt, score, expected: commitment, onChain: written, txHash: receipt.txHash },
      );
    }

    const revealWindow = vote.revealEndsAt - vote.commitEndsAt;

    return {
      disputeId: disputeId.toString(),
      score,
      salt,
      commitment,
      txHash: receipt.txHash,
      revealFrom: instant(vote.commitEndsAt),
      revealUntil: instant(vote.revealEndsAt),
      revealWindowSeconds: Number(revealWindow),
      warning: saltWarning(salt, vote.commitEndsAt, vote.revealEndsAt, revealWindow),
      next:
        `Call resolver_reveal_score with dispute ${disputeId.toString()}, score ${score} and this ` +
        `salt, after ${instant(vote.commitEndsAt)} and before ${instant(vote.revealEndsAt)}.`,
    };
  }

  async function send(
    request: Parameters<RoleRelay['resolverCall']>[0],
    action: string,
    next: string,
  ): Promise<ActionView> {
    const receipt = await requireRelay().resolverCall(request);

    return { txHash: receipt.txHash, action, next };
  }

  return {
    status,
    openDisputes,
    commit,

    bond: (amount) =>
      send({ resolver, action: 'bond', amount: amount.toString() }, 'resolver_post_bond',
        'The bond is posted and this resolver is on the roster. resolver_list_disputes shows what is ' +
          'open to a vote. The BRSR is at risk from here: a vote that goes silent or lands far from ' +
          'the room loses part of it.'),

    addBond: (amount) =>
      send({ resolver, action: 'add-bond', amount: amount.toString() }, 'resolver_add_bond',
        'The bond is larger. resolver_status reports it against the floor this address has to clear ' +
          'before its next vote is accepted.'),

    reveal: (request) =>
      send(
        {
          resolver,
          action: 'reveal',
          disputeId: request.disputeId.toString(),
          score: request.score,
          salt: request.salt,
        },
        'resolver_reveal_score',
        'The score is published. Nothing more is at stake on this dispute: closing it is ' +
          'permissionless, and resolver_finalize_dispute is how this resolver does it once the ' +
          'window shuts.',
      ),

    finalize: (disputeId) =>
      send({ resolver, action: 'finalize', disputeId: disputeId.toString() }, 'resolver_finalize_dispute',
        'The vote is closed and the escrow has moved the money on the median score. The resolver fee ' +
          'accrues to the resolvers whose scores held; resolver_claim_rewards takes this one’s share.'),

    fail: (disputeId) =>
      send({ resolver, action: 'fail', disputeId: disputeId.toString() }, 'resolver_fail_dispute',
        firstSet
          ? 'The vote is closed as unusable. On this first contract set the escrow has refunded the payer, ' +
              'less the resolver fee, and returned the bond to whoever contested it.'
          : 'The vote is closed as unusable. The escrow has put the payment back on hold with a new ' +
              'deadline for the provider and returned the bond to whoever contested it. No resolver fee is ' +
              'paid on a dispute that produced no result.'),

    claimRewards: () =>
      send({ resolver, action: 'claim-rewards' }, 'resolver_claim_rewards',
        'The rewards are paid out in USDG, which is the asset the settlements they came from were in. ' +
          'Bonds are BRSR and are untouched by this.'),

    requestUnbond: () =>
      send({ resolver, action: 'request-unbond' }, 'resolver_request_unbond',
        'The cooldown has started and this resolver takes no new disputes. resolver_status reports ' +
          'when the bond matures. resolver_cancel_unbond puts it back on the roster instead.'),

    completeUnbond: () =>
      send({ resolver, action: 'complete-unbond' }, 'resolver_complete_unbond',
        'The bond is returned and this resolver has left the roster. Rewards already earned survive ' +
          'the exit and resolver_claim_rewards still takes them.'),

    cancelUnbond: () =>
      send({ resolver, action: 'cancel-unbond' }, 'resolver_cancel_unbond',
        'The exit is called off and this resolver is back on the roster. The bond was never moved.'),
  };
}

/**
 * What a resolver is told about the salt, in words.
 *
 * A field called `salt` does not say what losing it costs, and the cost is the whole of why this
 * sentence exists: a commitment that is never opened is treated as silence, and silence is what
 * the slash is for.
 */
function saltWarning(salt: Hex, commitEndsAt: bigint, revealEndsAt: bigint, revealWindow: bigint): string {
  return (
    `Keep salt ${salt}. It is the only way to reveal this score: the commitment on chain covers the ` +
    'dispute id, this resolver address, the score and the salt, and the registry checks all four, so ' +
    'nothing else opens it and nothing can recompute it. Reveal between ' +
    `${instant(commitEndsAt)} and ${instant(revealEndsAt)}. The reveal window is ` +
    `${duration(Number(revealWindow))} long and it does not reopen. A commitment still sealed when it ` +
    'shuts counts as silence, and part of the bond is taken for it.'
  );
}

function standingNote(state: {
  standing: ResolverStanding;
  bond: bigint;
  floor: bigint;
  bondable: boolean;
  openVotes: number;
  unbondsAt: bigint | null;
  rewards: bigint;
}): string {
  const owed = state.rewards > 0n ? ' There are rewards waiting; resolver_claim_rewards takes them in USDG.' : '';

  switch (state.standing) {
    case 'none':
      return (
        `This address is not on the roster. resolver_post_bond with ${bondView(state.floor).brsr} BRSR ` +
        'joins it. That BRSR is collateral at risk rather than a deposit: it pays no return, and a ' +
        'vote that goes silent or lands far from the room loses part of it.'
      );
    case 'unbonding':
      return (
        (state.openVotes > 0
          ? `${state.openVotes} vote${state.openVotes === 1 ? '' : 's'} still hold this bond, so it ` +
            'cannot leave until they settle. '
          : '') +
        (state.unbondsAt === null
          ? 'The cooldown is running.'
          : `The cooldown matures at ${instant(state.unbondsAt)}, after which resolver_complete_unbond ` +
            'returns the bond. resolver_cancel_unbond puts this resolver back on the roster instead.') +
        owed
      );
    case 'exited':
      return `This resolver has left the roster. resolver_post_bond puts it back on, history intact.${owed}`;
    default:
      return (
        (state.bondable
          ? `Bonded and able to vote, with ${bondView(state.bond).brsr} BRSR at risk against a floor of ` +
            `${bondView(state.floor).brsr}.`
          : `Bonded with ${bondView(state.bond).brsr} BRSR, which is under the ` +
            `${bondView(state.floor).brsr} floor this address has to clear, so its votes are refused ` +
            'until resolver_add_bond covers the difference.') + owed
      );
  }
}

function voteNote(
  phase: 'committing' | 'revealing',
  committed: boolean,
  revealed: boolean,
  commitEndsAt: bigint,
  revealEndsAt: bigint,
  settlement: string,
): string {
  if (revealed) return 'This resolver has published its score here. Nothing further to send.';

  if (committed) {
    return phase === 'committing'
      ? `Sealed. Reveal the same score and salt after ${instant(commitEndsAt)} and before ` +
          `${instant(revealEndsAt)}. A commitment left sealed past that is slashed as silence.`
      : `Reveal the same score and salt before ${instant(revealEndsAt)}. A commitment left sealed past ` +
          'that is slashed as silence.';
  }

  return phase === 'committing'
    ? `The settlement is ${settlement}. Seal a score with resolver_commit_score before ` +
        `${instant(commitEndsAt)}. Nothing is at stake until one is sealed.`
    : 'The commit window has shut and this resolver sealed no score, so it takes no part in this vote ' +
        'and nothing is at stake on it.';
}

/**
 * A commit that failed once the commitment had left this process.
 *
 * The relay submits before it answers, so a timeout, an error status or an unreadable answer all
 * leave a commitment that may be on chain, and so does a read-back that failed after a send that
 * worked. A refusal the server wrote keeps its code and gains the salt; anything else is library
 * text that never reaches the model, so it becomes a sentence of its own.
 */
function unconfirmedCommit(
  error: unknown,
  sealed: { readonly disputeId: bigint; readonly score: number; readonly salt: Hex },
): ToolError {
  const id = sealed.disputeId.toString();
  const keep =
    `The commitment may be on chain. If it is, only salt ${sealed.salt} with score ${sealed.score} ` +
    'reveals it, and a commitment left sealed is slashed as silence. Keep both, and read dispute ' +
    `${id} with resolver_list_disputes before committing again.`;
  const detail = { disputeId: id, score: sealed.score, salt: sealed.salt };

  if (error instanceof ToolError) {
    return new ToolError(error.code, `${error.message} ${keep}`, { ...error.detail, ...detail });
  }

  return new ToolError(
    'commit_unconfirmed',
    `Sealing score ${sealed.score} on dispute ${id} did not finish, and the outcome could not be read. ${keep}`,
    detail,
  );
}
