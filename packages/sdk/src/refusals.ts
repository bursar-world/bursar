/**
 * What the dispute layer and the provider registry say no for, in sentences.
 *
 * Both tables are keyed by the error names in the deployed ABI, so an error added to either
 * contract is a compile error here until someone writes its sentence. That guard is the whole
 * point: an unwritten entry reaches an agent as "the call reverted", which names no condition, no
 * owner and no next step, and an agent answering a six-hour reveal window cannot work with that.
 *
 * Each entry says three things. What the condition is. Whose it is, so the reader knows whether to
 * fix it, wait for it, or take it to someone else. And what to do now.
 */

import { ISSUER_REFUSAL, agentRegistryAbi, oracleRegistryAbi } from '@bursar/core';
import type { IssuerRefusal } from '@bursar/core';

/**
 * Who has to act. `caller` is the agent reading this; `governance` is the timelock; `deployment`
 * means two contracts were wired to disagree and no caller can fix it from here.
 */
export type RefusalOwner = 'caller' | 'counterparty' | 'governance' | 'token' | 'deployment' | 'clock';

export type Refusal = {
  /** The contract's own name for the condition, so a support conversation has one shared word. */
  readonly code: string;
  readonly owner: RefusalOwner;
  readonly message: string;
};

type Written = Omit<Refusal, 'code'>;

type OracleErrorName = Extract<(typeof oracleRegistryAbi)[number], { type: 'error' }>['name'];
type AgentErrorName = Extract<(typeof agentRegistryAbi)[number], { type: 'error' }>['name'];

