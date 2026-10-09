import { LockStatus } from '@bursar/sdk';

import { shortAddress } from '@/chain';
import { formatInstant, formatRelative, spellDuration } from '@/lib';
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
  'paid-unrecorded': 'Paid, not yet recorded',
  'paid-recorded': 'Paid and recorded',
  contested: 'Contested',
  ruled: 'Settled by a ruling',
  'dispute-closed': 'Closed without a ruling',
  'dispute-unread': 'Settled by a dispute, result not read',
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

const UNSCORED = 'A job this small does not count toward the record.';

/** What this lock means for the payee, and what happens next if nobody touches it. */
export function stageDetail(lock: ProviderLock, now: Date, voice: Voice = 'payee'): string {
  const mine = voice === 'payee';

  switch (lock.stage) {
    case 'awaiting-delivery':
      return mine
        ? `You receive ${usd(lock.net)} when you release it. After ${formatInstant(lock.deadline)} (${formatRelative(lock.deadline, now)}) it can go back to the payer.`
        : `${usd(lock.net)} is held for this address until the job is released. After ${formatInstant(lock.deadline)} (${formatRelative(lock.deadline, now)}) it can go back to the payer.`;

    case 'deadline-passed':
      if (lock.scored === false) {
        return `The deadline passed ${formatRelative(lock.deadline, now)}. Anyone can now return the money to the payer. ${UNSCORED}`;
      }
      return mine
        ? `The deadline passed ${formatRelative(lock.deadline, now)}. Anyone can now return the money to the payer, and the job will count against your record.`
        : `The deadline passed ${formatRelative(lock.deadline, now)}. Anyone can now return the money to the payer, and the job will count against this address's record.`;

    case 'paid-open-to-dispute':
      if (lock.recordableAt === null) return 'Paid. The payer can still contest it.';
      if (lock.scored === false) return `Paid. The payer can contest it until ${formatInstant(lock.recordableAt)}.`;
      return mine
        ? `Paid. The payer can contest it until ${formatInstant(lock.recordableAt)}, then it can be recorded.`
        : `Paid. The payer can contest it until ${formatInstant(lock.recordableAt)}, then it can be recorded.`;

    case 'paid-unrecorded':
      if (lock.scored === false) return `Paid ${formatRelative(lock.releasedAt ?? lock.deadline, now)} and not contested. ${UNSCORED}`;
      return mine
        ? `Paid ${formatRelative(lock.releasedAt ?? lock.deadline, now)} and not contested. Record it to count it toward your job ceiling.`
        : `Paid ${formatRelative(lock.releasedAt ?? lock.deadline, now)} and not contested. It counts toward this address's ceiling once it is recorded.`;

    case 'paid-recorded':
      return mine
        ? `Paid and recorded${lock.releasedAt ? ` on ${formatInstant(lock.releasedAt)}` : ''}.`
        : `Paid and recorded${lock.releasedAt ? ` on ${formatInstant(lock.releasedAt)}` : ''}.`;

    case 'contested':
      return contestedDetail(lock, now, mine);

    case 'ruled':
      return ruledDetail(lock, mine);

    case 'dispute-closed':
      return closedDetail(lock, mine);

    case 'dispute-unread':
      return mine
        ? 'Settled through a dispute. The result could not be read right now.'
        : 'Settled through a dispute. The result could not be read right now.';

    case 'returned-to-payer':
      if (lock.scored === false) return `The deadline passed on ${formatInstant(lock.deadline)} and the money went back to the payer. ${UNSCORED}`;
      return mine
        ? `The deadline passed on ${formatInstant(lock.deadline)} and the money went back to the payer. It counts against your record.`
        : `The deadline passed on ${formatInstant(lock.deadline)} and the money went back to the payer. It counts against this address's record.`;

    case 'declined':
      return mine
        ? 'You returned this before the deadline. Declining early does not affect your record.'
        : 'Returned before the deadline. Declining early does not affect the record.';
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
      ? 'Resolvers ruled on this job.'
      : `Resolvers ruled on this job with a median score of ${dispute.medianScore}, returning ${refund} of it to the payer.`;

  if (lock.payout.kind === 'paid') {
    return `${opening} ${usdExact(lock.payout.amount)} reached ${you} after the settlement fee.`;
  }
  if (lock.payout.kind === 'none') {
    return `${opening} Nothing reached ${you}.`;
  }
  return `${opening} What reached ${you} could not be read right now.`;
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
    return `The resolvers' scores were too far apart to rule on, so the dispute closed without a ruling. The payer got the full amount back and no resolver fee was taken. Nothing reached ${you}, and the job counts as disputed.`;
  }

  if (dispute !== undefined && dispute.status === DISPUTE_FAILED) {
    const quorum =
      dispute.revealCount === 0
        ? 'No resolver published a score'
        : `${dispute.revealCount} of ${dispute.commitCount} sealed ${dispute.commitCount === 1 ? 'score was' : 'scores were'} published`;
    return `Too few resolvers published a score, so the dispute closed without a ruling. ${quorum}. The payer got the amount back less the resolver fee. Nothing reached ${you}, and the job counts as disputed.`;
  }

  return `The dispute closed without a ruling and the payer got the amount back with no fee taken. Nothing reached ${you}, and the job counts as disputed.`;
}

/** `IOracleRegistry.DisputeStatus.Failed`. */
const DISPUTE_FAILED = 4;

function contestedDetail(lock: ProviderLock, now: Date, mine: boolean): string {
  const byWhom = lock.disputer.toLowerCase() === lock.payer.toLowerCase() ? 'The payer' : shortAddress(lock.disputer);

  if (lock.releasedAt !== null && lock.status === LockStatus.Disputed) {
    return mine
      ? `${byWhom} contested this after it was paid. You keep the money, and the job counts as contested on your record.`
      : `${byWhom} contested this after it was paid. The payee keeps the money, and the job counts as contested.`;
  }

  const dispute = lock.dispute;
  if (!dispute) {
    return `${byWhom} contested this job. The money is held until resolvers rule on it.`;
  }

  const voting =
    dispute.revealEndsAt === null
      ? 'Resolvers are ruling on it.'
      : `Resolvers seal their scores, then reveal them. The reveal closes ${formatRelative(dispute.revealEndsAt, now)}: ${dispute.commitCount} sealed and ${dispute.revealCount} revealed so far.`;

  // From then one of the registry's two exits is always open, to anyone, so nothing holds the lock.
  const settles =
    lock.deployment.contractSet === 'v1'
      ? ' After the reveal anyone can settle it.'
      : ` After the reveal anyone can settle it. A ruling splits the amount, and if too few resolvers reveal, the payment goes back on hold for ${mine ? 'you' : 'the payee'} with a new deadline.`;

  return `${byWhom} contested this job, so the money is held. ${voting}${settles}`;
}

/** The delivery window a payer may choose, in words. */
export function ttlRange(terms: EscrowTerms): string | undefined {
  if (terms.minTtl === undefined || terms.maxTtl === undefined) return undefined;
  return `${spellDuration(Number(terms.minTtl))} to ${spellDuration(Number(terms.maxTtl))}`;
}
