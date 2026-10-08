import { showsSecondCap, totalBudgetOf } from '../chain/limits';
import type { Micro } from '@bursar/core';
import type { Address } from 'viem';

import { RHC, shortAddress } from '../chain/rhc';
import type { ProviderHealth } from '../chain/client';
import type { ChainSnapshot } from '../chain/reader';
import { formatEth, usd, usdg, wei } from '../money';
import type { Wei } from '../money';
import { formatInstant, formatRelative, fromUnix, isPast } from '../lib/time';
import type {
  AssetState,
  Check,
  ConnectivityState,
  FundingState,
  MandateState,
  NextAction,
  PermissionState,
  StateKey,
  StateLevel,
  StateReport,
} from './types';

/**
 * What a transaction costs, in the two parts that move independently.
 *
 * The gas is measured, not estimated: a round trip is one mandate-governed escrow lock and
 * release, a deployment is one MandateAccount, and both are properties of the contracts rather
 * than of the chain they run on. The price is the chain's, observed on Robinhood Chain and
 * re-read at deploy. Multiplying them is a quote for a reader deciding whether to top up, which is
 * why it is stated as "about", and it is never the thing a transaction is charged.
 */
export const ROUND_TRIP_GAS = 738_150n;
export const DEPLOY_GAS = 3_676_631n;

/** 0.054 gwei, observed on Robinhood Chain. Fees are paid in ETH, not in the settlement asset. */
export const OBSERVED_GAS_PRICE_WEI = 54_000_000n;

export const ROUND_TRIP_FEE: Wei = wei(ROUND_TRIP_GAS * OBSERVED_GAS_PRICE_WEI);
export const DEPLOY_FEE: Wei = wei(DEPLOY_GAS * OBSERVED_GAS_PRICE_WEI);

/** Below this many round trips left, the signer is worth warning about before it strands a batch. */
const GAS_WARNING_TRIPS = 20n;

const NO_DATE = undefined;

export function evaluateAsset(snapshot: ChainSnapshot | undefined, checkedAt: Date | null, stale: boolean): AssetState {
  const asset = snapshot?.asset;
  const blockedAddresses = Object.entries(asset?.blocked ?? {})
    .filter(([, blocked]) => blocked === true)
    .map(([address]) => address as Address);

  const checks: Check[] = [];
  if (asset) {
    checks.push({
      id: 'token-paused',
      label: 'USDG transfers',
      level: asset.tokenPaused === undefined ? 'unknown' : asset.tokenPaused ? 'blocked' : 'ok',
      detail:
        asset.tokenPaused === undefined
          ? 'Could not read whether USDG is paused.'
          : asset.tokenPaused
            ? 'USDG is paused. No transfer settles until it resumes.'
            : 'Transfers are open.',
    });

    for (const [address, blocked] of Object.entries(asset.blocked)) {
      checks.push({
        id: `blocked:${address}`,
        label: shortAddress(address),
        level: blocked === undefined ? 'unknown' : blocked ? 'blocked' : 'ok',
        detail:
          blocked === undefined
            ? 'Could not read the blocklist for this address.'
            : blocked
              ? 'On the issuer’s blocklist. Transfers to and from it fail.'
              : 'This address can send and receive USDG.',
      });
    }
  }

  const facts = {
    token: asset?.token ?? ('0x' as Address),
    paused: asset?.tokenPaused,
    controller: asset?.controller,
    blocked: asset?.blocked ?? {},
    blockedAddresses,
  };

  if (!asset) {
    return report('asset', 'Asset', 'unknown', 'Checking USDG.', 'Its status appears here once it is read.', null, checks, facts, checkedAt, stale);
  }

  if (asset.tokenPaused === true) {
    return report(
      'asset',
      'Asset',
      'blocked',
      'USDG is paused.',
      'The token issuer has paused USDG, so no payment settles until it resumes. Fees are paid in ETH, so pausing and revoking still go through.',
      { label: 'Check the status page', owner: 'token-issuer', kind: 'link', href: '/status' },
      checks,
      facts,
      checkedAt,
      stale,
    );
  }

  if (blockedAddresses.length > 0) {
    const list = blockedAddresses.map((address) => shortAddress(address)).join(', ');
    return report(
      'asset',
      'Asset',
      'blocked',
      blockedAddresses.length === 1 ? 'One address cannot move USDG.' : `${blockedAddresses.length} addresses cannot move USDG.`,
      `The issuer’s blocklist covers ${list}. Transfers to or from a blocked address fail, whatever the balance or the mandate allows. Pay through another address, or contact the issuer.`,
      { label: 'Use a different address', owner: 'principal', kind: 'transaction' },
      checks,
      facts,
      checkedAt,
      stale,
    );
  }

  if (asset.incomplete) {
    return report(
      'asset',
      'Asset',
      'unknown',
      'Part of the USDG check did not answer.',
      'Until it does, a payment may still fail on the token.',
      { label: 'Read again', owner: 'operator', kind: 'retry' },
      checks,
      facts,
      checkedAt,
      stale,
    );
  }

  return report(
    'asset',
    'Asset',
    'ok',
    'USDG is moving normally.',
    'Transfers are open and no address here is blocked.',
    null,
    checks,
    facts,
    checkedAt,
    stale,
  );
}

