import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { LockStatus } from '@bursar/sdk';
import type { Address, Hex } from 'viem';

import { ADDRESSES } from '@/chain/rhc';
import { escrowAbi, mandateAccountAbi, settlementAssetAbi } from '@/chain/abi';
import { ReadBatch, addChainTime, runBatch } from '@/chain/batch';
import type { Slot } from '@/chain/batch';
import { rhcClient } from '@/chain/client';

/**
 * Everything the detail surfaces need that `readSystem` does not already cover, in one request.
 *
 * The gates are mappings, so they cannot be enumerated from the chain: the candidate addresses and
 * capability ids come from the account's own log and their current truth is read back here. That
 * matters, because a merchant that was allowed and then removed still appears in the log and only
 * the mapping says which it is now.
 */

export type LockRecord = {
  readonly id: bigint;
  readonly payer: Address;
  readonly payee: Address;
  readonly disputer: Address;
  readonly capabilityId: Hex;
  readonly inputURI: string;
  readonly outputURI: string;
  readonly amount: Micro;
  readonly deadline: Date;
  readonly releasedAt: Date | null;
  readonly bond: Micro;
  readonly disputedAt: Date | null;
  readonly status: LockStatus;
  /** The release has been written into the payee's settlement history, which raises their cap. */
  readonly counted: boolean;
};

export type GateEntry<Key> = { readonly key: Key; readonly allowed: boolean | undefined };

/**
 * Whether the account already allows this payee or this capability.
 *
 * Writing a gate into the state it is already in changes nothing and still costs the fee, so the
 * forms that add one check first. Only a chain reading of `true` counts: an entry nobody managed
 * to read is not an entry that is allowed, and refusing the write on an unread row would be a
 * permission claim built on a network fault.
 */
export function alreadyAllowed(entries: readonly GateEntry<string>[], key: string | undefined): boolean {
  if (key === undefined) return false;
  return entries.some((entry) => entry.key.toLowerCase() === key.toLowerCase() && entry.allowed === true);
}

export type ApprovalState = {
  readonly approvalId: Hex;
  readonly registered: boolean | undefined;
  readonly spent: boolean | undefined;
};

export type LedgerState = {
  readonly locks: ReadonlyMap<string, LockRecord>;
  readonly merchants: readonly GateEntry<Address>[];
  readonly capabilities: readonly GateEntry<Hex>[];
  readonly approvals: readonly ApprovalState[];
  /** What the owner has allowed the account to pull from their own wallet, for a deposit. */
  readonly allowance: Micro | undefined;
  /** The owner's own settlement-asset balance, which is where a deposit comes from. */
  readonly ownerBalance: Micro | undefined;
  /**
   * The account's own EIP-712 domain separator. A guessed domain does not fail loudly: it produces
   * a well-formed signature that recovers to nobody, and the only symptom is a refusal that blames
   * the signature. This is read so consent can be checked against the account before it is signed.
   */
  readonly domainSeparator: Hex | undefined;
  /**
   * The chain's own clock, from the same block as the locks beside it.
   *
   * A deadline is compared against `block.timestamp` and nothing else. The browser's clock is a
   * different clock, and a screen that offers to return a payment because the reader's laptop
   * says the deadline has passed sends them to a wallet prompt the escrow answers with `TooEarly`.
   */
  readonly chainTime: Date | undefined;
  readonly readAt: Date;
  readonly calls: number;
  readonly failures: number;
};

export type LedgerScope = {
  readonly mandate: Address;
  /** The escrow the mandate settles through. A v1 mandate's locks are in the v1 escrow. */
  readonly escrow?: Address;
  readonly owner?: Address;
  readonly lockIds: readonly bigint[];
  readonly merchants: readonly Address[];
  readonly capabilities: readonly Hex[];
  readonly approvals: readonly Hex[];
};

type RawLock = {
  payer: Address;
  payee: Address;
  disputer: Address;
  capabilityId: Hex;
  inputCommit: Hex;
  outputCommit: Hex;
  inputURI: string;
  outputURI: string;
  amount: bigint;
  deadline: bigint;
  releasedAt: bigint;
  bond: bigint;
  disputedAt: bigint;
  status: number;
  counted: boolean;
};

