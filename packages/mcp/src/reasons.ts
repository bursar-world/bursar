import {
  agentRegistryAbi,
  assetRegistryAbi,
  collateralVaultAbi,
  creditPoolAbi,
  escrowAbi,
  mandateAccountAbi,
  oracleRegistryAbi,
  priceGuardAbi,
  stockSpendRouterAbi,
} from '@bursar/core';
import { toFunctionSelector } from 'viem';
import type { Hex } from 'viem';

/** Which part of the system produced a refusal. It is the first thing anyone asks. */
export type RefusalSubject =
  | 'amount'
  | 'approval'
  | 'asset'
  | 'bond'
  | 'capability'
  | 'daily'
  | 'dispute'
  | 'escrow'
  | 'governance'
  | 'limits'
  | 'listing'
  | 'mandate'
  | 'monthly'
  | 'per_call'
  | 'price'
  | 'provider'
  | 'registry'
  | 'reward'
  | 'stake'
  | 'total_budget'
  | 'validity'
  | 'vote'
  | 'window'
  | 'withdrawal';

export type Refusal = {
  /** The contract error, carried verbatim so a support conversation has one shared word for it. */
  readonly code: string;
  readonly subject: RefusalSubject;
  readonly message: string;
};

/**
 * Which contract a revert came from.
 *
 * Three contracts declare `ZeroAmount`, two declare `NotRegistered`, and the sentence for each is
 * different. A relay knows which call it made, so the lookup is scoped by that rather than
 * guessing from a name that belongs to several.
 */
export type RefusalScope = 'mandate' | 'resolver' | 'provider';

/**
 * Every error `MandateAccount` declares, keyed by the name the contract gives it.
 *
 * The key type comes from the deployed ABI, so an error added to the contract is a compile error
 * here until someone writes the sentence for it. That is the guard: ten unwritten entries once
 * reached agents as "The mandate refused this spend", which names no condition and no next step.
 */
type MandateErrorName = Extract<(typeof mandateAccountAbi)[number], { type: 'error' }>['name'];