const RESOLVER: Readonly<Record<OracleErrorName, Written>> = {
  AlreadyRegistered: {
    owner: 'caller',
    message:
      'This address is already bonded. Add to the bond with increaseBond instead; register is for ' +
      'coming back after an exit.',
  },
  NotRegistered: {
    owner: 'caller',
    message:
      'This address holds no bond, so it has no standing to vote or to leave. Post one with bond() ' +
      'first. A resolver that completed an unbonding is in the same position and registers again.',
  },
  NotActive: {
    owner: 'caller',
    message:
      'This resolver is unbonding, so it takes no new disputes. Cancel the unbonding to go back on ' +
      'the roster; the bond is untouched either way.',
  },
  RosterFull: {
    owner: 'clock',
    message:
      'Every seat on the roster is taken. It holds 64 resolvers so one finalisation stays inside a ' +
      'block, and every seated resolver may vote on every dispute. A seat frees when a resolver ' +
      'completes its exit or governance evicts one; register again then.',
  },
  BondTooSmall: {
    owner: 'caller',
    message:
      'The bond behind this vote is under the floor the staking pool holds for this address. A ' +
      'slash thins a bond and governance can raise the floor under one, and either benches a ' +
      'resolver until it tops back up. increaseBond is how it returns.',
  },
  BondNotAccepted: {
    owner: 'governance',
    message:
      'The staking pool will not take this bond. Compare what was offered against the floor it ' +
      'reports: short of the floor, add more; at or above it, governance has barred this address ' +
      'and no amount clears that.',
  },
  BondLocked: {
    owner: 'clock',
    message:
      'This bond is backing a vote that has not settled, so it cannot leave and governance cannot ' +
      'evict it. The cooldown alone does not release it. Finalize the disputes this resolver ' +
      'committed to, or wait for someone else to, and complete the unbonding after.',
  },
  StakingNotSet: {
    owner: 'deployment',
    message:
      'This dispute layer has no staking pool wired to it, so there is no bond floor and nobody can ' +
      'bond. The deployer closes that pairing once. Report the registry address to the operator.',
  },
  StakingAssetMismatch: {
    owner: 'deployment',
    message:
      'The staking pool and this registry disagree about which token is which: bonds are posted in ' +
      'one asset and resolver rewards are paid in another, and the two halves were wired to the ' +
      'same one. Nothing was bonded. Report the registry address to the operator.',
  },
  UnbondAlreadyRequested: {
    owner: 'caller',
    message: 'This resolver is already unbonding. Complete it once it matures, or cancel it.',
  },
  UnbondNotRequested: {
    owner: 'caller',
    message: 'Nothing is unbonding here. Ask for the exit with requestUnbond, then wait out the cooldown.',
  },
  UnbondNotMatured: {
    owner: 'clock',
    message:
      'The cooldown has not run out. It is set to outlast the longest dispute a live vote could ' +
      'still be slashed over, so it cannot be shortened. Read the resolver record for the maturity.',
  },
  DisputeNotFound: {
    owner: 'caller',
    message:
      'No dispute carries this id. Dispute ids are issued by this registry when the escrow opens ' +
      'one, and they are not settlement ids. List the open disputes to find it.',
  },
  DisputeAlreadyOpen: {
    owner: 'caller',
    message: 'This settlement already has a dispute open against it. One lock, one dispute.',
  },
  BadStatus: {
    owner: 'caller',
    message:
      'The dispute is past the phase this call belongs to. A finalized or failed dispute takes no ' +
      'further votes and needs no further closing. Read it before acting on it.',
  },
  NoCommitment: {
    owner: 'caller',
    message:
      'There is nothing to reveal: this resolver did not commit to this dispute, or the commitment ' +
      'sent was empty. A score can only be revealed against a commitment made in the commit window.',
  },
  AlreadyCommitted: {
    owner: 'caller',
    message:
      'This resolver has already committed to this dispute. A commitment cannot be replaced, so the ' +
      'score and salt from that commitment are the only pair that will reveal.',
  },
  AlreadyRevealed: {
    owner: 'caller',
    message: 'This resolver has already revealed here. The score on record stands.',
  },
  BadReveal: {
    owner: 'caller',
    message:
      'The score and salt do not hash to the commitment on record. The commitment covers the dispute ' +
      'id, this resolver address, the score and the salt, so any one of them being different reads ' +
      'the same way. Reveal with the exact pair the commitment was made from. Nothing else opens it, ' +
      'and a commitment left unrevealed when the window closes is slashed.',
  },
  BadScore: {
    owner: 'caller',
    message: 'A score is 0 to 100, where 0 is nothing delivered and 100 is delivered as agreed.',
  },
  CommitWindowOpen: {
    owner: 'clock',
    message:
      'The commit window is still open, so no score can be revealed and no dispute closed. Reveals ' +
      'begin the moment it shuts; the dispute record carries the time.',
  },
  CommitWindowClosed: {
    owner: 'clock',
    message:
      'The commit window has shut, so this dispute takes no further commitments. Resolvers who ' +
      'committed reveal now. Nothing is lost by missing it: only a commitment left unrevealed costs a bond.',
  },
  RevealWindowOpen: {
    owner: 'clock',
    message:
      'The reveal window is still open and not every commitment has been revealed, so the vote is ' +
      'not finished. Close it when the window shuts, or as soon as the last resolver reveals.',
  },
  RevealWindowClosed: {
    owner: 'clock',
    message:
      'The reveal window has shut, so this score can no longer be published. The commitment counts ' +
      'as silence and is slashed when the dispute closes. Nothing recovers it.',
  },
  QuorumNotMet: {
    owner: 'caller',
    message:
      'Too few resolvers revealed for this vote to be a result. Close it with failDispute instead, ' +
      'which puts the payment back on hold with a new deadline and returns the bond to whoever ' +
      'contested it.',
  },
  QuorumSuspect: {
    owner: 'caller',
    message:
      'Most of the revealed scores sit outside the deviation band, so the vote has no centre to rule ' +
      'from. Finalizing it fails the dispute and refunds the payer in full, with no resolver fee. ' +
      'Nobody is slashed for disagreeing, because nothing here can tell which side was honest.',
  },
  NothingToClaim: {
    owner: 'caller',
    message:
      'There is nothing here to pay out. A share of the resolver fee lands only on the resolvers ' +
      'who revealed inside the deviation band of a dispute that produced a result, and a sweep ' +
      'finds nothing when the registry holds no more than the rewards it owes.',
  },
  NotEscrow: {
    owner: 'caller',
    message:
      'Only the escrow this registry rules for can open a dispute or post a resolver fee. A payer ' +
      'contests through the escrow, which calls in here.',
  },
  PartyCannotVote: {
    owner: 'caller',
    message:
      'This address is the payer, the payee, or the principal the paying account named when the ' +
      'dispute opened, so it cannot vote on it. Another bonded resolver has to rule.',
  },
  EnforcedPause: {
    owner: 'governance',
    message:
      'The dispute registry is paused, so no dispute opens and no vote is taken until governance ' +
      'lifts it. Bonds and open disputes are held as they were.',
  },
  ExpectedPause: {
    owner: 'governance',
    message: 'The dispute registry is not paused, so there is nothing to lift.',
  },
  NotAdmin: {
    owner: 'governance',
    message:
      'This is a governance call. The registry is administered by the timelock, and a change goes ' +
      'through a proposal with a delay on it.',
  },
  NotPendingAdmin: {
    owner: 'governance',
    message: 'Only the address the current admin named can accept the role.',
  },
  NotDeployer: {
    owner: 'deployment',
    message:
      'Only the address that deployed this registry can close its pairings to the escrow and the ' +
      'staking pool, and each closes once.',
  },
  AlreadySet: {
    owner: 'deployment',
    message:
      'This pairing is already closed and cannot be re-pointed. Moving it would change the currency ' +
      'of bonds already posted, or the escrow whose locks this registry rules on.',
  },
  BadConfig: {
    owner: 'governance',
    message:
      'The proposed voting parameters are not usable together: each window has to be at least ten ' +
      'minutes, quorum has to be at least one and fit inside the 64-seat roster, maxVoters has to ' +
      'seat the whole roster, the slash has to be more than nothing, and the cooldown has to outlast ' +
      'a whole vote. The parameters in force are unchanged.',
  },
  ZeroAmount: {
    owner: 'caller',
    message:
      'A bond of zero is not a bond. Name the BRSR this resolver is putting at risk, in the token’s ' +
      'own eighteen decimals.',
  },
  ZeroAddress: {
    owner: 'caller',
    message: 'This call was given the zero address where the registry needs a real one.',
  },

  // Inherited from the libraries the registry is built on. They carry no BURSAR condition and an
  // agent still has to be told what happened and who owns it.
  SafeERC20FailedOperation: {
    owner: 'token',
    message:
      'The token refused the transfer this call needed, so nothing moved. A bond that is not ' +
      'approved to the registry, a balance short of what was offered, and a token paused for ' +
      'everyone all come back this way. Check the allowance and the balance first; if both cover it, ' +
      'the refusal is the token issuer’s and no retry clears it.',
  },
  SafeCastOverflowedUintDowncast: {
    owner: 'caller',
    message:
      'The amount is larger than the field the registry holds a bond in. Nothing was bonded. No bond ' +
      'the token can actually mint reaches this, so check the units: BRSR has eighteen decimals, not ' +
      'six.',
  },
  ReentrancyGuardReentrantCall: {
    owner: 'counterparty',
    message:
      'Something called back into the registry while one of its own calls was still running, and it ' +
      'refuses that. Nothing settled. The contract that called in owns this: report it with the ' +
      'transaction.',
  },
};

