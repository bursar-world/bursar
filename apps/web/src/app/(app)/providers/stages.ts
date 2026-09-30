import { LockStatus } from '@bursar/sdk';

import { shortAddress } from '@/chain';
import { formatDuration, formatInstant, formatRelative } from '@/lib';
import { usd, usdExact } from '@/money';
import type { StateLevel } from '@/state';

import type { EscrowTerms, LockStage, ProviderLock } from './desk';

/**
 * Who the desk is being read by.
 *
 * The same lock is two different sentences depending on the reader. To the payee it is work owed
 * and money coming; to anyone else it is a record of how this address has settled, which is what a
 * payer weighs before naming it. Writing one set and hoping it covers both produces copy that
 * tells a stranger to deliver work they were never hired for.
 */
export type Voice = 'payee' | 'public';

const STAGE_LABEL: Record<LockStage, string> = {
  'awaiting-delivery': 'Waiting on delivery',
  'deadline-passed': 'Deadline passed',
  'paid-open-to-dispute': 'Paid, still contestable',
  'paid-unrecorded': 'Paid, outside the record',
  'paid-recorded': 'Paid and recorded',
  contested: 'Contested',
  ruled: 'Settled by a ruling',
  'dispute-closed': 'Closed without a ruling',
  'dispute-unread': 'Settled by a dispute, outcome not read',
  'returned-to-payer': 'Returned to the payer',
  declined: 'Returned early',
};

const STAGE_LEVEL: Record<LockStage, StateLevel> = {
  'awaiting-delivery': 'attention',
  'deadline-passed': 'blocked',
  'paid-open-to-dispute': 'ok',
  'paid-unrecorded': 'attention',
  'paid-recorded': 'ok',
  contested: 'blocked',
  ruled: 'attention',
  'dispute-closed': 'blocked',
  'dispute-unread': 'unknown',
  'returned-to-payer': 'blocked',
  declined: 'ok',
};

export function stageLabel(stage: LockStage): string {
  return STAGE_LABEL[stage];
}

export function stageLevel(stage: LockStage): StateLevel {
  return STAGE_LEVEL[stage];
}

/** What this lock means for the payee, and what happens next if nobody touches it. */
export function stageDetail(lock: ProviderLock, now: Date, voice: Voice = 'payee'): string {
  const mine = voice === 'payee';

  switch (lock.stage) {
    case 'awaiting-delivery':
      return mine
        ? `${usd(lock.net)} reaches you when you release it. The payer takes the money back after ${formatInstant(lock.deadline)}, ${formatRelative(lock.deadline, now)}.`
        : `${usd(lock.net)} is held for this address until the job is released. The payer takes it back after ${formatInstant(lock.deadline)}, ${formatRelative(lock.deadline, now)}.`;

    case 'deadline-passed':
      return mine
        ? `The deadline ran out ${formatRelative(lock.deadline, now)}. Anyone can return the money to the payer now, and the escrow counts the job against you when they do.`
        : `The deadline ran out ${formatRelative(lock.deadline, now)}. Anyone can return the money to the payer now, and the escrow counts the job against this address when they do.`;

    case 'paid-open-to-dispute':
      if (lock.recordableAt === null) return 'Paid. The payer can still contest it.';
      return mine
        ? `Paid. The payer can contest it until ${formatInstant(lock.recordableAt)}. After that the job can go into your record.`
        : `Paid. The payer can contest it until ${formatInstant(lock.recordableAt)}. After that the job can go into this address's record.`;

    case 'paid-unrecorded':
      return mine
        ? `Paid ${formatRelative(lock.releasedAt ?? lock.deadline, now)} and never contested. Nothing has written it into your record, so it is not counting towards your ceiling.`
        : `Paid ${formatRelative(lock.releasedAt ?? lock.deadline, now)} and never contested. Nothing has written it into the record, so it is not counting towards this address's ceiling.`;

    case 'paid-recorded':
      return mine
        ? `Paid and counted towards your record${lock.releasedAt ? ` on ${formatInstant(lock.releasedAt)}` : ''}.`
        : `Paid and counted towards the record${lock.releasedAt ? ` on ${formatInstant(lock.releasedAt)}` : ''}.`;

    case 'contested':
      return contestedDetail(lock, now, mine);

    case 'ruled':
      return ruledDetail(lock, mine);

    case 'dispute-closed':
      return closedDetail(lock, mine);

    case 'dispute-unread':
      return mine
        ? 'This lock left the escrow through a dispute. How that dispute ended did not come back in this reading, so what reached you is unknown rather than nothing.'
        : 'This lock left the escrow through a dispute. How that dispute ended did not come back in this reading, so what reached the payee is unknown rather than nothing.';

    case 'returned-to-payer':
      return mine
        ? `The deadline passed on ${formatInstant(lock.deadline)} and the money went back to the payer. It counts against your record.`
        : `The deadline passed on ${formatInstant(lock.deadline)} and the money went back to the payer. It counts against this address's record.`;

    case 'declined':
      return mine
        ? 'You returned this one before the deadline. Declining early costs your record nothing.'
        : 'Returned before the deadline. Declining early costs the record nothing.';
  }
}