const REFUSALS: Readonly<Record<MandateErrorName, Omit<Refusal, 'code'>>> = {
  IsPaused: {
    subject: 'mandate',
    message: 'The principal has paused this mandate. Nothing settles until the principal lifts the pause.',
  },
  IsRevoked: {
    subject: 'mandate',
    message:
      'The principal revoked the agent on this mandate, so nothing settles against it. Seating an agent ' +
      'again is what puts it back to work, and only the principal can do that.',
  },
  ZeroAmount: {
    subject: 'amount',
    message: 'A spend has to be greater than zero.',
  },
  ZeroAddress: {
    subject: 'provider',
    message: 'Name the provider you are paying. A zero address is not a payee.',
  },
  NotYetValid: {
    subject: 'validity',
    message: 'This mandate has not opened yet. Nothing settles before its start time.',
  },
  Expired: {
    subject: 'validity',
    message: 'This mandate has passed its end time. Nothing further settles against it.',
  },
  CapabilityNotAllowed: {
    subject: 'capability',
    message:
      'The mandate does not cover this capability. The principal has to add it before a spend on it can settle.',
  },
  PerCallCapExceeded: {
    subject: 'per_call',
    message:
      'This is above the per-call cap. Buy a smaller unit of work, or ask the principal to raise the cap.',
  },
  DailyCapExceeded: {
    subject: 'daily',
    message: 'The daily budget does not have room for this spend. It refills at the next daily reset.',
  },
  MonthlyCapExceeded: {
    subject: 'monthly',
    message: 'The monthly budget does not have room for this spend. It refills at the next monthly reset.',
  },
  MerchantNotAllowed: {
    subject: 'provider',
    message: 'This provider is not on the mandate. The principal has to add it before you can pay.',
  },
  MerkleGateActive: {
    subject: 'provider',
    message:
      'The mandate holds its provider roster off chain, so a quote cannot judge the provider. Every other ' +
      'check passed. Pass the provider proof when you pay.',
  },
  AllowlistGateActive: {
    subject: 'provider',
    message: 'This mandate lists providers by address, so pay without a provider proof.',
  },
  BadMerkleProof: {
    subject: 'provider',
    message: 'The provider proof does not match the roster this mandate enforces. Ask the principal for a current one.',
  },
  ApprovalRequired: {
    subject: 'approval',
    message:
      'This spend is at or above the approval threshold, so it needs the principal to sign for it. Ask the ' +
      'principal for an approval covering this provider, capability and amount, then pay with it.',
  },
  ApprovalMismatch: {
    subject: 'approval',
    message: 'The approval does not cover this spend. Provider, capability and amount all have to match what was signed.',
  },
  ApprovalExpired: {
    subject: 'approval',
    message: 'The approval has expired. Ask the principal for a fresh one.',
  },
  ApprovalSpent: {
    subject: 'approval',
    message:
      'The approval has already been used or revoked. Each one pays for one spend, and its id stays ' +
      'spent for the life of the mandate, even across a change of principal. Ask the principal for a new one.',
  },
  BadSignature: {
    subject: 'approval',
    message: 'The approval signature is not the principal of this mandate.',
  },
  NotAgent: {
    subject: 'mandate',
    message: 'The relay is not the agent this mandate authorises. The principal sets the agent address.',
  },
  NotPrincipal: {
    subject: 'mandate',
    message: 'Only the principal can do this, and the signer this server reaches does not act for the principal.',
  },
  NotPendingPrincipal: {
    subject: 'mandate',
    message:
      'The current principal offered this mandate to a different address, and only that address can accept ' +
      'it. The principal decides who takes it over.',
  },
  AlreadyPrincipal: {
    subject: 'mandate',
    message:
      'The principal named itself as the next principal, which changes nothing. To withdraw an approval ' +
      'it signed, revoke that approval. Nothing was changed.',
  },
  BadWindow: {
    subject: 'limits',
    message:
      'A limit change set a spending window to zero seconds, and a budget needs a period to measure against. ' +
      'The daily and monthly windows in force are unchanged. The principal sets them.',
  },
  BadValidity: {
    subject: 'limits',
    message:
      'A limit change would have this mandate expire before it opens. Valid-until has to fall after ' +
      'valid-from, or be left unset for a mandate with no end date. The dates in force are unchanged.',
  },
  BadApprovalThreshold: {
    subject: 'limits',
    message:
      'A limit change left the approval threshold at zero, which would put every spend behind the ' +
      "principal's signature. The threshold in force is unchanged. To hold every spend for a signature " +
      'on purpose, the principal sets the threshold above the per-call cap.',
  },
  BadNonce: {
    subject: 'limits',
    message:
      'A signed limit change arrived out of order. Each one names the nonce it was signed against, and this ' +
      'mandate has moved past that number. The limits in force are unchanged. Ask the principal to sign the ' +
      'change again against the current nonce.',
  },
  AuthorizationExpired: {
    subject: 'limits',
    message:
      'A signed limit change reached this mandate after its deadline, so the limits in force are unchanged. ' +
      'Ask the principal for a fresh authorization.',
  },
  NotEscrow: {
    subject: 'escrow',
    message:
      'Only the escrow this mandate settles through can give a budget back what a spend took out of it, and ' +
      'this call came from another address. Nothing was credited. mandate_inspect names the escrow.',
  },
  UnknownSpend: {
    subject: 'escrow',
    message:
      'The credit named a settlement this mandate never paid for, so there is nothing to give back. The daily ' +
      'and monthly budgets are untouched. Check the id against mandate_list_settlements.',
  },
  CreditExceedsSpend: {
    subject: 'escrow',
    message:
      'The credit is larger than the spend it belongs to, and a budget only takes back what that spend took ' +
      'out of it. The budgets are untouched. Carry the settlement id to the principal; no change to a ' +
      'payment on your side reaches this.',
  },
  TransferMismatch: {
    subject: 'asset',
    message:
      'The settlement asset moved a different amount than it was told to, so the whole call was undone and ' +
      'nothing settled. Every lock pays out at its face amount, so an asset that delivers something else ' +
      'cannot back one. This comes from the token: report it to the principal.',
  },

  // Inherited from the libraries the account is built on. They carry no BURSAR condition, and an
  // agent still has to be told what happened and who owns it.
  SafeERC20FailedOperation: {
    subject: 'asset',
    message:
      'The settlement asset refused the transfer this call needed, so nothing settled. Three conditions ' +
      'come back this way: a short balance, an address USDG has frozen, and USDG paused for everyone. ' +
      'Read the balance with mandate_inspect. If it covers the payment then the refusal is the token ' +
      "issuer's and no retry clears it, so take it to the principal.",
  },
  ReentrancyGuardReentrantCall: {
    subject: 'mandate',
    message:
      'Something called back into this mandate while one of its own calls was still running, and the account ' +
      'refuses that. Nothing settled. The contract that called in owns this: report it to the principal with ' +
      'the transaction.',
  },
  InvalidShortString: {
    subject: 'mandate',
    message:
      'This mandate cannot read back a name it was deployed with, which is what its signatures are checked ' +
      'against. Nothing settled, and nothing an agent sends changes it. Report the account address to the ' +
      'principal.',
  },
  ClassNotAllowed: {
    subject: 'capability',
    message:
      'The principal has not allowed this class of spend on this mandate. Services, agent hires and stock ' +
      'purchases are separate classes, and only the principal can change which ones the mandate allows.',
  },
  TotalCapExceeded: {
    subject: 'total_budget',
    message:
      'This spend would take the mandate past its lifetime total. The total does not refill; only the ' +
      'principal can raise it.',
  },
  BadClassMask: {
    subject: 'limits',
    message:
      'The limits allow no spend class, or name one the mandate does not know. A mandate has to allow ' +
      'at least one of services, agent hires and eligible stocks. The limits in force are unchanged.',
  },
  BadLane: {
    subject: 'limits',
    message:
      'The limits set a lane above 2, and the mandate accepts only 0, 1 and 2. The limits in force are ' +
      'unchanged.',
  },
  RouterNotSet: {
    subject: 'mandate',
    message: 'This mandate has no purchase router set, so it cannot buy. Only the principal can set one.',
  },
  InsufficientOutput: {
    subject: 'amount',
    message:
      'The purchase would return less than the minimum it was sent with, so nothing was bought and nothing moved.',
  },
  StringTooLong: {
    subject: 'mandate',
    message:
      'This mandate was deployed with a name longer than the signing domain holds, so signatures against it ' +
      'cannot be checked. Nothing settled. Report the account address to the principal.',
  },
};