const PROVIDER: Readonly<Record<AgentErrorName, Written>> = {
  AlreadyRegistered: {
    owner: 'caller',
    message:
      'This address is already in the registry. Add collateral with addStake, and use reactivate to ' +
      'come back from a deactivation. Registration happens once.',
  },
  NotRegistered: {
    owner: 'caller',
    message:
      'This address is not in the registry, so a mandate cannot name it and the escrow will not take ' +
      'a lock for it. Register with a stake at or above the floor first.',
  },
  NotActive: {
    owner: 'caller',
    message: 'This provider is already deactivated, so it is not reading as available to principals.',
  },
  AlreadyActive: {
    owner: 'caller',
    message: 'This provider is already active and reading as available to principals.',
  },
  InsufficientStake: {
    owner: 'caller',
    message:
      'The stake left behind would be under the registry floor. An active provider has to stay at or ' +
      'above it, so a withdrawal that would cross it is refused. Deactivate first to withdraw the ' +
      'whole stake, or take out less.',
  },
  InvalidName: {
    owner: 'caller',
    message:
      'A provider name is 3 to 32 characters of letters, digits and underscore. Anything else is ' +
      'refused rather than rendered, because a handle carrying invisible characters can be read as ' +
      'another provider’s.',
  },
  WithdrawalPending: {
    owner: 'caller',
    message:
      'A withdrawal is already waiting on this address, and there is one at a time. Execute it once ' +
      'it matures, or cancel it and ask for a different amount.',
  },
  WithdrawalNotRequested: {
    owner: 'caller',
    message:
      'Nothing is waiting to be withdrawn here. Ask for the amount with requestWithdrawal, wait out ' +
      'the delay, then execute it.',
  },
  WithdrawalNotMatured: {
    owner: 'clock',
    message:
      'The withdrawal delay has not run out. Collateral stays slashable across it, which is what ' +
      'stops a stake leaving between a bad job and the ruling on it. Read the maturity off the ' +
      'provider record.',
  },
  IsBlacklisted: {
    owner: 'governance',
    message:
      'This address is barred from the registry. It cannot register, add collateral or reactivate ' +
      'while the bar stands, and only the registry’s admin lifts it.',
  },
  NotBlacklisted: {
    owner: 'governance',
    message: 'This address is not barred, so there is no bar to clear.',
  },
  RootNotSet: {
    owner: 'governance',
    message:
      'The registry holds no blacklist root, so membership of it cannot be proved. Nothing was ' +
      'flagged.',
  },
  BadProof: {
    owner: 'caller',
    message:
      'The proof does not verify against the blacklist root the registry holds. Nothing was flagged.',
  },
  NotAuthorized: {
    owner: 'governance',
    message:
      'This is an admin call on the registry. A provider manages its own stake and its own ' +
      'availability, and everything else goes through governance.',
  },
  BadConfig: {
    owner: 'governance',
    message:
      'The proposed registry setting is out of range: the stake floor has to be more than nothing, ' +
      'and a single ruling cannot be allowed to take more than half a stake. The settings in force ' +
      'are unchanged.',
  },
  EnforcedPause: {
    owner: 'governance',
    message:
      'The registry is paused, so nothing new is admitted: no registration, no added collateral, no ' +
      'reactivation. A withdrawal that has already matured is unaffected, because that collateral is ' +
      'the provider’s own.',
  },
  ExpectedPause: {
    owner: 'governance',
    message: 'The registry is not paused, so there is nothing to lift.',
  },
  TransferMismatch: {
    owner: 'token',
    message:
      'The settlement asset moved a different amount than the registry asked it to, so the whole ' +
      'call was undone and nothing was staked. A stake has to be worth exactly what the ledger says ' +
      'it is. This comes from the token: report it to the operator.',
  },
  ZeroAmount: {
    owner: 'caller',
    message:
      'Name the amount. Stakes are in USDG at six decimals, so 5.00 USDG is 5000000, not 5.',
  },
  ZeroAddress: {
    owner: 'caller',
    message: 'This call was given the zero address where the registry needs a real one.',
  },

  // Inherited from the libraries the registry is built on.
  SafeERC20FailedOperation: {
    owner: 'token',
    message:
      'The settlement asset refused the transfer this call needed, so nothing was staked or ' +
      'withdrawn. A stake that is not approved to the registry, a balance short of it, an address ' +
      'USDG has frozen, and USDG paused for everyone all come back this way. Check the allowance and ' +
      'the balance first; if both cover it, the refusal is the token issuer’s.',
  },
  ReentrancyGuardReentrantCall: {
    owner: 'counterparty',
    message:
      'Something called back into the registry while one of its own calls was still running, and it ' +
      'refuses that. Nothing settled. The contract that called in owns this: report it with the ' +
      'transaction.',
  },
};

