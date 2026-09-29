import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { decodeEventLog, decodeFunctionData } from 'viem';
import type { Abi, Address, Hex } from 'viem';

import { escrowAbi, mandateAccountAbi, mandateAccountAbiV1 } from '@/chain/abi';
import type { IndexedLog, IndexedTransaction } from './explorer';

/**
 * The mandate's own record, decoded.
 *
 * Every one of these was written by the account itself. The list is what the mandate did, not what
 * a service believes it did. The escrow's side of the same story is decoded separately
 * and joined by escrow id, because a payment leaving a mandate and a provider claiming it are two
 * transactions with two owners.
 */

export type EventBase = {
  readonly at: Date;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
};

export type MandateEvent = EventBase &
  (
    | { readonly kind: 'spent'; readonly escrowId: bigint; readonly merchant: Address; readonly capabilityId: Hex; readonly amount: Micro; readonly dailySpent: Micro; readonly monthlySpent: Micro }
    | { readonly kind: 'credited'; readonly escrowId: bigint; readonly amount: Micro }
    | { readonly kind: 'approval-granted'; readonly approvalId: Hex; readonly merchant: Address; readonly amount: Micro; readonly expiry: bigint }
    | { readonly kind: 'approval-revoked'; readonly approvalId: Hex }
    | { readonly kind: 'approval-consumed'; readonly approvalId: Hex; readonly escrowId: bigint }
    | { readonly kind: 'deposited'; readonly from: Address; readonly amount: Micro }
    | { readonly kind: 'withdrawn'; readonly token: Address; readonly to: Address; readonly amount: bigint }
    | { readonly kind: 'bought'; readonly asset: Address; readonly usdgIn: Micro; readonly amountOut: bigint }
    | { readonly kind: 'router-updated'; readonly router: Address }
    | { readonly kind: 'park-updated'; readonly park: Address }
    | { readonly kind: 'limits-updated'; readonly version: bigint }
    | { readonly kind: 'paused'; readonly paused: boolean }
    | { readonly kind: 'agent-seated'; readonly agent: Address }
    | { readonly kind: 'agent-revoked'; readonly agent: Address }
    | { readonly kind: 'merchant-updated'; readonly merchant: Address; readonly allowed: boolean }
    | { readonly kind: 'capability-updated'; readonly capabilityId: Hex; readonly allowed: boolean }
    | { readonly kind: 'gate-updated'; readonly gate: number; readonly root: Hex }
    | { readonly kind: 'document-anchored'; readonly documentHash: Hex }
    | { readonly kind: 'owner-transfer-started'; readonly from: Address; readonly to: Address }
    | { readonly kind: 'owner-transferred'; readonly from: Address; readonly to: Address }
  );

/** What the escrow did with one lock, joined to the spend that opened it. */
export type LockEvents = {
  readonly locked: EventBase | undefined;
  readonly released: (EventBase & { readonly outputCommit: Hex }) | undefined;
  readonly finalized: EventBase | undefined;
  readonly timedOut: EventBase | undefined;
  readonly disputed: (EventBase & { readonly opener: Address }) | undefined;
  readonly resolved: (EventBase & { readonly refundBps: number; readonly refunded: Micro; readonly paid: Micro }) | undefined;
  readonly cancelled: EventBase | undefined;
  /** A v2 dispute that closed without a ruling put the payment back in escrow, with a new deadline. */
  readonly reopened: (EventBase & { readonly deadline: Date }) | undefined;
};

/**
 * The account's events across both builds. They share every event but `LimitsUpdated`, whose
 * struct grew three fields in v2 and so hashes to a different topic.
 */
const MANDATE_EVENTS = [
  ...mandateAccountAbi,
  ...mandateAccountAbiV1.filter((entry) => entry.type === 'event' && entry.name === 'LimitsUpdated'),
] as Abi;