type OracleErrorName = Extract<(typeof oracleRegistryAbi)[number], { type: 'error' }>['name'];

/**
 * Every error `OracleRegistry` declares, in the vocabulary a resolver runs in.
 *
 * The stakes here are higher than on a spend. A resolver that misreads a window loses part of a
 * bond, and no retry, top-up or support conversation gets it back, so each sentence says what the
 * condition is, whether it costs anything, and what to do now.
 */
const RESOLVER_REFUSALS: Readonly<Record<OracleErrorName, Omit<Refusal, 'code'>>> = {
  AlreadyRegistered: {
    subject: 'bond',
    message:
      'This resolver is already bonded. Add to the bond with resolver_add_bond; posting one is for ' +
      'coming back after an exit.',
  },
  NotRegistered: {
    subject: 'bond',
    message:
      'This address holds no bond, so it cannot vote and has nothing to withdraw. resolver_post_bond ' +
      'puts BRSR up and joins the roster. A resolver that completed an unbonding is in the same ' +
      'position and posts a bond again.',
  },
  NotActive: {
    subject: 'bond',
    message:
      'This resolver is unbonding, so it takes no new disputes. resolver_cancel_unbond puts it back ' +
      'on the roster and leaves the bond where it is.',
  },
  PartyCannotVote: {
    subject: 'dispute',
    message:
      'This resolver is the payer, the payee, or the principal the paying account named when the dispute ' +
      'opened, so it cannot vote on it. Nothing was committed and nothing is at stake.',
  },
  EnforcedPause: {
    subject: 'registry',
    message:
      'The dispute registry is paused, so no dispute opens and no vote is taken until governance lifts ' +
      'it. Bonds and open disputes are held as they were.',
  },
  ExpectedPause: {
    subject: 'registry',
    message: 'The dispute registry is not paused, so there is nothing to lift.',
  },
  RosterFull: {
    subject: 'registry',
    message:
      'Every seat on the roster is taken. It holds 64 resolvers so that closing a vote fits in a block, ' +
      'and every seated resolver may vote on every dispute. A seat frees when a resolver completes its ' +
      'exit or governance evicts one; post the bond again then.',
  },
  BondTooSmall: {
    subject: 'bond',
    message:
      'The bond behind this vote is under the floor this address has to clear, so the vote was ' +
      'refused. A slash thins a bond and governance can raise the floor under one. resolver_status ' +
      'reports both figures and resolver_add_bond covers the difference.',
  },
  BondNotAccepted: {
    subject: 'bond',
    message:
      'The staking pool will not take this bond. resolver_status reports what was offered against the ' +
      'floor: short of it, add more; at or above it, governance has barred this address and no amount ' +
      'clears that.',
  },
  BondLocked: {
    subject: 'bond',
    message:
      'This bond is backing a vote that has not settled, so it cannot leave yet and governance cannot ' +
      'evict it. The cooldown alone does not release it. Close those disputes, or wait for someone ' +
      'else to, and complete the unbonding after.',
  },
  StakingNotSet: {
    subject: 'registry',
    message:
      'This dispute layer has no staking pool wired to it, so it holds no bond floor and nobody can ' +
      'bond. Nothing an agent sends changes that. Report it to the operator.',
  },
  StakingAssetMismatch: {
    subject: 'registry',
    message:
      'The staking pool and the dispute registry were wired to the same token, and bonds and rewards ' +
      'are meant to be two different ones. Nothing was bonded. Report it to the operator.',
  },
  UnbondAlreadyRequested: {
    subject: 'bond',
    message:
      'This resolver is already unbonding. resolver_complete_unbond takes the bond once the cooldown ' +
      'matures, and resolver_cancel_unbond calls the exit off.',
  },
  UnbondNotRequested: {
    subject: 'bond',
    message:
      'Nothing is unbonding here. resolver_request_unbond starts the cooldown, and the bond comes back ' +
      'after it matures.',
  },
  UnbondNotMatured: {
    subject: 'bond',
    message:
      'The cooldown has not run out. It is set to outlast the longest dispute a live vote could still ' +
      'be slashed over, so nothing shortens it. resolver_status reports the maturity.',
  },
  DisputeNotFound: {
    subject: 'dispute',
    message:
      'No dispute carries this id. A dispute id is issued by the registry and is not a settlement id. ' +
      'resolver_list_disputes reports both for every open vote.',
  },
  DisputeAlreadyOpen: {
    subject: 'dispute',
    message: 'This settlement already has a dispute open against it. One settlement, one dispute.',
  },
  BadStatus: {
    subject: 'dispute',
    message:
      'This dispute is past the phase this call belongs to. A closed vote takes no more scores and ' +
      'needs no more closing. resolver_list_disputes shows the ones still open.',
  },
  NoCommitment: {
    subject: 'vote',
    message:
      'There is nothing to reveal here: this resolver did not seal a score on this dispute during the ' +
      'commit window. Nothing is at stake on a dispute it never committed to.',
  },
  AlreadyCommitted: {
    subject: 'vote',
    message:
      'This resolver has already sealed a score on this dispute, and a commitment cannot be replaced. ' +
      'The score and salt from that commitment are the only pair that will reveal it.',
  },
  AlreadyRevealed: {
    subject: 'vote',
    message: 'This resolver has already published its score here. The score on record stands.',
  },
  BadReveal: {
    subject: 'vote',
    message:
      'The score and salt do not open the commitment on record. The commitment covers the dispute id, ' +
      'this resolver address, the score and the salt, so any one of them differing reads the same way. ' +
      'Only the exact pair that sealed it will reveal it, and nothing recomputes a salt that was lost. ' +
      'A commitment still sealed when the reveal window shuts is slashed as silence.',
  },
  BadScore: {
    subject: 'vote',
    message:
      'A score is a whole number from 0 to 100, where 0 is nothing delivered and 100 is delivered as ' +
      'agreed.',
  },
  CommitWindowOpen: {
    subject: 'window',
    message:
      'The commit window is still open, so no score can be published and no vote closed yet. Reveals ' +
      'begin the moment it shuts; resolver_list_disputes reports the time.',
  },
  CommitWindowClosed: {
    subject: 'window',
    message:
      'The commit window has shut, so this dispute takes no more sealed scores. Nothing is lost by ' +
      'missing it: only a commitment left unrevealed costs a bond.',
  },
  RevealWindowOpen: {
    subject: 'window',
    message:
      'The reveal window is still open and not every sealed score has been published, so the vote is ' +
      'not finished. Close it when the window shuts, or as soon as the last resolver reveals.',
  },
  RevealWindowClosed: {
    subject: 'window',
    message:
      'The reveal window has shut, so this score can no longer be published. The commitment counts as ' +
      'silence and part of the bond is taken when the dispute closes. Nothing recovers it.',
  },
  QuorumNotMet: {
    subject: 'dispute',
    message:
      'Too few resolvers published a score for this vote to be a result. resolver_fail_dispute is the ' +
      'exit: it puts the payment back on hold with a new deadline for the provider and returns the bond ' +
      'to whoever contested it.',
  },
  QuorumSuspect: {
    subject: 'dispute',
    message:
      'Most of the published scores sit outside the deviation band, so the vote has no centre to rule ' +
      'from. resolver_finalize_dispute closes it as failed and refunds the payer in full, with no ' +
      'resolver fee; the first contract set keeps the resolver fee back. Nobody is slashed for disagreeing, ' +
      'because nothing here can tell which side was honest.',
  },
  NothingToClaim: {
    subject: 'reward',
    message:
      'There is nothing here to pay out. A share of the resolver fee lands only on the resolvers that ' +
      'published a score inside the deviation band of a dispute that produced a result.',
  },
  NotEscrow: {
    subject: 'registry',
    message:
      'Only the escrow this registry rules for can open a dispute or post a resolver fee. A payer ' +
      'contests through the escrow with mandate_open_dispute, which calls in here.',
  },
  NotAdmin: {
    subject: 'governance',
    message:
      'This is a governance call on the dispute registry, and a resolver does not make it. Voting ' +
      'parameters move through a proposal with a delay on it.',
  },
  NotPendingAdmin: {
    subject: 'governance',
    message: 'Only the address the current admin named can accept the role.',
  },
  NotDeployer: {
    subject: 'registry',
    message:
      'Only the address that deployed the registry can close its pairings to the escrow and the ' +
      'staking pool, and each closes once.',
  },
  AlreadySet: {
    subject: 'registry',
    message:
      'That pairing is already closed and cannot be re-pointed. Moving it would change the currency of ' +
      'bonds already posted, or the escrow whose settlements this registry rules on.',
  },
  BadConfig: {
    subject: 'governance',
    message:
      'The proposed voting parameters are not usable together, so the ones in force are unchanged. Each ' +
      'window has to be at least ten minutes and every seated resolver has to be able to vote. This is ' +
      'a governance call and a resolver does not make it.',
  },
  ZeroAmount: {
    subject: 'bond',
    message:
      'A bond of zero is not a bond. Name the BRSR this resolver is putting at risk, in the token’s ' +
      'own eighteen decimals: one whole token is "1000000000000000000".',
  },
  ZeroAddress: {
    subject: 'registry',
    message: 'This call reached the registry with the zero address where it needs a real one.',
  },

  // Inherited from the libraries the registry is built on. They carry no BURSAR condition, and a
  // resolver still has to be told what happened and who owns it.
  SafeERC20FailedOperation: {
    subject: 'asset',
    message:
      'The token refused the transfer this call needed, so nothing moved. A bond that is not approved ' +
      'to the registry, a balance short of what was offered, and a token paused for everyone all come ' +
      'back this way. Check the allowance and the balance first; if both cover it, the refusal is the ' +
      'token issuer’s and no retry clears it.',
  },
  SafeCastOverflowedUintDowncast: {
    subject: 'bond',
    message:
      'The amount is larger than the field a bond is held in, so nothing was bonded. No bond the token ' +
      'could mint reaches this, so check the units: BRSR has eighteen decimals, not six.',
  },
  ReentrancyGuardReentrantCall: {
    subject: 'registry',
    message:
      'Something called back into the registry while one of its own calls was still running, and it ' +
      'refuses that. Nothing settled. The contract that called in owns this: report it with the ' +
      'transaction.',
  },
};

