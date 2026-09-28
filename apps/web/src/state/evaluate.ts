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
          ? 'The token did not answer whether it is paused.'
          : asset.tokenPaused
            ? 'The token is paused. No transfer settles while it stays that way.'
            : 'The token is open and transfers settle.',
    });

    for (const [address, blocked] of Object.entries(asset.blocked)) {
      checks.push({
        id: `blocked:${address}`,
        label: shortAddress(address),
        level: blocked === undefined ? 'unknown' : blocked ? 'blocked' : 'ok',
        detail:
          blocked === undefined
            ? 'The blocklist read did not answer for this address.'
            : blocked
              ? 'This address is on the token issuer’s blocklist. Transfers to and from it revert.'
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
    return report('asset', 'Asset', 'unknown', 'The token has not been read yet.', 'Nothing is known about USDG on this screen until the first reading lands.', null, checks, facts, checkedAt, stale);
  }

  if (asset.tokenPaused === true) {
    return report(
      'asset',
      'Asset',
      'blocked',
      'USDG is paused.',
      'The pause belongs to the token issuer. While it is on, no payment settles. Transaction fees are paid in ETH and are unaffected, so a pause, a revoke or a withdrawal still confirms. Watch the status page for the all-clear.',
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
      `The token issuer’s blocklist covers ${list}. Transfers to and from a blocked address revert on the token, whatever the balance shows and whatever this mandate allows. Route the payment through an address that is not blocked, or take it up with the issuer.`,
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
      'The token’s compliance state is incomplete.',
      'At least one compliance read did not answer. Nothing here can be called clear, and a payment may still revert on the token.',
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
    'The token is open and none of the addresses on this screen are blocked.',
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
    return report('mandate', 'Mandate', 'not-applicable', 'No mandate selected.', 'Choose a mandate to see what it can still spend and when its limits roll.', null, [], facts, checkedAt, stale);
  }

  if (!account) {
    return report(
      'mandate',
      'Mandate',
      snapshot ? 'blocked' : 'unknown',
      snapshot ? 'No mandate at this address.' : 'The mandate has not been read yet.',
      snapshot
        ? `Nothing at ${shortAddress(requested)} answers as a mandate account. Check the address, or create the mandate before funding it.`
        : 'The first reading has not landed.',
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

  const checks: Check[] = [
    {
      id: 'live',
      label: 'Spending',
      level: account.paused ? 'blocked' : 'ok',
      detail: account.paused ? 'The principal paused this mandate.' : 'The principal has this mandate running.',
    },
    {
      id: 'agent',
      label: 'Agent',
      level: account.revoked ? 'blocked' : 'ok',
      detail: account.revoked
        ? 'The agent was revoked. Nothing can spend until the principal seats another one.'
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
      detail: `Up to ${usd(account.limits.perCallCap)} in one payment. At or above ${usd(account.limits.approvalThreshold)} the principal signs it personally.`,
    },
    windowCheck('daily', 'Today', account.remaining.daily, account.daily.cap, account.remaining.dailyResetsAt, now),
    windowCheck('monthly', 'This month', account.remaining.monthly, account.monthly.cap, account.remaining.monthlyResetsAt, now),
  ];

  const headroom = `${usd(account.remaining.daily)} left today, ${usd(account.remaining.monthly)} left this month.`;

  if (account.revoked) {
    return report('mandate', 'Mandate', 'blocked', 'The agent is revoked.', 'The agent seated on this mandate was removed, so nothing can spend against it. Seat an agent to start again.', { label: 'Seat an agent', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  if (account.paused) {
    return report('mandate', 'Mandate', 'blocked', 'Spending is paused.', `The principal paused this mandate. ${headroom} Nothing is spent while it stays paused, and resuming restores the limits exactly as they are.`, { label: 'Resume spending', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  if (validUntil && isPast(validUntil, now)) {
    return report('mandate', 'Mandate', 'blocked', `The mandate expired ${formatRelative(validUntil, now)}.`, `Its validity window closed on ${formatInstant(validUntil)}. Set a new window to let it spend again.`, { label: 'Extend the mandate', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  if (validFrom && !isPast(validFrom, now)) {
    return report('mandate', 'Mandate', 'blocked', `This mandate starts ${formatRelative(validFrom, now)}.`, `It is set to open on ${formatInstant(validFrom)} and refuses every payment until then.`, { label: 'Wait for it to open', owner: 'principal', kind: 'wait', waitUntil: validFrom }, checks, facts, checkedAt, stale);
  }

  if (account.remaining.daily === 0n) {
    return report('mandate', 'Mandate', 'blocked', 'Today’s limit is spent.', `${usd(account.daily.cap)} of daily allowance is used. The window rolls ${formatRelative(account.remaining.dailyResetsAt, now)}, at ${formatInstant(account.remaining.dailyResetsAt)}. Raise the daily limit to spend sooner.`, { label: 'Wait for the window to roll', owner: 'principal', kind: 'wait', waitUntil: account.remaining.dailyResetsAt }, checks, facts, checkedAt, stale);
  }

  if (account.remaining.monthly === 0n) {
    return report('mandate', 'Mandate', 'blocked', 'This month’s limit is spent.', `${usd(account.monthly.cap)} of monthly allowance is used. The window rolls ${formatRelative(account.remaining.monthlyResetsAt, now)}. Raise the monthly limit to spend sooner.`, { label: 'Wait for the window to roll', owner: 'principal', kind: 'wait', waitUntil: account.remaining.monthlyResetsAt }, checks, facts, checkedAt, stale);
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
    return report('mandate', 'Mandate', 'attention', `The mandate expires ${formatRelative(validUntil, now)}.`, `${headroom} Payments stop at ${formatInstant(validUntil)} unless the window is extended.`, { label: 'Extend the mandate', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  if (thin) {
    return report('mandate', 'Mandate', 'attention', `${usd(account.remaining.daily)} left today.`, `That is under a tenth of the ${usd(account.daily.cap)} daily limit. The window rolls ${formatRelative(account.remaining.dailyResetsAt, now)}.`, { label: 'Raise the daily limit', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  return report('mandate', 'Mandate', 'ok', headroom, `Up to ${usd(account.limits.perCallCap)} in one payment, and the principal signs anything at or above ${usd(account.limits.approvalThreshold)} personally.`, null, checks, facts, checkedAt, stale);
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
    return report('permission', 'Permission', 'not-applicable', 'No payee named.', 'Name a merchant and the kind of work being paid for, and this shows whether the mandate allows the pair.', null, [], facts, checkedAt, stale);
  }

  const checks: Check[] = [];
  if (permission.merchant) {
    const gated = snapshot?.mandate?.merchantGate === 1;
    checks.push({
      id: 'merchant',
      label: 'Merchant',
      level: permission.merchantAllowed === undefined ? (gated ? 'unknown' : 'unknown') : permission.merchantAllowed ? 'ok' : 'blocked',
      detail: gated
        ? 'This mandate checks merchants against a published list. A payment has to carry proof that the merchant is on it.'
        : permission.merchantAllowed === undefined
          ? 'The allowlist did not answer for this merchant.'
          : permission.merchantAllowed
            ? `${shortAddress(permission.merchant)} is on the mandate’s allowlist.`
            : `${shortAddress(permission.merchant)} is not on the mandate’s allowlist.`,
    });
  }

  if (permission.capability) {
    checks.push({
      id: 'capability',
      label: 'Capability',
      level: permission.capabilityAllowed === undefined ? 'unknown' : permission.capabilityAllowed ? 'ok' : 'blocked',
      detail:
        permission.capabilityAllowed === undefined
          ? 'The capability allowlist did not answer.'
          : permission.capabilityAllowed
            ? `${permission.capability} is a kind of work this mandate pays for.`
            : `${permission.capability} is not one of the kinds of work this mandate pays for.`,
    });
  }

  if (permission.merchantAllowed === false) {
    return report('permission', 'Permission', 'blocked', 'This merchant is not allowed.', `The mandate only pays addresses its principal has listed, and ${shortAddress(permission.merchant ?? '0x')} is not one of them. Add it to the allowlist to let the payment through.`, { label: 'Add the merchant', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  if (permission.capabilityAllowed === false) {
    return report('permission', 'Permission', 'blocked', `${permission.capability} is not allowed.`, 'A mandate names which kinds of work it pays for, and this is not one of them. Add the capability to let payments of this kind through.', { label: 'Add the capability', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
  }

  if (permission.preview && !permission.preview.allowed) {
    const reason = permission.preview.reason;
    const permissionReason = reason === 'merchant-not-allowed' || reason === 'capability-not-allowed' || reason === 'merchant-proof-required' || reason === 'merchant-proof-invalid' || reason === 'merchant-proof-unexpected';
    if (permissionReason) {
      return report('permission', 'Permission', 'blocked', 'The mandate would refuse this payment.', previewDetail(reason), { label: 'Update the allowlist', owner: 'principal', kind: 'transaction' }, checks, facts, checkedAt, stale);
    }
  }

  if (permission.merchantAllowed === undefined && permission.capabilityAllowed === undefined) {
    return report('permission', 'Permission', 'unknown', 'The allowlists did not answer.', 'Neither the merchant nor the capability could be read, so whether this payment is allowed is unknown.', { label: 'Read again', owner: 'operator', kind: 'retry' }, checks, facts, checkedAt, stale);
  }

  const subject = permission.merchant ? shortAddress(permission.merchant) : 'this merchant';
  const work = permission.capability ? ` for ${permission.capability}` : '';
  return report('permission', 'Permission', 'ok', `The mandate pays ${subject}${work}.`, 'Both the merchant and the kind of work are on the mandate’s lists.', null, checks, facts, checkedAt, stale);
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
export function evaluateFunding(snapshot: ChainSnapshot | undefined, checkedAt: Date | null, stale: boolean): FundingState {
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
    return report('funding', 'Funding', 'not-applicable', 'Nothing to fund yet.', 'Connect a wallet or choose a mandate, and this shows the USDG the account holds for payments and the ETH the signer holds for fees.', null, [], facts, checkedAt, stale);
  }

  const checks: Check[] = [];
  if (funding.mandateBalance !== undefined && account) {
    checks.push({
      id: 'mandate-balance',
      label: 'Mandate account, USDG',
      level: funding.mandateBalance === 0n ? 'blocked' : funding.mandateBalance < account.limits.perCallCap ? 'attention' : 'ok',
      detail:
        funding.mandateBalance === 0n
          ? `${shortAddress(account.address)} holds no USDG. Providers are paid out of this account.`
          : `${shortAddress(account.address)} holds ${usdg(funding.mandateBalance)} for payments.`,
    });
  }

  if (funding.gasBalance !== undefined && funding.gasPayer) {
    const trips = funding.gasBalance / ROUND_TRIP_FEE;
    checks.push({
      id: 'gas-float',
      label: 'Transaction fees, ETH',
      level: funding.gasBalance < ROUND_TRIP_FEE ? 'blocked' : trips < GAS_WARNING_TRIPS ? 'attention' : 'ok',
      detail: `${shortAddress(funding.gasPayer)} holds ${formatEth(funding.gasBalance)}, about ${trips} more payments at the observed ${formatEth(ROUND_TRIP_FEE)} each.`,
    });
  }

  if (funding.gasBalance !== undefined && funding.gasBalance < ROUND_TRIP_FEE) {
    return report('funding', 'Funding', 'blocked', 'The signer has no ETH for a transaction fee.', `Fees on ${RHC.name} are paid in ETH, and ${shortAddress(funding.gasPayer ?? '0x')} holds ${formatEth(funding.gasBalance)}. One payment costs about ${formatEth(ROUND_TRIP_FEE)}. USDG is a different asset here: funding the mandate account buys nothing a transaction can spend.`, { label: 'Send ETH to the signer', owner: 'principal', kind: 'fund' }, checks, facts, checkedAt, stale);
  }

  if (account && funding.mandateBalance === 0n) {
    return report('funding', 'Funding', 'blocked', 'The mandate account holds no USDG.', `Providers are paid in USDG out of ${shortAddress(account.address)}, and it holds none. Send USDG to that address to fund it. The signer's ETH pays transaction fees and never pays a provider.`, { label: 'Fund the mandate', owner: 'principal', kind: 'fund' }, checks, facts, checkedAt, stale);
  }

  const lowGas = funding.gasBalance !== undefined && funding.gasBalance / ROUND_TRIP_FEE < GAS_WARNING_TRIPS;
  if (lowGas && funding.gasBalance !== undefined) {
    const trips = funding.gasBalance / ROUND_TRIP_FEE;
    return report('funding', 'Funding', 'attention', `About ${trips} payments of fees left.`, `${shortAddress(funding.gasPayer ?? '0x')} holds ${formatEth(funding.gasBalance)} and a payment costs about ${formatEth(ROUND_TRIP_FEE)}. Send it more ETH before a run stops halfway.`, { label: 'Send ETH to the signer', owner: 'principal', kind: 'fund' }, checks, facts, checkedAt, stale);
  }

  if (account && funding.mandateBalance !== undefined && funding.mandateBalance < account.limits.perCallCap) {
    return report('funding', 'Funding', 'attention', `The mandate holds ${usdg(funding.mandateBalance)}.`, `That is under the ${usd(account.limits.perCallCap)} this mandate allows in a single payment, so the largest payment it permits would fail on funds.`, { label: 'Fund the mandate', owner: 'principal', kind: 'fund' }, checks, facts, checkedAt, stale);
  }

  const held = funding.mandateBalance === undefined ? '' : `The mandate holds ${usdg(funding.mandateBalance)} for payments. `;
  const fees = funding.gasBalance === undefined ? '' : `The signer holds ${formatEth(funding.gasBalance)} for fees.`;

  // A balance that was asked for and did not answer is not a balance that passed. "Funded in both
  // assets" over a panel whose ETH line reads Unread is the state claiming a reading it never got,
  // and it is a claim a reader acts on: they stop topping up the wallet that may well be empty.
  if (funding.gasPayer !== undefined && funding.gasBalance === undefined) {
    return report('funding', 'Funding', 'unknown', 'The fee balance did not answer.', `What ${shortAddress(funding.gasPayer)} holds in ETH could not be read, so whether it can pay a transaction fee is unknown rather than settled. Nothing has changed on chain; only the reading failed. ${held}`.trim(), { label: 'Read again', owner: 'operator', kind: 'retry' }, checks, facts, checkedAt, stale);
  }

  if (account && funding.mandateBalance === undefined) {
    return report('funding', 'Funding', 'unknown', 'The mandate balance did not answer.', `What ${shortAddress(account.address)} holds in USDG could not be read, so nothing here establishes that it can pay a provider. Nothing has changed on chain; only the reading failed. ${fees}`.trim(), { label: 'Read again', owner: 'operator', kind: 'retry' }, checks, facts, checkedAt, stale);
  }

  // Only one asset was asked about, which is not two that answered. Without a signer there is
  // nobody whose ETH pays a fee, so the report covers what it read and names what it did not.
  if (funding.gasBalance === undefined) {
    return report('funding', 'Funding', 'ok', held.trim(), 'Connect a wallet and this also reads the ETH that pays the transaction fee. USDG and ETH are two assets here, and neither covers for the other.', null, checks, facts, checkedAt, stale);
  }

  if (funding.mandateBalance === undefined) {
    return report('funding', 'Funding', 'ok', fees, 'Open a mandate and this also reads the USDG it holds for providers. The signer’s ETH pays transaction fees and never pays a provider.', null, checks, facts, checkedAt, stale);
  }

  return report('funding', 'Funding', 'ok', 'Funded in both assets.', `${held}${fees}`.trim(), null, checks, facts, checkedAt, stale);
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
        ? `Answering for chain ${provider.chainId}, and this deployment is on ${chainId}.`
        : `Block ${provider.blockNumber?.toString() ?? '?'} in ${provider.latencyMs}ms.`,
  }));

  if (list.length === 0) {
    return report('connectivity', 'Connectivity', 'unknown', 'The endpoints have not been checked.', 'Nothing is known about the connection until the first check runs.', null, checks, facts, checkedAt, stale);
  }

  if (reachable.length === 0) {
    return report('connectivity', 'Connectivity', 'blocked', `${RHC.name} is not reachable from here.`, 'Neither endpoint answered, so nothing on this screen is current and no transaction can be sent. Check the network this browser is on, then try again.', { label: 'Try again', owner: 'operator', kind: 'retry' }, checks, facts, checkedAt, stale);
  }

  const wrongChain = reachable.find((provider) => provider.chainId !== chainId);
  if (wrongChain) {
    return report('connectivity', 'Connectivity', 'blocked', 'An endpoint is serving a different chain.', `${wrongChain.name} answered for chain ${wrongChain.chainId} and this deployment runs on ${chainId}. Reads from it would describe a different network.`, { label: 'Correct the endpoint', owner: 'operator', kind: 'contact' }, checks, facts, checkedAt, stale);
  }

  if (reachable.length < list.length) {
    const down = list.filter((provider) => !provider.reachable).map((provider) => provider.name).join(', ');
    return report('connectivity', 'Connectivity', 'attention', `${down} is not answering.`, `Reads continue on the other endpoint and nothing is lost. There is nothing behind it if that one goes too, so this is worth fixing before it matters.`, { label: 'Restore the endpoint', owner: 'operator', kind: 'contact' }, checks, facts, checkedAt, stale);
  }

  if (headSpread !== undefined && headSpread > 30n) {
    return report('connectivity', 'Connectivity', 'attention', 'The endpoints disagree on the current block.', `They are ${headSpread} blocks apart. One is behind, so a reading taken from it may be out of date.`, null, checks, facts, checkedAt, stale);
  }

  return report('connectivity', 'Connectivity', 'ok', `${reachable.length} of ${list.length} endpoints answering.`, `Both are serving chain ${chainId}${blockNumber === undefined ? '' : ` at block ${blockNumber.toString()}`}.`, null, checks, facts, checkedAt, stale);
}

function windowCheck(id: string, label: string, remaining: Micro, cap: Micro, resetsAt: Date, now: Date): Check {
  const level: StateLevel = remaining === 0n ? 'blocked' : cap > 0n && remaining * 10n < cap ? 'attention' : 'ok';
  return {
    id,
    label,
    level,
    detail:
      remaining === 0n
        ? `All ${usd(cap)} is spent. The window rolls ${formatRelative(resetsAt, now)}.`
        : `${usd(remaining)} left of ${usd(cap)}. The window rolls ${formatRelative(resetsAt, now)}.`,
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
  return 'Valid with no end date set.';
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
        detail: 'The account refuses it before the money moves. Split it, or raise the per-payment limit.',
        action: { label: 'Raise the per-payment limit', owner: 'principal', kind: 'transaction' },
      };
    case 'daily-cap':
      return {
        headline: `${asked} is more than today’s allowance has left.`,
        detail: 'The account refuses it until the window rolls or the daily limit rises.',
        action: { label: 'Raise the daily limit', owner: 'principal', kind: 'transaction' },
      };
    case 'monthly-cap':
      return {
        headline: `${asked} is more than this month’s allowance has left.`,
        detail: 'The account refuses it until the window rolls or the monthly limit rises.',
        action: { label: 'Raise the monthly limit', owner: 'principal', kind: 'transaction' },
      };
    case 'approval-required':
      return {
        headline: `${asked} needs the owner’s signature.`,
        detail: 'It is at or above the approval threshold, so the agent cannot settle it alone.',
        action: { label: 'Approve this payment', owner: 'principal', kind: 'transaction' },
      };
    default:
      return undefined;
  }
}

function previewDetail(reason: string | undefined): string {
  switch (reason) {
    case 'merchant-not-allowed':
      return 'The merchant is not on this mandate’s allowlist.';
    case 'capability-not-allowed':
      return 'This kind of work is not on the mandate’s list.';
    case 'merchant-proof-required':
      return 'This mandate checks merchants against a published list, so the payment has to carry proof the merchant is on it.';
    case 'merchant-proof-invalid':
      return 'The proof supplied for this merchant does not match the list the mandate holds.';
    case 'merchant-proof-unexpected':
      return 'This mandate uses a plain allowlist, so the payment must not carry a list proof.';
    default:
      return 'The mandate would refuse this payment on its permissions.';
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