export function decodeMandateEvents(logs: readonly IndexedLog[]): readonly MandateEvent[] {
  const events: MandateEvent[] = [];

  for (const log of logs) {
    const entry = decode(MANDATE_EVENTS, log);
    if (!entry) continue;
    const base: EventBase = { at: log.at, transactionHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex };
    const args = entry.args;

    switch (entry.eventName) {
      case 'Spent':
        events.push({
          ...base,
          kind: 'spent',
          escrowId: big(args.escrowId),
          merchant: address(args.merchant),
          capabilityId: hex(args.capabilityId),
          amount: amount(args.amount),
          dailySpent: amount(args.dailySpent),
          monthlySpent: amount(args.monthlySpent),
        });
        break;
      case 'SpendCredited':
        events.push({ ...base, kind: 'credited', escrowId: big(args.escrowId), amount: amount(args.amount) });
        break;
      case 'SpendApproved':
        events.push({
          ...base,
          kind: 'approval-granted',
          approvalId: hex(args.approvalId),
          merchant: address(args.merchant),
          amount: amount(args.amount),
          expiry: big(args.expiry),
        });
        break;
      case 'ApprovalRevoked':
        events.push({ ...base, kind: 'approval-revoked', approvalId: hex(args.approvalId) });
        break;
      case 'ApprovalConsumed':
        events.push({ ...base, kind: 'approval-consumed', approvalId: hex(args.approvalId), escrowId: big(args.escrowId) });
        break;
      case 'Deposited':
        events.push({ ...base, kind: 'deposited', from: address(args.from), amount: amount(args.amount) });
        break;
      case 'Withdrawn':
        events.push({ ...base, kind: 'withdrawn', token: address(args.token), to: address(args.to), amount: big(args.amount) });
        break;
      case 'Bought':
        events.push({ ...base, kind: 'bought', asset: address(args.asset), usdgIn: amount(args.usdgIn), amountOut: big(args.amountOut) });
        break;
      case 'RouterUpdated':
        events.push({ ...base, kind: 'router-updated', router: address(args.router) });
        break;
      case 'TreasuryParkUpdated':
        events.push({ ...base, kind: 'park-updated', park: address(args.treasuryPark) });
        break;
      case 'LimitsUpdated':
        events.push({ ...base, kind: 'limits-updated', version: big(args.version) });
        break;
      case 'PausedUpdated':
        events.push({ ...base, kind: 'paused', paused: args.paused === true });
        break;
      case 'AgentUpdated':
        events.push({ ...base, kind: 'agent-seated', agent: address(args.agent) });
        break;
      case 'AgentRevoked':
        events.push({ ...base, kind: 'agent-revoked', agent: address(args.agent) });
        break;
      case 'MerchantUpdated':
        events.push({ ...base, kind: 'merchant-updated', merchant: address(args.merchant), allowed: args.allowed === true });
        break;
      case 'CapabilityUpdated':
        events.push({ ...base, kind: 'capability-updated', capabilityId: hex(args.capabilityId), allowed: args.allowed === true });
        break;
      case 'MerchantGateUpdated':
        events.push({ ...base, kind: 'gate-updated', gate: Number(big(args.gate)), root: hex(args.merchantRoot) });
        break;
      case 'DocumentHashUpdated':
        events.push({ ...base, kind: 'document-anchored', documentHash: hex(args.documentHash) });
        break;
      case 'PrincipalTransferStarted':
        events.push({ ...base, kind: 'owner-transfer-started', from: address(args.from), to: address(args.to) });
        break;
      case 'PrincipalTransferred':
        events.push({ ...base, kind: 'owner-transferred', from: address(args.from), to: address(args.to) });
        break;
      default:
        break;
    }
  }

  return events.sort(newestFirst);
}

/**
 * The capability behind each registered approval.
 *
 * The account hashes the whole approval and emits the payee, the ceiling and the expiry, so the
 * capability is nowhere in the log and nowhere in the mapping. It is in the calldata of the
 * transaction that granted it, which is the only place any reader can get it back, and it is the
 * difference between a table that names `doc.summarize:1` and one that says the consent is holding
 * something it will not show.
 *
 * A grant sent through a Safe or any other contract wallet arrives as that wallet's own call and
 * decodes to nothing here. Those rows keep saying the capability is held in the approval, which is
 * true of them.
 */