export function evaluateMandate(snapshot: ChainSnapshot | undefined, checkedAt: Date | null, stale: boolean, requested: Address | undefined): MandateState {
  const account = snapshot?.mandate;
  const facts = {
    account,
    perCallRemaining: account?.remaining.perCall,
    dailyRemaining: account?.remaining.daily,
    monthlyRemaining: account?.remaining.monthly,
    dailyResetsAt: account?.remaining.dailyResetsAt,
    monthlyResetsAt: account?.remaining.monthlyResetsAt,
    validUntil: account ? (fromUnix(account.limits.validUntil) ?? NO_DATE) : NO_DATE,
    live: account ? !account.paused && !account.revoked : undefined,
  };

  if (!requested) {
    return report('mandate', 'Mandate', 'not-applicable', 'No mandate selected.', 'Open a mandate to see what it can still spend.', null, [], facts, checkedAt, stale);
  }

  if (!account) {
    return report(
      'mandate',
      'Mandate',
      snapshot ? 'blocked' : 'unknown',
      snapshot ? 'No mandate at this address.' : 'Reading the mandate.',
      snapshot
        ? `${shortAddress(requested)} is not a mandate account. Check the address, or create a mandate first.`
        : 'Its limits appear here in a moment.',
      snapshot ? { label: 'Create a mandate', owner: 'principal', kind: 'link', href: '/console/new' } : null,
      [],
      facts,
      checkedAt,
      stale,
    );
  }

  const now = snapshot?.chainTime ?? new Date();
  const validFrom = fromUnix(account.limits.validFrom);
  const validUntil = fromUnix(account.limits.validUntil);
  const budget = totalBudgetOf(account);
  const total = budget !== undefined;
  const secondCap = showsSecondCap(account);

  const escrowStopped = snapshot?.escrow.paused === true;
  const checks: Check[] = [
    ...(escrowStopped
      ? [{ id: 'escrow', label: 'Escrow', level: 'blocked' as const, detail: 'Stopped by the guardian. It takes no new payments until a restart proposal runs.' }]
      : []),
    {
      id: 'live',
      label: 'Spending',
      level: account.paused ? 'blocked' : 'ok',
      detail: account.paused ? 'The owner paused this mandate.' : 'The owner has it running.',
    },
    {
      id: 'agent',
      label: 'Agent',
      level: account.revoked ? 'blocked' : 'ok',
      detail: account.revoked
        ? 'Revoked. Nothing can spend until the owner seats a new agent.'
        : `${shortAddress(account.agent)} is seated and can spend inside the limits.`,
    },
    {
      id: 'validity',
      label: 'Validity',
      level: validityLevel(validFrom, validUntil, now),
      detail: validityDetail(validFrom, validUntil, now),
    },
    {
      id: 'per-call',
      label: 'Per payment',
      level: 'ok',
      detail: `Up to ${usd(account.limits.perCallCap)} in one payment. ${approvalSentence(account.limits.perCallCap, account.limits.approvalThreshold)}`,
    },
    windowCheck('daily', 'This period', account.remaining.daily, account.daily.cap, account.remaining.dailyResetsAt, now),
    ...(secondCap
      ? [windowCheck('monthly', 'Second cap', account.remaining.monthly, account.monthly.cap, account.remaining.monthlyResetsAt, now)]
      : []),
    ...(budget ? [totalCheck(budget.remaining, budget.cap)] : []),
  ];

  const headroom = `${usd(account.remaining.daily)} left this period, ${usd(budget ? budget.remaining : account.remaining.monthly)} left ${total ? 'in the total budget' : 'under the second cap'}.`;

  if (escrowStopped) {
    return report('mandate', 'Mandate', 'blocked', 'The escrow is stopped.', `The guardian stopped the escrow, so no payment can lock until a restart proposal runs. Payments it already holds still settle. ${headroom}`, null, checks, facts, checkedAt, stale);
  }

  if (account.revoked) {
    return report('mandate', 'Mandate', 'blocked', 'The agent is revoked.', 'Nothing can spend until the owner seats an agent.', { label: 'Seat an agent', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  if (account.paused) {
    return report('mandate', 'Mandate', 'blocked', 'Spending is paused.', `The owner paused it. Nothing is spent until it resumes, with the same limits. ${headroom}`, { label: 'Resume spending', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  if (validUntil && isPast(validUntil, now)) {
    return report('mandate', 'Mandate', 'blocked', `The mandate expired ${formatRelative(validUntil, now)}.`, `It stopped taking payments on ${formatInstant(validUntil)}. Extend it to spend again.`, { label: 'Extend the mandate', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  if (validFrom && !isPast(validFrom, now)) {
    return report('mandate', 'Mandate', 'blocked', `This mandate starts ${formatRelative(validFrom, now)}.`, `It takes payments from ${formatInstant(validFrom)}.`, { label: 'Wait for it to open', owner: 'principal', kind: 'wait', waitUntil: validFrom }, checks, facts, checkedAt, stale);
  }

  if (account.remaining.daily === 0n) {
    return report('mandate', 'Mandate', 'blocked', 'This period’s cap is spent.', `The ${usd(account.daily.cap)} period cap is used. It refills ${formatRelative(account.remaining.dailyResetsAt, now)}, at ${formatInstant(account.remaining.dailyResetsAt)}. Raise it to spend sooner.`, { label: 'Wait for the period to roll', owner: 'principal', kind: 'wait', waitUntil: account.remaining.dailyResetsAt }, checks, facts, checkedAt, stale);
  }

  if (budget && budget.remaining === 0n) {
    return report('mandate', 'Mandate', 'blocked', 'The total budget is spent.', `The ${usd(budget.cap)} total budget is used and never refills. The owner can raise it.`, { label: 'Raise the total budget', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  if (secondCap && account.remaining.monthly === 0n) {
    return report('mandate', 'Mandate', 'blocked', 'The second cap is spent.', `The ${usd(account.monthly.cap)} second cap is used. It refills ${formatRelative(account.remaining.monthlyResetsAt, now)}. Raise it to spend sooner.`, { label: 'Wait for the window to roll', owner: 'principal', kind: 'wait', waitUntil: account.remaining.monthlyResetsAt }, checks, facts, checkedAt, stale);
  }

  // A payment was named and the account answered about that payment. Its answer is more specific
  // than anything derived from the limits here, so when it refuses on a limit it is what gets
  // reported, with the amount that was asked about.
  const refusal = limitRefusal(snapshot?.permission);
  if (refusal) {
    return report('mandate', 'Mandate', 'blocked', refusal.headline, `${refusal.detail} ${headroom}`, refusal.action, checks, facts, checkedAt, stale);
  }

  const closing = validUntil && secondsBetween(validUntil, now) < 48 * 3600;
  const thin = account.daily.cap > 0n && account.remaining.daily * 10n < account.daily.cap;

  if (closing && validUntil) {
    return report('mandate', 'Mandate', 'attention', `The mandate expires ${formatRelative(validUntil, now)}.`, `${headroom} Payments stop at ${formatInstant(validUntil)} unless the owner extends it.`, { label: 'Extend the mandate', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  if (thin) {
    return report('mandate', 'Mandate', 'attention', `${usd(account.remaining.daily)} left this period.`, `Under a tenth of the ${usd(account.daily.cap)} period cap. It refills ${formatRelative(account.remaining.dailyResetsAt, now)}.`, { label: 'Raise the period cap', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  return report('mandate', 'Mandate', 'ok', headroom, `Up to ${usd(account.limits.perCallCap)} in one payment. ${approvalSentence(account.limits.perCallCap, account.limits.approvalThreshold)}`, null, checks, facts, checkedAt, stale);
}

export function evaluatePermission(snapshot: ChainSnapshot | undefined, checkedAt: Date | null, stale: boolean): PermissionState {
  const permission = snapshot?.permission;
  const facts = {
    merchant: permission?.merchant,
    merchantAllowed: permission?.merchantAllowed,
    capability: permission?.capability,
    capabilityId: permission?.capabilityId,
    capabilityAllowed: permission?.capabilityAllowed,
    preview: permission?.preview,
    provider: snapshot?.provider,
  };

  if (!permission || (permission.merchant === undefined && permission.capabilityId === undefined)) {
    return report('permission', 'Permission', 'not-applicable', 'No payee named.', 'Name a payee and a kind of work to see whether this mandate allows them.', null, [], facts, checkedAt, stale);
  }

  const checks: Check[] = [];
  if (permission.merchant) {
    const gated = snapshot?.mandate?.merchantGate === 1;
    checks.push({
      id: 'merchant',
      label: 'Payee',
      level: permission.merchantAllowed === undefined ? (gated ? 'unknown' : 'unknown') : permission.merchantAllowed ? 'ok' : 'blocked',
      detail: gated
        ? 'This mandate checks payees against a published list, so each payment proves its payee is on it.'
        : permission.merchantAllowed === undefined
          ? 'Could not read the payee list.'
          : permission.merchantAllowed
            ? `${shortAddress(permission.merchant)} is on the payee list.`
            : `${shortAddress(permission.merchant)} is not on the payee list.`,
    });
  }

  if (permission.capability) {
    checks.push({
      id: 'capability',
      label: 'Capability',
      level: permission.capabilityAllowed === undefined ? 'unknown' : permission.capabilityAllowed ? 'ok' : 'blocked',
      detail:
        permission.capabilityAllowed === undefined
          ? 'Could not read the list of allowed work.'
          : permission.capabilityAllowed
            ? `${permission.capability} is a kind of work this mandate pays for.`
            : `This mandate does not pay for ${permission.capability}.`,
    });
  }

  if (permission.merchantAllowed === false) {
    return report('permission', 'Permission', 'blocked', 'This payee is not allowed.', `${shortAddress(permission.merchant ?? '0x')} is not on the payee list. The owner can add it.`, { label: 'Add the payee', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  if (permission.capabilityAllowed === false) {
    return report('permission', 'Permission', 'blocked', `${permission.capability} is not allowed.`, 'This mandate does not pay for this kind of work. The owner can add it.', { label: 'Add the capability', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  if (permission.preview && !permission.preview.allowed) {
    const reason = permission.preview.reason;
    const permissionReason = reason === 'merchant-not-allowed' || reason === 'capability-not-allowed' || reason === 'class-not-allowed' || reason === 'merchant-proof-required' || reason === 'merchant-proof-invalid' || reason === 'merchant-proof-unexpected';
    if (permissionReason) {
      return report('permission', 'Permission', 'blocked', 'The mandate would refuse this payment.', previewDetail(reason), { label: 'Update the lists', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
    }
  }

  if (permission.merchantAllowed === undefined && permission.capabilityAllowed === undefined) {
    return report('permission', 'Permission', 'unknown', 'The payee and work lists did not answer.', 'Whether this payment is allowed is not known yet.', { label: 'Read again', owner: 'operator', kind: 'retry' }, checks, facts, checkedAt, stale);
  }

  const subject = permission.merchant ? shortAddress(permission.merchant) : 'this payee';
  const work = permission.capability ? ` for ${permission.capability}` : '';
  return report('permission', 'Permission', 'ok', `The mandate pays ${subject}${work}.`, 'Both the payee and the kind of work are allowed.', null, checks, facts, checkedAt, stale);
}

/**
 * Two balances in two assets, kept apart.
 *
 * The mandate holds USDG and that is what a provider is paid in. The signer holds ETH and that is
 * what a transaction costs. Neither covers for the other: an account can hold a year of USDG and
 * not have the ETH to send the transaction that pauses it, and a signer with ETH and an empty
 * mandate settles nothing. So every sentence here names the asset that is short, and the two are
 * never added, compared or summarised into one figure.
 */
export function evaluateFunding(snapshot: ChainSnapshot | undefined, checkedAt: Date | null, stale: boolean, drawable?: Micro): FundingState {
  const funding = snapshot?.funding;
  const account = snapshot?.mandate;
  const facts = {
    mandate: account?.address,
    mandateBalance: funding?.mandateBalance,
    gasPayer: funding?.gasPayer,
    gasBalance: funding?.gasBalance,
    roundTripFee: ROUND_TRIP_FEE,
    deployFee: DEPLOY_FEE,
  };

  if (!funding || (funding.mandateBalance === undefined && funding.gasBalance === undefined)) {
    return report('funding', 'Funding', 'not-applicable', 'Nothing to fund yet.', 'Open a mandate or connect a wallet to see its USDG for payments and ETH for fees.', null, [], facts, checkedAt, stale);
  }

  // An account that draws parked value or credit inside the payment is not short while the two
  // together cover it, and telling its owner to fund it would contradict the spending power shown
  // beside this.
  const draw = drawable ?? 0n;
  const drawNote = draw > 0n ? ` It can draw ${usd(draw as Micro)} more inside a payment, from parked value or its credit line.` : '';

  const checks: Check[] = [];
  if (funding.mandateBalance !== undefined && account) {
    checks.push({
      id: 'mandate-balance',
      label: 'Mandate account, USDG',
      level: funding.mandateBalance === 0n && draw === 0n ? 'blocked' : funding.mandateBalance + draw < account.limits.perCallCap ? 'attention' : 'ok',
      detail:
        funding.mandateBalance === 0n
          ? `${shortAddress(account.address)} holds no USDG. Providers are paid from this account.`
          : `${shortAddress(account.address)} holds ${usdg(funding.mandateBalance)} for payments.`,
    });
  }

  if (funding.gasBalance !== undefined && funding.gasPayer) {
    const trips = funding.gasBalance / ROUND_TRIP_FEE;
    checks.push({
      id: 'gas-float',
      label: 'Transaction fees, ETH',
      level: funding.gasBalance < ROUND_TRIP_FEE ? 'blocked' : trips < GAS_WARNING_TRIPS ? 'attention' : 'ok',
      detail: `${shortAddress(funding.gasPayer)} holds ${formatEth(funding.gasBalance)}, enough for about ${trips} payments at ${formatEth(ROUND_TRIP_FEE)} each.`,
    });
  }

  if (funding.gasBalance !== undefined && funding.gasBalance < ROUND_TRIP_FEE) {
    return report('funding', 'Funding', 'blocked', 'The signer has no ETH for fees.', `Fees on ${RHC.name} are paid in ETH. ${shortAddress(funding.gasPayer ?? '0x')} holds ${formatEth(funding.gasBalance)} and one payment costs about ${formatEth(ROUND_TRIP_FEE)}. USDG in the mandate cannot pay fees.`, { label: 'Send ETH to the signer', owner: 'principal', kind: 'fund' }, checks, facts, checkedAt, stale);
  }

  if (account && funding.mandateBalance === 0n && draw === 0n) {
    return report('funding', 'Funding', 'blocked', 'The mandate account holds no USDG.', `Providers are paid in USDG from ${shortAddress(account.address)}. Send USDG to that address to fund it.`, { label: 'Fund the mandate', owner: 'principal', kind: 'fund' }, checks, facts, checkedAt, stale);
  }

  const lowGas = funding.gasBalance !== undefined && funding.gasBalance / ROUND_TRIP_FEE < GAS_WARNING_TRIPS;
  if (lowGas && funding.gasBalance !== undefined) {
    const trips = funding.gasBalance / ROUND_TRIP_FEE;
    return report('funding', 'Funding', 'attention', `ETH for about ${trips} more payments.`, `${shortAddress(funding.gasPayer ?? '0x')} holds ${formatEth(funding.gasBalance)} and a payment costs about ${formatEth(ROUND_TRIP_FEE)}. Add ETH before a run stops partway.`, { label: 'Send ETH to the signer', owner: 'principal', kind: 'fund' }, checks, facts, checkedAt, stale);
  }

  if (account && funding.mandateBalance !== undefined && funding.mandateBalance + draw < account.limits.perCallCap) {
    return report('funding', 'Funding', 'attention', `The mandate holds ${usdg(funding.mandateBalance)}.`, `${drawNote.trim()} ${draw > 0n ? 'Together that is' : 'That is'} less than its ${usd(account.limits.perCallCap)} per-payment limit, so its largest payment would fail.`.trim(), { label: 'Fund the mandate', owner: 'principal', kind: 'fund' }, checks, facts, checkedAt, stale);
  }

  const held = funding.mandateBalance === undefined ? '' : `The mandate holds ${usdg(funding.mandateBalance)} for payments.${drawNote} `;
  const fees = funding.gasBalance === undefined ? '' : `The signer holds ${formatEth(funding.gasBalance)} for fees.`;

  // A balance that was asked for and did not answer is not a balance that passed. "Funded in both
  // assets" over a panel whose ETH line reads Unread is the state claiming a reading it never got,
  // and it is a claim a reader acts on: they stop topping up the wallet that may well be empty.
  if (funding.gasPayer !== undefined && funding.gasBalance === undefined) {
    return report('funding', 'Funding', 'unknown', 'Could not read the fee balance.', `The ETH balance of ${shortAddress(funding.gasPayer)} did not answer. Nothing changed on chain. ${held}`.trim(), { label: 'Read again', owner: 'operator', kind: 'retry' }, checks, facts, checkedAt, stale);
  }

  if (account && funding.mandateBalance === undefined) {
    return report('funding', 'Funding', 'unknown', 'Could not read the mandate balance.', `The USDG balance of ${shortAddress(account.address)} did not answer. Nothing changed on chain. ${fees}`.trim(), { label: 'Read again', owner: 'operator', kind: 'retry' }, checks, facts, checkedAt, stale);
  }

  // Only one asset was asked about, which is not two that answered. Without a signer there is
  // nobody whose ETH pays a fee, so the report covers what it read and names what it did not.
  if (funding.gasBalance === undefined) {
    return report('funding', 'Funding', 'ok', held.trim(), 'Connect a wallet to see the ETH that pays transaction fees.', null, checks, facts, checkedAt, stale);
  }

  if (funding.mandateBalance === undefined) {
    return report('funding', 'Funding', 'ok', fees, 'Open a mandate to see the USDG it holds for payments.', null, checks, facts, checkedAt, stale);
  }

  return report('funding', 'Funding', 'ok', 'Funded for payments and fees.', `${held}${fees}`.trim(), null, checks, facts, checkedAt, stale);
}

export function evaluateConnectivity(
  providers: readonly ProviderHealth[] | undefined,
  chainId: number,
  blockNumber: bigint | undefined,
  checkedAt: Date | null,
  stale: boolean,
): ConnectivityState {
  const list = providers ?? [];
  const reachable = list.filter((provider) => provider.reachable);
  const heads = reachable.map((provider) => provider.blockNumber).filter((value): value is bigint => value !== null);
  const headSpread = heads.length > 1 ? maxOf(heads) - minOf(heads) : heads.length === 1 ? 0n : undefined;

  const facts = { chainId, providers: list, reachable: reachable.length, blockNumber, headSpread };

  const checks: Check[] = list.map((provider) => ({
    id: `provider:${provider.name}`,
    label: provider.name,
    level: (!provider.reachable ? 'blocked' : provider.chainId !== chainId ? 'blocked' : provider.breaker === 'open' ? 'attention' : 'ok') as StateLevel,
    detail: !provider.reachable
      ? `Not answering. ${provider.problem ?? ''}`.trim()
      : provider.chainId !== chainId
        ? `Answering for chain ${provider.chainId}, and Bursar runs on chain ${chainId}.`
        : `Block ${provider.blockNumber?.toString() ?? '?'} in ${provider.latencyMs}ms.`,
  }));

  if (list.length === 0) {
    return report('connectivity', 'Connectivity', 'unknown', 'Checking the connection.', 'The network status appears here in a moment.', null, checks, facts, checkedAt, stale);
  }

  if (reachable.length === 0) {
    return report('connectivity', 'Connectivity', 'blocked', `${RHC.name} is not reachable from here.`, 'Neither endpoint answered, so this screen is not current and nothing can be sent. Check your connection, then try again.', { label: 'Try again', owner: 'operator', kind: 'retry' }, checks, facts, checkedAt, stale);
  }

  const wrongChain = reachable.find((provider) => provider.chainId !== chainId);
  if (wrongChain) {
    return report('connectivity', 'Connectivity', 'blocked', 'An endpoint is serving a different chain.', `${wrongChain.name} answered for chain ${wrongChain.chainId} and Bursar runs on chain ${chainId}. Reads from it would describe a different network.`, { label: 'Correct the endpoint', owner: 'operator', kind: 'contact' }, checks, facts, checkedAt, stale);
  }

  if (reachable.length < list.length) {
    const down = list.filter((provider) => !provider.reachable).map((provider) => provider.name).join(', ');
    return report('connectivity', 'Connectivity', 'attention', `${down} is not answering.`, `Reads continue on the other endpoint.`, { label: 'Restore the endpoint', owner: 'operator', kind: 'contact' }, checks, facts, checkedAt, stale);
  }

  if (headSpread !== undefined && headSpread > 30n) {
    return report('connectivity', 'Connectivity', 'attention', 'The endpoints disagree on the current block.', `One is ${headSpread} blocks behind, so some figures may be slightly out of date.`, null, checks, facts, checkedAt, stale);
  }

  return report('connectivity', 'Connectivity', 'ok', `Connected to ${RHC.name}.`, `${reachable.length} of ${list.length} endpoints answering${blockNumber === undefined ? '' : ` at block ${blockNumber.toString()}`}.`, null, checks, facts, checkedAt, stale);
}

function totalCheck(remaining: Micro, cap: Micro): Check {
  const level: StateLevel = remaining === 0n ? 'blocked' : cap > 0n && remaining * 10n < cap ? 'attention' : 'ok';
  return {
    id: 'monthly',
    label: 'Total budget',
    level,
    detail:
      remaining === 0n
        ? `All ${usd(cap)} is spent. It never refills.`
        : `${usd(remaining)} left of ${usd(cap)}. It never refills.`,
  };
}

function windowCheck(id: string, label: string, remaining: Micro, cap: Micro, resetsAt: Date, now: Date): Check {
  const level: StateLevel = remaining === 0n ? 'blocked' : cap > 0n && remaining * 10n < cap ? 'attention' : 'ok';
  return {
    id,
    label,
    level,
    detail:
      remaining === 0n
        ? `All ${usd(cap)} is spent. It refills ${formatRelative(resetsAt, now)}.`
        : `${usd(remaining)} left of ${usd(cap)}. It refills ${formatRelative(resetsAt, now)}.`,
  };
}

function validityLevel(from: Date | null, until: Date | null, now: Date): StateLevel {
  if (until && isPast(until, now)) return 'blocked';
  if (from && !isPast(from, now)) return 'blocked';
  if (until && secondsBetween(until, now) < 48 * 3600) return 'attention';
  return 'ok';
}

function validityDetail(from: Date | null, until: Date | null, now: Date): string {
  if (until && isPast(until, now)) return `Expired on ${formatInstant(until)}.`;
  if (from && !isPast(from, now)) return `Opens on ${formatInstant(from)}.`;
  if (until) return `Valid until ${formatInstant(until)}, ${formatRelative(until, now)}.`;
  return 'No end date.';
}

/**
 * The account's own answer about a named payment, when what stopped it was a limit.
 *
 * Permission-class refusals belong to the permission state and are reported there. Everything left
 * is the mandate refusing its own agent, which is this state's job to say.
 */
function limitRefusal(
  permission: ChainSnapshot['permission'],
): { headline: string; detail: string; action: NextAction } | undefined {
  const preview = permission?.preview;
  if (!preview || preview.allowed) return undefined;

  const asked = permission?.amount === undefined ? 'That payment' : usd(permission.amount);

  switch (preview.reason) {
    case 'per-call-cap':
      return {
        headline: `${asked} is over the limit on one payment.`,
        detail: 'The account refuses it before any money moves. Split it, or raise the per-payment limit.',
        action: { label: 'Raise the per-payment limit', owner: 'principal', kind: 'transaction' },
      };
    case 'daily-cap':
      return {
        headline: `${asked} is more than this period’s cap has left.`,
        detail: 'It is refused until the period refills or the cap is raised.',
        action: { label: 'Raise the period cap', owner: 'principal', kind: 'transaction' },
      };
    case 'monthly-cap':
      return {
        headline: `${asked} is more than the second cap has left.`,
        detail: 'It is refused until that cap refills or is raised.',
        action: { label: 'Raise the second cap', owner: 'principal', kind: 'transaction' },
      };
    case 'total-budget':
      return {
        headline: `${asked} is more than the total budget has left.`,
        detail: 'The total budget never refills. It is refused until the owner raises it.',
        action: { label: 'Raise the total budget', owner: 'principal', kind: 'transaction' },
      };
    case 'approval-required':
      return {
        headline: `${asked} needs the owner’s signature.`,
        detail: 'It is at or above the approval threshold, so the agent cannot pay it alone.',
        action: { label: 'Approve this payment', owner: 'principal', kind: 'transaction' },
      };
    default:
      return undefined;
  }
}

function previewDetail(reason: string | undefined): string {
  switch (reason) {
    case 'merchant-not-allowed':
      return 'The payee is not on this mandate’s payee list.';
    case 'capability-not-allowed':
      return 'This kind of work is not on the mandate’s list.';
    case 'class-not-allowed':
      return 'This mandate does not allow this kind of spend.';
    case 'merchant-proof-required':
      return 'This mandate checks payees against a published list, so the payment must prove its payee is on it.';
    case 'merchant-proof-invalid':
      return 'The proof sent for this payee does not match the mandate’s list.';
    case 'merchant-proof-unexpected':
      return 'This mandate keeps its own payee list, so the payment must not carry a list proof.';
    default:
      return 'This mandate’s permissions would refuse this payment.';
  }
}

function secondsBetween(target: Date, now: Date): number {
  return Math.floor((target.getTime() - now.getTime()) / 1000);
}

function maxOf(values: readonly bigint[]): bigint {
  return values.reduce((best, value) => (value > best ? value : best), values[0] ?? 0n);
}

function minOf(values: readonly bigint[]): bigint {
  return values.reduce((best, value) => (value < best ? value : best), values[0] ?? 0n);
}

function report<K extends StateKey, F>(
  key: K,
  label: string,
  level: StateLevel,
  headline: string,
  detail: string,
  nextAction: NextAction | null,
  checks: readonly Check[],
  facts: F,
  checkedAt: Date | null,
  stale: boolean,
): StateReport<K, F> {
  return { key, label, level, headline, detail, nextAction, checks, facts, checkedAt, stale };
}

/**
 * Who signs what, in one sentence. A threshold above the per-payment cap can never be reached, and
 * the contract's "no approval" setting is the largest number it can hold, so neither is printed.
 */
export function approvalSentence(perCallCap: Micro, threshold: Micro): string {
  if (threshold === 0n) return 'The owner signs every payment personally.';
  if (threshold > perCallCap) return 'No payment needs the owner’s signature.';
  return `At or above ${usd(threshold)}, the owner signs personally.`;
}