type AgentErrorName = Extract<(typeof agentRegistryAbi)[number], { type: 'error' }>['name'];

/** Every error `AgentRegistry` declares, in the vocabulary a provider runs in. */
const PROVIDER_REFUSALS: Readonly<Record<AgentErrorName, Omit<Refusal, 'code'>>> = {
  AlreadyRegistered: {
    subject: 'listing',
    message:
      'This address is already listed. provider_add_stake puts up more collateral and ' +
      'provider_reactivate comes back from a deactivation. Registering happens once.',
  },
  NotRegistered: {
    subject: 'listing',
    message:
      'This address is not listed, so no mandate can name it and the escrow will not hold a payment ' +
      'for it. provider_register lists it with a name and collateral.',
  },
  NotActive: {
    subject: 'listing',
    message: 'This provider is already deactivated, so it is not reading as available to principals.',
  },
  AlreadyActive: {
    subject: 'listing',
    message: 'This provider is already active and reading as available to principals.',
  },
  InsufficientStake: {
    subject: 'stake',
    message:
      'The collateral left behind would be under the floor an active provider has to keep. Take out ' +
      'less, or deactivate first and then withdraw the lot. provider_status reports both figures.',
  },
  InvalidName: {
    subject: 'listing',
    message:
      'A provider name is 3 to 32 characters of letters, digits and underscore. Anything else is ' +
      'refused rather than rendered, because a handle carrying invisible characters can be read as ' +
      'another provider’s.',
  },
  WithdrawalPending: {
    subject: 'withdrawal',
    message:
      'A withdrawal is already waiting on this address, and there is one at a time. Take it once it ' +
      'matures, or cancel it and ask for a different amount.',
  },
  WithdrawalNotRequested: {
    subject: 'withdrawal',
    message:
      'Nothing is waiting to be withdrawn here. provider_request_withdrawal starts the delay, and the ' +
      'collateral can be taken once it matures.',
  },
  WithdrawalNotMatured: {
    subject: 'withdrawal',
    message:
      'The withdrawal delay has not run out. Collateral stays slashable across it, which is what stops ' +
      'a stake leaving between a bad job and the governance proposal that answers it. provider_status ' +
      'reports the maturity.',
  },
  IsBlacklisted: {
    subject: 'listing',
    message:
      'This address is barred from the registry. It cannot list, add collateral or reactivate while ' +
      'the bar stands, and only the registry’s admin lifts one.',
  },
  NotBlacklisted: {
    subject: 'listing',
    message: 'This address is not barred, so there is no bar to clear.',
  },
  RootNotSet: {
    subject: 'governance',
    message: 'The registry holds no blacklist root, so membership of it cannot be proved.',
  },
  BadProof: {
    subject: 'governance',
    message: 'The proof does not verify against the blacklist root the registry holds. Nothing was flagged.',
  },
  NotAuthorized: {
    subject: 'governance',
    message:
      'This is an admin call on the registry. A provider manages its own collateral and its own ' +
      'availability, and everything else goes through governance.',
  },
  BadConfig: {
    subject: 'governance',
    message:
      'The proposed registry setting is out of range, so the settings in force are unchanged. This is ' +
      'a governance call and a provider does not make it.',
  },
  EnforcedPause: {
    subject: 'registry',
    message:
      'The registry is paused, so it admits nothing new: no listing, no added collateral, no ' +
      'reactivation. A withdrawal that has already matured is unaffected, because that collateral is ' +
      'the provider’s own.',
  },
  ExpectedPause: {
    subject: 'registry',
    message: 'The registry is not paused, so there is nothing to lift.',
  },
  TransferMismatch: {
    subject: 'asset',
    message:
      'The settlement asset moved a different amount than the registry asked it to, so the whole call ' +
      'was undone and nothing was staked. Collateral has to be worth exactly what the ledger says it ' +
      'is. This comes from the token: report it to the operator.',
  },
  ZeroAmount: {
    subject: 'stake',
    message:
      'Name the amount. Collateral is USDG in six-decimal atomic units, so 5.00 USDG is "5000000".',
  },
  ZeroAddress: {
    subject: 'registry',
    message: 'This call reached the registry with the zero address where it needs a real one.',
  },

  // Inherited from the libraries the registry is built on.
  SafeERC20FailedOperation: {
    subject: 'asset',
    message:
      'The settlement asset refused the transfer this call needed, so nothing was staked or withdrawn. ' +
      'Collateral that is not approved to the registry, a balance short of it, an address USDG has ' +
      'frozen, and USDG paused for everyone all come back this way. Check the allowance and the ' +
      'balance first; if both cover it, the refusal is the token issuer’s.',
  },
  ReentrancyGuardReentrantCall: {
    subject: 'registry',
    message:
      'Something called back into the registry while one of its own calls was still running, and it ' +
      'refuses that. Nothing settled. The contract that called in owns this: report it with the ' +
      'transaction.',
  },
};