/**
 * A dispute a panel ruled on.
 *
 * The desk used to print "a resolver split this lock, your share was paid at the ruling" from the
 * status alone, on locks where no panel ever reached a quorum and the payee was paid nothing. The
 * median, the refund and what reached the payee are all on the dispute record, so the desk reads all
 * three from it.
 */
function ruledDetail(lock: ProviderLock, mine: boolean): string {
  const dispute = lock.dispute;
  const refund = dispute === undefined ? undefined : `${(dispute.refundBps / 100).toFixed(dispute.refundBps % 100 === 0 ? 0 : 2)}%`;
  const you = mine ? 'you' : 'the payee';

  const opening =
    dispute === undefined
      ? 'A resolver panel ruled on this lock.'
      : `A resolver panel ruled on this lock at a median score of ${dispute.medianScore}, which sent ${refund} of it back to the payer.`;

  if (lock.payout.kind === 'paid') {
    return `${opening} ${usdExact(lock.payout.amount)} reached ${you}, after the settlement fee.`;
  }
  if (lock.payout.kind === 'none') {
    return `${opening} Nothing reached ${you}.`;
  }
  return `${opening} What reached ${you} could not be worked out from this reading.`;
}

/**
 * A dispute that ended without a usable median, which leaves the payee with nothing and is never a
 * ruling.
 *
 * On the contracts from v2 on that is a vote whose scores had no centre, which refunds the payer
 * in full and takes no resolver fee. A vote that missed its quorum puts the lock back on hold
 * instead and never lands here. The first contracts refunded a missed quorum less the resolver fee,
 * and could also close a dispute nobody ruled on from the escrow's side.
 */
function closedDetail(lock: ProviderLock, mine: boolean): string {
  const dispute = lock.dispute;
  const you = mine ? 'you' : 'the payee';

  if (dispute !== undefined && dispute.status === DISPUTE_FAILED && lock.deployment.contractSet !== 'v1') {
    return `Most of the scores the resolvers revealed sat far from the middle, so the vote had nothing to rule by. The dispute closed without a ruling and the escrow returned the whole lock to the payer, with no resolver fee taken. Nothing reached ${you}, and the job counts as disputed on the record.`;
  }

  if (dispute !== undefined && dispute.status === DISPUTE_FAILED) {
    const quorum =
      dispute.revealCount === 0
        ? 'No resolver ever published a score'
        : `${dispute.revealCount} of ${dispute.commitCount} sealed ${dispute.commitCount === 1 ? 'score was' : 'scores were'} published`;
    return `The panel never reached a result, so the dispute was closed without a ruling. ${quorum}, which leaves no median to split the lock by, and the escrow sends the whole lock back to the payer less its resolver fee. Nothing reached ${you}, and the job counts as disputed on the record.`;
  }

  return `No ruling ever landed on this dispute, and the earlier contracts holding it returned the lock to the payer without one. Nothing reached ${you}, no fee was taken from it, and the job counts as disputed on the record.`;
}

/** `IOracleRegistry.DisputeStatus.Failed`. */
const DISPUTE_FAILED = 4;

function contestedDetail(lock: ProviderLock, now: Date, mine: boolean): string {
  const byWhom = lock.disputer.toLowerCase() === lock.payer.toLowerCase() ? 'The payer' : shortAddress(lock.disputer);

  if (lock.releasedAt !== null && lock.status === LockStatus.Disputed) {
    return mine
      ? `${byWhom} contested this after it was paid. The money stayed with you, and your record counts the job as contested. It does not count as delivered.`
      : `${byWhom} contested this after it was paid. The money stayed with the payee, and the record counts the job as contested. It does not count as delivered.`;
  }

  const dispute = lock.dispute;
  if (!dispute) {
    return `${byWhom} contested this lock. The money is frozen until a resolver rules on it.`;
  }

  const voting =
    dispute.revealEndsAt === null
      ? 'A resolver panel is ruling on it.'
      : `Resolvers vote in two passes: sealed scores first, then the reveal, which closes ${formatRelative(dispute.revealEndsAt, now)}. ${dispute.commitCount} sealed so far, ${dispute.revealCount} revealed.`;

  // From then one of the registry's two exits is always open, to anyone, so nothing holds the lock.
  const settles =
    lock.deployment.contractSet === 'v1'
      ? ' Once the reveal closes anyone can settle it.'
      : ` Once the reveal closes anyone can settle it: a ruling splits the lock, and if too few resolvers reveal, it goes back on hold for ${mine ? 'you' : 'the payee'} with a new deadline.`;

  return `${byWhom} contested this lock, so the money is frozen. ${voting}${settles}`;
}

/** The delivery window a payer may choose, in words. */
export function ttlRange(terms: EscrowTerms): string | undefined {
  if (terms.minTtl === undefined || terms.maxTtl === undefined) return undefined;
  return `${formatDuration(Number(terms.minTtl))} to ${formatDuration(Number(terms.maxTtl))}`;
}