export function approvedCapabilities(transactions: readonly IndexedTransaction[]): ReadonlyMap<string, Hex> {
  const byApproval = new Map<string, Hex>();

  for (const transaction of transactions) {
    if (transaction.failed || transaction.input.length < 10) continue;

    let decoded: { functionName: string; args?: readonly unknown[] };
    try {
      // approveSpend has the same selector on both builds.
      decoded = decodeFunctionData({ abi: mandateAccountAbi, data: transaction.input });
    } catch {
      continue;
    }

    if (decoded.functionName !== 'approveSpend') continue;
    const approval = decoded.args?.[0] as { approvalId?: unknown; capabilityId?: unknown } | undefined;
    if (typeof approval?.approvalId !== 'string' || typeof approval.capabilityId !== 'string') continue;

    byApproval.set(approval.approvalId.toLowerCase(), approval.capabilityId as Hex);
  }

  return byApproval;
}

/**
 * The escrow's log, indexed by lock id.
 *
 * The escrow serves every mandate on this deployment, so this reads its whole record once and the
 * caller looks up only the ids on the screen. One request for the section beats one request per
 * row, which is the shape that meets a rate meter.
 */
export function decodeLockEvents(logs: readonly IndexedLog[]): ReadonlyMap<string, LockEvents> {
  const byId = new Map<string, Mutable<LockEvents>>();

  const slot = (id: bigint): Mutable<LockEvents> => {
    const key = id.toString();
    const existing = byId.get(key);
    if (existing) return existing;
    const fresh: Mutable<LockEvents> = {
      locked: undefined,
      released: undefined,
      finalized: undefined,
      timedOut: undefined,
      disputed: undefined,
      resolved: undefined,
      cancelled: undefined,
      reopened: undefined,
    };
    byId.set(key, fresh);
    return fresh;
  };

  for (const log of logs) {
    const entry = decode(escrowAbi as Abi, log);
    if (!entry) continue;
    const args = entry.args;
    if (args.id === undefined) continue;
    const base: EventBase = { at: log.at, transactionHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex };
    const record = slot(big(args.id));

    switch (entry.eventName) {
      case 'Locked':
        record.locked = base;
        break;
      case 'Released':
        record.released = { ...base, outputCommit: hex(args.outputCommit) };
        break;
      case 'ReleaseFinalized':
        record.finalized = base;
        break;
      case 'TimedOut':
        record.timedOut = base;
        break;
      case 'Disputed':
        record.disputed = { ...base, opener: address(args.opener) };
        break;
      case 'Resolved':
        record.resolved = { ...base, refundBps: Number(big(args.refundBps)), refunded: amount(args.refunded), paid: amount(args.paid) };
        break;
      case 'Cancelled':
        record.cancelled = base;
        break;
      case 'DisputeReopened':
        record.reopened = { ...base, deadline: new Date(Number(big(args.deadline)) * 1000) };
        break;
      default:
        break;
    }
  }

  return byId;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * A log this build cannot decode is skipped. The index returns everything an address emitted,
 * including events from a contract version this app predates, and one unreadable entry must not
 * empty the whole history.
 */
function decode(abi: Abi, log: IndexedLog): { eventName: string; args: Record<string, unknown> } | undefined {
  if (log.topics.length === 0) return undefined;
  try {
    // A plain `Abi` gives viem nothing to narrow against, so the decoded shape comes back untyped.
    // The switch below is what names the fields, and every read of them is guarded.
    const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as unknown as {
      eventName: string;
      args?: Record<string, unknown>;
    };
    return { eventName: decoded.eventName, args: decoded.args ?? {} };
  } catch {
    return undefined;
  }
}

function newestFirst(a: EventBase, b: EventBase): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1;
  return b.logIndex - a.logIndex;
}

function big(value: unknown): bigint {
  return typeof value === 'bigint' ? value : BigInt((value as string | number | undefined) ?? 0);
}

function amount(value: unknown): Micro {
  return micro(big(value));
}

function address(value: unknown): Address {
  return (typeof value === 'string' ? value : '0x0000000000000000000000000000000000000000') as Address;
}

function hex(value: unknown): Hex {
  return (typeof value === 'string' ? value : '0x') as Hex;
}