/** What the asset registry, the price guard and the stock router refuse a purchase for. */
const RWA_REFUSALS: Readonly<Record<string, Omit<Refusal, 'code'>>> = {
  NotRegistered: {
    subject: 'asset',
    message: 'This token is not in the asset registry, so no mandate can buy or park it. Assets are matched by address.',
  },
  NotEligible: {
    subject: 'asset',
    message: 'The registry has this asset marked as not eligible right now. Nothing can be bought in it.',
  },
  StalePrice: {
    subject: 'price',
    message:
      'The reference price for this asset is older than its limit (26 hours for trades), which happens over ' +
      'weekends and market holidays. Try again after the next price update.',
  },
  BadPrice: { subject: 'price', message: 'The reference price feed returned no usable price. Nothing was bought.' },
  OraclePaused: {
    subject: 'price',
    message: 'The token issuer has paused its price reference, so the asset cannot be bought or valued.',
  },
  TokenPaused: { subject: 'asset', message: 'The token issuer has paused transfers of this asset.' },
  AccessPaused: { subject: 'asset', message: "Robinhood's access registry is paused, so no stock token can move." },
  Blocked: {
    subject: 'mandate',
    message: "Robinhood's access registry blocks this account from holding the asset. Nothing was bought.",
  },
  PoolPriceDeviation: {
    subject: 'price',
    message:
      'The trading pool and the reference price disagree by more than the asset allows, or this purchase ' +
      'would push the pool that far. Nothing was bought. Try a smaller amount, or wait until the two agree again.',
  },
  PriceOutsideBand: {
    subject: 'price',
    message: 'The quoted price is outside the allowed band around the reference price. Quote again and retry.',
  },
  AssetNotAllowed: {
    subject: 'asset',
    message: "This asset is not on the mandate's list of stocks it may buy. Only the principal can add it.",
  },
  NotAStock: { subject: 'asset', message: 'This asset is a treasury token. It can be parked, not bought as a stock.' },
  TradeCapExceeded: {
    subject: 'amount',
    message: 'The purchase is larger than the per-trade limit for this asset (25 USDG at launch). Buy less.',
  },
  SwapShort: {
    subject: 'price',
    message:
      "The fill would have been worse than the mandate's slippage limit against the reference price, so " +
      'nothing was bought.',
  },
};