/**
 * The settlement asset's own controls, which no caller here can clear.
 *
 * These five do not come from a revert. The underwriter and the x402 facilitator read USDG's
 * `paused()` and `isFrozen(address)` before anything is signed and refuse with the code, so an
 * agent learns the token is shut without paying a fee to find out. Keyed by the codes themselves,
 * so a sixth control added to `@bursar/core` is a compile error here until somebody writes its
 * sentence: unwritten, it would reach an agent as an underscored word and no next step.
 *
 * Every one is owned by `token`. Retrying `asset_control_unreadable` is worth a try because the
 * read failed rather than the control; the other four are the issuer's answer.
 */
const ISSUER: Readonly<Record<IssuerRefusal, Written>> = {
  [ISSUER_REFUSAL.assetPaused]: {
    owner: 'token',
    message:
      'USDG is paused, so no transfer settles until the issuer lifts it. Nothing was signed and ' +
      'nothing was spent. Fees are paid in ETH, so mandate calls that move no money still work.',
  },
  [ISSUER_REFUSAL.payerFrozen]: {
    owner: 'token',
    message:
      'The token issuer has frozen the paying address, so USDG will not leave it whatever the ' +
      'balance shows and whatever the mandate allows. Pay from an address that is not frozen, or ' +
      'take it to the issuer. No limit on this mandate is in the way.',
  },
  [ISSUER_REFUSAL.payeeFrozen]: {
    owner: 'token',
    message:
      'The token issuer has frozen the receiving address, so USDG will not reach it. The payer is ' +
      'fine. Settle with the payee on another address, or take it to the issuer.',
  },
  [ISSUER_REFUSAL.assetControlAbsent]: {
    owner: 'deployment',
    message:
      'The settlement asset routed no code for one of its own compliance calls, so whether it ' +
      'would have settled cannot be established. An unread control is never a clear one, so this ' +
      'refuses. Retrying will not change it: the token has a shape somebody has to look at.',
  },
  [ISSUER_REFUSAL.assetControlUnreadable]: {
    owner: 'token',
    message:
      'The settlement asset did not answer whether it would allow this transfer, and an unread ' +
      'control is never a clear one. Nothing was signed. This one is worth retrying: the read ' +
      'failed, not the control.',
  },
};

function lookup(table: Readonly<Record<string, Written>>, errorName: string): Refusal | null {
  const written = table[errorName];

  return written === undefined ? null : { code: errorName, ...written };
}

/** The sentence for an `OracleRegistry` revert, or null when the name is not one of its own. */
export function resolverRefusal(errorName: string): Refusal | null {
  return lookup(RESOLVER, errorName);
}

/** The sentence for an `AgentRegistry` revert, or null when the name is not one of its own. */
export function providerRefusal(errorName: string): Refusal | null {
  return lookup(PROVIDER, errorName);
}

/**
 * The sentence for a refusal that belongs to the token issuer, or null for anything else.
 *
 * Anything else means the refusal is somebody's to fix from here, so a caller branching on null
 * is asking the right question: is this mine, or is it the issuer's?
 */
export function issuerRefusal(code: string): Refusal | null {
  return lookup(ISSUER, code);
}
