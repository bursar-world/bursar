import type { Micro } from '@bursar/core';

import type { EscrowTerms, MerchantStanding } from './chain.js';
import { RefuseReason } from './decision.js';

/**
 * The deadline window a lock has to land inside. The escrow rejects `deadline <= now + minTtl`
 * and `deadline >= now + maxTtl`, so both ends are exclusive there and inclusive here.
 *
 * `previewSpend` cannot report a bad TTL: the bounds live on the escrow, not on the account.
 * This is that gap closed, which is why a quote carries the window.
 */
export type DeadlineBounds = {
  readonly nowSeconds: bigint;
  readonly minTtlSeconds: bigint;
  readonly maxTtlSeconds: bigint;
  readonly earliest: bigint;
  readonly latest: bigint;
  readonly driftSeconds: bigint;
};

/**
 * `driftSeconds` raises the lower bound only. The escrow evaluates the window against the
 * timestamp of the block the lock lands in, and a later block pushes the lower bound up while
 * pushing the upper bound away, so a deadline quoted tight against `earliest` is the one that
 * goes stale in transit.
 */
export function deadlineBounds(nowSeconds: bigint, terms: EscrowTerms, driftSeconds = 0n): DeadlineBounds {
  return {
    nowSeconds,
    minTtlSeconds: terms.minTtlSeconds,
    maxTtlSeconds: terms.maxTtlSeconds,
    earliest: nowSeconds + driftSeconds + terms.minTtlSeconds + 1n,
    latest: nowSeconds + terms.maxTtlSeconds - 1n,
    driftSeconds,
  };
}

export function checkDeadline(deadline: bigint, bounds: DeadlineBounds): RefuseReason | null {
  if (deadline < bounds.earliest) return RefuseReason.TtlTooShort;
  if (deadline > bounds.latest) return RefuseReason.TtlTooLong;
  return null;
}

export type EscrowPreflightInput = {
  readonly amountMicros: Micro;
  readonly balanceMicros: Micro;
  readonly standing: MerchantStanding;
  readonly bounds: DeadlineBounds;
  readonly deadline?: bigint;
};

/**
 * Everything `Escrow.lock` checks that the account cannot see, in the order the escrow checks
 * it. A spend that clears `previewSpend` and fails here would have reverted after the agent had
 * already paid for the gas.
 *
 * Every test is against our own contracts: the merchant's standing comes from the AgentRegistry
 * the escrow names, and the balance from the settlement asset.
 *
 * What is not checked here is the token's own view of the parties, and USDG has one. `paused()`
 * stops every transfer at once and `isFrozen(address)` stops one party's, both answered on chain
 * 4663 and neither ours to clear. A spend can therefore clear everything below and still revert
 * inside `lock` when USDG refuses the pull. That is read on the decision path, in `asset.ts`,
 * before this preflight runs and whether or not the deployment simulates. A clean result here
 * still means the terms on our side of the escrow are satisfied, and nothing more than that.
 *
 * The balance test is last because it is the only one that is not a policy: the account has not
 * been funded for this payment. It is still a refusal, since the escrow pulls the exact
 * amount inside `lock` and a short balance reverts the whole thing.
 */
export function escrowPreflight(input: EscrowPreflightInput): RefuseReason | null {
  if (input.deadline !== undefined) {
    const ttl = checkDeadline(input.deadline, input.bounds);
    if (ttl !== null) return ttl;
  }

  if (input.standing.blacklisted) return RefuseReason.MerchantBlacklisted;
  if (!input.standing.active) return RefuseReason.MerchantInactive;
  if (input.amountMicros > input.standing.capMicros) return RefuseReason.PayeeCapExceeded;
  if (input.amountMicros > input.balanceMicros) return RefuseReason.AccountUnderfunded;

  return null;
}