/**
 * What the collateral vault and the credit pool refuse a draw, deposit or repayment for. A spend on
 * credit borrows inside the mandate's own `spend`, so these reach the pay and hire tools too.
 */
const COLLATERAL_REFUSALS: Readonly<Record<string, Omit<Refusal, 'code'>>> = {
  HealthTooLow: {
    subject: 'mandate',
    message:
      'This would leave the collateral health under the vault’s minimum of 1.25. A draw or a withdrawal is ' +
      'checked with every position at its after-hours haircut, whatever the time, and a position counts ' +
      'for nothing while its price is stale, its token, its oracle or the access registry is paused, its ' +
      'trading pool is out of line with its reference price, or the price guard holds no recent reading of ' +
      'its pool in which the two agreed. Post more collateral, repay some debt, or spend less.',
  },
  NotCollateralLane: {
    subject: 'mandate',
    message:
      'This mandate was not created for collateral-backed credit, so it cannot borrow. Prefunded mandates ' +
      'spend only what they hold.',
  },
  NoLine: {
    subject: 'mandate',
    message: 'This mandate has no collateral line open. The principal opens one before collateral can be posted.',
  },
  NotFactoryAccount: {
    subject: 'mandate',
    message:
      "Only a mandate one of this deployment's factories created can open a collateral line or park funds.",
  },
  NotCollateral: {
    subject: 'asset',
    message: 'This token is not accepted as collateral. The published haircut tiers list the tokens that are.',
  },
  MandateCapExceeded: {
    subject: 'limits',
    message: 'This draw would take the mandate past its credit limit (10 USDG at launch). Repay first or spend less.',
  },
  TotalCapExceeded: {
    subject: 'limits',
    message:
      'Collateral-backed credit has reached its total limit across every mandate. Repay, or wait until other ' +
      'debt is repaid.',
  },
  InsufficientCash: {
    subject: 'amount',
    message: 'The credit pool does not hold enough USDG to lend this amount right now.',
  },
  NoDebt: { subject: 'amount', message: 'This mandate owes nothing, so there is nothing to repay.' },
  Healthy: { subject: 'mandate', message: 'This position is at or above 1.0 health, so it cannot be liquidated.' },
  PositionEmpty: { subject: 'asset', message: 'The mandate holds none of this asset as collateral.' },
  NothingToSell: { subject: 'asset', message: 'Nothing needs to be sold to restore this position.' },
  BuybackStakingMismatch: {
    subject: 'governance',
    message:
      'The credit pool was deployed against a buyback and a staking pool that do not belong together, so it ' +
      'could not turn a loss into a stake slash. Nothing an agent sends reaches this. Report it to the operator.',
  },
};