export async function readLedgerState(scope: LedgerScope): Promise<LedgerState> {
  const batch = new ReadBatch();

  const lockSlots = scope.lockIds.map((id) => ({
    id,
    slot: batch.add<RawLock>(`escrow.getLock:${id}`, {
      address: scope.escrow ?? ADDRESSES.escrow,
      abi: escrowAbi as never,
      functionName: 'getLock',
      args: [id],
    }),
  }));

  const merchantSlots = scope.merchants.map((merchant) => ({
    key: merchant,
    slot: batch.add<boolean>(`mandate.merchants:${merchant}`, {
      address: scope.mandate,
      abi: mandateAccountAbi as never,
      functionName: 'merchants',
      args: [merchant],
    }),
  }));

  const capabilitySlots = scope.capabilities.map((capabilityId) => ({
    key: capabilityId,
    slot: batch.add<boolean>(`mandate.capabilities:${capabilityId}`, {
      address: scope.mandate,
      abi: mandateAccountAbi as never,
      functionName: 'capabilities',
      args: [capabilityId],
    }),
  }));

  const approvalSlots = scope.approvals.map((approvalId) => ({
    key: approvalId,
    slot: batch.add<readonly [boolean, boolean]>(`mandate.approvals:${approvalId}`, {
      address: scope.mandate,
      abi: mandateAccountAbi as never,
      functionName: 'approvals',
      args: [approvalId],
    }),
  }));

  const allowanceSlot: Slot<bigint> | undefined = scope.owner
    ? batch.add<bigint>('usdg.allowance', {
        address: ADDRESSES.usdg,
        abi: settlementAssetAbi as never,
        functionName: 'allowance',
        args: [scope.owner, scope.mandate],
      })
    : undefined;

  const ownerBalanceSlot: Slot<bigint> | undefined = scope.owner
    ? batch.add<bigint>('usdg.balanceOf:owner', {
        address: ADDRESSES.usdg,
        abi: settlementAssetAbi as never,
        functionName: 'balanceOf',
        args: [scope.owner],
      })
    : undefined;

  const domainSlot = batch.add<Hex>('mandate.DOMAIN_SEPARATOR', {
    address: scope.mandate,
    abi: mandateAccountAbi as never,
    functionName: 'DOMAIN_SEPARATOR',
  });

  const chainTimeSlot = addChainTime(batch);

  const results = await runBatch(rhcClient(), batch);
  const chainSeconds = results.get(chainTimeSlot);

  const locks = new Map<string, LockRecord>();
  for (const entry of lockSlots) {
    const raw = results.get(entry.slot);
    if (!raw) continue;
    locks.set(entry.id.toString(), toLock(entry.id, raw));
  }

  return {
    locks,
    merchants: merchantSlots.map((entry) => ({ key: entry.key, allowed: results.get(entry.slot) })),
    capabilities: capabilitySlots.map((entry) => ({ key: entry.key, allowed: results.get(entry.slot) })),
    approvals: approvalSlots.map((entry) => {
      const raw = results.get(entry.slot);
      return { approvalId: entry.key, registered: raw?.[0], spent: raw?.[1] };
    }),
    allowance: allowanceSlot === undefined ? undefined : toMicroOrUndefined(results.get(allowanceSlot)),
    ownerBalance: ownerBalanceSlot === undefined ? undefined : toMicroOrUndefined(results.get(ownerBalanceSlot)),
    domainSeparator: results.get(domainSlot),
    chainTime: chainSeconds === undefined ? undefined : new Date(Number(chainSeconds) * 1000),
    readAt: new Date(),
    calls: batch.size,
    failures: results.failures,
  };
}

function toLock(id: bigint, raw: RawLock): LockRecord {
  return {
    id,
    payer: raw.payer,
    payee: raw.payee,
    disputer: raw.disputer,
    capabilityId: raw.capabilityId,
    inputURI: raw.inputURI,
    outputURI: raw.outputURI,
    amount: micro(raw.amount),
    deadline: new Date(Number(raw.deadline) * 1000),
    releasedAt: raw.releasedAt === 0n ? null : new Date(Number(raw.releasedAt) * 1000),
    bond: micro(raw.bond),
    disputedAt: raw.disputedAt === 0n ? null : new Date(Number(raw.disputedAt) * 1000),
    // A status outside the set the escrow defines means this build is behind the deployment. The
    // correct reading is "unknown", and the surfaces render it that way. Throwing here would take
    // the other rows down with it.
    status: (isKnownStatus(raw.status) ? raw.status : LockStatus.None) as LockStatus,
    counted: raw.counted,
  };
}

const KNOWN_STATUSES: ReadonlySet<number> = new Set(Object.values(LockStatus));

function isKnownStatus(value: number): boolean {
  return KNOWN_STATUSES.has(value);
}

function toMicroOrUndefined(value: bigint | undefined): Micro | undefined {
  return value === undefined ? undefined : micro(value);
}
