'use client';

import type { Hex } from 'viem';

import { shortAddress } from '@/chain/rhc';
import { TxHash } from '@/components/address';
import { Instant } from '@/components/instant';
import { tokenAmountText, usd } from '@/money';
import { useCapabilityLabels } from '../lib/capability-labels';
import type { MandateEvent } from '../lib/activity';
import { refusalOf } from '../lib/reading';
import { useMandateScope } from './mandate-scope';

/**
 * What the account has recorded about itself, in the order it happened.
 *
 * The events are a slice the caller picked. Whether the index answered at all belongs to the
 * source, so it is read here and never passed in: a caller that forgets to check would turn a
 * failed request into a statement about the account.
 */
export function ActivityList({ events, limit }: { readonly events: readonly MandateEvent[]; readonly limit?: number }) {
  const { ledger } = useMandateScope();
  const { labelFor } = useCapabilityLabels();
  const shown = limit === undefined ? events : events.slice(0, limit);

  if (ledger.timeline.state === 'loading') {
    return <p className="text-detail text-[color:var(--color-muted)]">Loading activity.</p>;
  }

  if (ledger.timeline.state === 'unreadable') {
    return (
      <p className="text-detail text-[color:var(--color-muted)]">
        Activity could not be loaded. Balances and limits are unaffected. Use Check again at the top of the page.
      </p>
    );
  }

  // The index answered and turned the read down. Saying it did not answer sends a reader to wait
  // out an outage that is not happening, and never reaches whoever can clear the refusal.
  if (ledger.timeline.state === 'refused') {
    const refusal = refusalOf(ledger.timeline.error);
    return (
      <p className="text-detail text-[color:var(--color-muted)]">
        {refusal === undefined
          ? 'Activity could not be loaded. Balances and limits are unaffected.'
          : `${refusal.condition} ${refusal.nextAction}`}
      </p>
    );
  }

  if (shown.length === 0) {
    return <p className="text-detail text-[color:var(--color-muted)]">No activity yet.</p>;
  }

  return (
    <ul className="space-y-3">
      {shown.map((event) => (
        <li key={`${event.transactionHash}:${event.logIndex}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="text-detail">{describe(event, labelFor)}</span>
          <span className="flex items-center gap-3 text-note text-[color:var(--color-muted)]">
            <Instant at={event.at} relative />
            <TxHash hash={event.transactionHash} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function describe(event: MandateEvent, labelFor: (id: Hex) => string | undefined): string {
  switch (event.kind) {
    case 'spent':
      return `Paid ${usd(event.amount)} to ${shortAddress(event.merchant)} for ${capability(event.capabilityId, labelFor)}`;
    case 'credited':
      return `${usd(event.amount)} returned to the budget from payment ${event.escrowId.toString()}`;
    case 'approval-granted':
      return `Approval for up to ${usd(event.amount)} to ${shortAddress(event.merchant)}`;
    case 'approval-revoked':
      return `Approval ${shortAddress(event.approvalId, 8, 6)} withdrawn`;
    case 'approval-consumed':
      return `Approval ${shortAddress(event.approvalId, 8, 6)} used on payment ${event.escrowId.toString()}`;
    case 'deposited':
      return `${usd(event.amount)} added by ${shortAddress(event.from)}`;
    case 'withdrawn':
      return `${tokenAmountText(event.amount, event.token)} taken out to ${shortAddress(event.to)}`;
    case 'bought':
      return `Bought ${tokenAmountText(event.amountOut, event.asset)} for ${usd(event.usdgIn)}`;
    case 'router-updated':
      return event.router === ZERO ? 'Stock purchases switched off' : `Stock purchases routed through ${shortAddress(event.router)}`;
    case 'park-updated':
      return event.park === ZERO ? 'Parking switched off' : `Idle funds now park at ${shortAddress(event.park)}`;
    case 'limits-updated':
      return `Limits changed, now version ${event.version.toString()}`;
    case 'paused':
      return event.paused ? 'Mandate paused' : 'Mandate resumed';
    case 'agent-seated':
      return `Agent seated: ${shortAddress(event.agent)}`;
    case 'agent-revoked':
      return `Agent revoked: ${shortAddress(event.agent)}`;
    case 'merchant-updated':
      return `${shortAddress(event.merchant)} ${event.allowed ? 'allowed as a payee' : 'removed as a payee'}`;
    case 'capability-updated':
      return `${capability(event.capabilityId, labelFor)} ${event.allowed ? 'allowed' : 'removed'}`;
    case 'gate-updated':
      return event.gate === 1 ? 'Payee list switched to a published list' : 'Payee list switched to the mandate’s own list';
    case 'document-anchored':
      return 'Mandate document saved';
    case 'owner-transfer-started':
      return `Ownership offered to ${shortAddress(event.to)}`;
    case 'owner-transferred':
      return `Ownership moved to ${shortAddress(event.to)}`;
  }
}

const ZERO = '0x0000000000000000000000000000000000000000';

function capability(id: Hex, labelFor: (id: Hex) => string | undefined): string {
  return labelFor(id) ?? shortAddress(id, 10, 6);
}