/**
 * What the escrow refuses a lock or a dispute for. A spend opens its lock inside the mandate's own
 * `spend` and a dispute goes through `disputeSpend`, so these reach the pay, hire and dispute tools
 * with the escrow's name on them.
 */
const ESCROW_REFUSALS: Readonly<Record<string, Omit<Refusal, 'code'>>> = {
  BelowMinLock: {
    subject: 'amount',
    message:
      'The escrow locks no payment under its floor, which mandate_inspect reports as the escrow minLock. ' +
      'The floor keeps every payment large enough that contesting it costs a bond. Pay at least that much.',
  },
  BadMinLock: {
    subject: 'escrow',
    message:
      'The escrow refuses a lock floor too small for a dispute bond to cost anything, and it checks that ' +
      'once, when it is deployed. Nothing an agent sends reaches this. Report it to the operator.',
  },
  TooLate: {
    subject: 'dispute',
    message:
      'Too late for this call. A held payment can be contested only until its delivery deadline, after ' +
      'which it goes back to the mandate. A delivered one can be contested only inside the dispute window ' +
      'mandate_get_settlement reports.',
  },
  PayeeCapExceeded: {
    subject: 'provider',
    message:
      'The escrow will not hold this much for this provider yet. Its ceiling on a single payment rises ' +
      'with delivered work. Split the job into smaller payments, or pay a provider with more history.',
  },
  PartyNotAllowed: {
    subject: 'provider',
    message:
      'This provider is not an active listing in the agent registry, so the escrow will not hold a payment ' +
      'for it. A provider has to be listed, staked and not barred before it can be paid.',
  },
  BadTtl: {
    subject: 'escrow',
    message:
      'The delivery deadline falls outside what the escrow accepts. mandate_inspect reports the range; ask ' +
      'for at least a minute over its minimum.',
  },
  EnforcedPause: {
    subject: 'escrow',
    message:
      'The escrow is paused, so no payment locks and no dispute opens until governance lifts the pause. ' +
      'Funds already held stay where they are.',
  },
};

const TABLES: Readonly<Record<RefusalScope, Readonly<Record<string, Omit<Refusal, 'code'>>>>> = {
  mandate: REFUSALS,
  resolver: RESOLVER_REFUSALS,
  provider: PROVIDER_REFUSALS,
};

/** The same table by name, so a name from outside this package cannot index it out of range. */
const BY_NAME: ReadonlyMap<string, Omit<Refusal, 'code'>> = new Map([
  ...Object.entries(COLLATERAL_REFUSALS),
  ...Object.entries(RWA_REFUSALS),
  ...Object.entries(ESCROW_REFUSALS),
  ...Object.entries(REFUSALS),
]);

/**
 * Selectors come from the deployed ABI, so a renamed error cannot leave a stale selector behind
 * that reports the wrong refusal. Every name in that ABI has an entry above, which the key type
 * enforces at compile time.
 */
const BY_SELECTOR: ReadonlyMap<Hex, Refusal> = new Map([
  ...[...collateralVaultAbi, ...creditPoolAbi]
    .filter((item) => item.type === 'error' && COLLATERAL_REFUSALS[item.name] !== undefined)
    .map((item) => {
      const error = item as { name: string; inputs: readonly { type: string }[] };
      const signature = `${error.name}(${error.inputs.map((input) => input.type).join(',')})`;
      return [toFunctionSelector(signature), { code: error.name, ...COLLATERAL_REFUSALS[error.name]! }] as const;
    }),
  ...[...assetRegistryAbi, ...priceGuardAbi, ...stockSpendRouterAbi]
    .filter((item) => item.type === 'error' && RWA_REFUSALS[item.name] !== undefined)
    .map((item) => {
      const error = item as { name: string; inputs: readonly { type: string }[] };
      const signature = `${error.name}(${error.inputs.map((input) => input.type).join(',')})`;
      return [toFunctionSelector(signature), { code: error.name, ...RWA_REFUSALS[error.name]! }] as const;
    }),
  ...escrowAbi
    .filter((item) => item.type === 'error' && ESCROW_REFUSALS[item.name] !== undefined)
    .map((item) => {
      const error = item as { name: string; inputs: readonly { type: string }[] };
      const signature = `${error.name}(${error.inputs.map((input) => input.type).join(',')})`;
      return [toFunctionSelector(signature), { code: error.name, ...ESCROW_REFUSALS[error.name]! }] as const;
    }),
  ...mandateAccountAbi
    .filter((item): item is Extract<(typeof mandateAccountAbi)[number], { type: 'error' }> => item.type === 'error')
    .map((item) => {
      const signature = `${item.name}(${item.inputs.map((input) => input.type).join(',')})`;
      const known = REFUSALS[item.name];

      return [toFunctionSelector(signature), { code: item.name, ...known }] as const;
    }),
]);

/** `previewSpend` answers with the selector of the error a spend would revert with, or zero. */
export function refusalForSelector(selector: Hex): Refusal | null {
  if (/^0x0{8}$/iu.test(selector)) return null;

  return (
    BY_SELECTOR.get(selector.toLowerCase() as Hex) ?? {
      code: selector,
      subject: 'mandate',
      message: 'The mandate refused this spend for a reason this server does not recognise.',
    }
  );
}

/**
 * The same copy, reached by error name, for a revert a relay decoded before this server saw it.
 *
 * Scoped, because the three contracts share several error names and mean different things by them.
 * A caller that knows which contract refused says so; one that does not gets the mandate's table,
 * which is the only one the spending path can hit.
 */
export function refusalForName(name: string, scope: RefusalScope = 'mandate'): Refusal | null {
  const known = TABLES[scope][name] ?? (scope === 'mandate' ? BY_NAME.get(name) : undefined);

  return known ? { code: name, ...known } : null;
}
