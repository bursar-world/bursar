import { toFunctionSelector } from 'viem';
import type { Address, Hex } from 'viem';

import { ADDRESSES, ReadBatch, addBlockNumber, addChainTime, adminTimelockAbi, rhcClient, runBatch } from '@/chain';
import { PAUSABLE, governedByKey } from '@/chain/admin-actions';
import type { GovernedKey } from '@/chain/admin-actions';

export type ProposalStatus =
  | 'awaiting-approvals'
  | 'waiting-out-the-delay'
  | 'executable'
  | 'executed'
  | 'cancelled'
  | 'expired'
  /** The timelock did not answer enough of this proposal to say where it stands. */
  | 'not-read';

export type Proposal = {
  readonly id: number;
  readonly target: Address;
  readonly data: Hex;
  readonly createdAt: Date;
  readonly executeAfter: Date;
  readonly expiresAt: Date | undefined;
  readonly executed: boolean;
  readonly cancelled: boolean;
  readonly approvals: number | undefined;
  readonly approvedBy: readonly Address[] | undefined;
  readonly status: ProposalStatus;
  /** What the contract says `execute` would refuse with right now, named in English. */
  readonly refusal: string | undefined;
};

/**
 * One contract the brake reaches, and whether the brake reaches it.
 *
 * `admin` is here because the guardian pauses through the timelock and the timelock's `pause()`
 * call is `onlyAdmin` on the target. A contract the timelock does not administer yet is one the
 * guardian cannot stop, whatever the page offers.
 */
export type BrakeTarget = {
  readonly key: GovernedKey;
  readonly name: string;
  readonly address: Address;
  readonly paused: boolean | undefined;
  readonly admin: Address | undefined;
  readonly pendingAdmin: Address | undefined;
};

export type Governance = {
  readonly blockNumber: bigint | undefined;
  /** The chain's clock. Every countdown on the page is measured against this, not the browser's. */
  readonly chainTime: Date | undefined;
  readonly readAt: Date;
  /**
   * False when the timelock did not answer how many proposals exist. The list below is then
   * unknown, and unknown and empty say opposite things about who is waiting on what.
   */
  readonly complete: boolean;
  readonly failures: number;
  readonly delaySeconds: bigint | undefined;
  readonly graceSeconds: bigint | undefined;
  readonly requiredApprovals: number | undefined;
  readonly signerCount: number | undefined;
  readonly signers: readonly Address[] | undefined;
  readonly guardian: Address | undefined;
  readonly proposals: readonly Proposal[];
  /** The three contracts with a `pause()` the timelock holds the admin for. */
  readonly brake: readonly BrakeTarget[];
};

type RawProposal = {
  target: Address;
  data: Hex;
  createdAt: bigint;
  executeAfter: bigint;
  executed: boolean;
  cancelled: boolean;
};

/** A page, not a history. Older proposals are on the explorer and are not decisions anyone is waiting on. */
const MAX_SHOWN = 50;

/**
 * Error selectors for the timelock, computed from its ABI so they cannot drift from it. `canExecute`
 * answers with four bytes, and four bytes is not a reason a person can act on.
 */
const REFUSALS: ReadonlyMap<string, string> = new Map(
  adminTimelockAbi
    .filter((entry): entry is Extract<typeof entry, { type: 'error' }> => entry.type === 'error')
    .map((entry) => {
      const inputs = entry.inputs as readonly { readonly type: string }[];
      return [toFunctionSelector(`${entry.name}(${inputs.map((input) => input.type).join(',')})`), entry.name] as const;
    }),
);

export async function readGovernance(): Promise<Governance> {
  const client = rhcClient();
  const timelock = (functionName: string, args?: readonly unknown[]) => ({
    address: ADDRESSES.adminTimelock,
    abi: adminTimelockAbi as never,
    functionName,
    ...(args === undefined ? {} : { args }),
  });

  const head = new ReadBatch();
  const headSlots = {
    blockNumber: addBlockNumber(head),
    chainTime: addChainTime(head),
    count: head.add<bigint>('timelock.proposalCount', timelock('proposalCount')),
    period: head.add<bigint>('timelock.timelockPeriod', timelock('timelockPeriod')),
    grace: head.add<bigint>('timelock.GRACE_PERIOD', timelock('GRACE_PERIOD')),
    required: head.add<bigint>('timelock.REQUIRED_APPROVALS', timelock('REQUIRED_APPROVALS')),
    signerCount: head.add<bigint>('timelock.SIGNER_COUNT', timelock('SIGNER_COUNT')),
    signers: head.add<readonly Address[]>('timelock.getSigners', timelock('getSigners')),
    guardian: head.add<Address>('timelock.guardian', timelock('guardian')),
  };

  // The brake's three targets, read in the same aggregate. Each answers `pause()` only to its
  // admin, so whether the guardian can stop one is a reading and never an assumption.
  const brakeSlots = PAUSABLE.map((key) => {
    const contract = governedByKey(key);
    const address = contract.address();
    const call = (functionName: string) => ({ address, abi: contract.abi as never, functionName });
    return {
      key,
      name: contract.name,
      address,
      paused: head.add<boolean>(`${key}.paused`, call('paused')),
      admin: head.add<Address>(`${key}.admin`, call('admin')),
      pendingAdmin: head.add<Address>(`${key}.pendingAdmin`, call('pendingAdmin')),
    };
  });

  const headResults = await runBatch(client, head);
  const readAt = new Date();
  const blockNumber = headResults.get(headSlots.blockNumber);
  // An unanswered count is not a count of zero. Walking ids down from it either way is how an
  // unread contract ends up telling a reader that nothing is pending.
  const count = headResults.get(headSlots.count);
  const grace = headResults.get(headSlots.grace);
  const signers = headResults.get(headSlots.signers);
  const chainTime = toDate(headResults.get(headSlots.chainTime));

  const ids: number[] = [];
  for (let id = Number(count ?? 0n) - 1; id >= 0 && ids.length < MAX_SHOWN; id -= 1) ids.push(id);

  const base = {
    blockNumber,
    chainTime,
    readAt,
    complete: count !== undefined,
    failures: headResults.failures,
    delaySeconds: headResults.get(headSlots.period),
    graceSeconds: grace,
    requiredApprovals: numberOf(headResults.get(headSlots.required)),
    signerCount: numberOf(headResults.get(headSlots.signerCount)),
    signers,
    guardian: headResults.get(headSlots.guardian),
    brake: brakeSlots.map(
      (slot): BrakeTarget => ({
        key: slot.key,
        name: slot.name,
        address: slot.address,
        paused: headResults.get(slot.paused),
        admin: headResults.get(slot.admin),
        pendingAdmin: headResults.get(slot.pendingAdmin),
      }),
    ),
  };

  if (ids.length === 0) return { ...base, proposals: [] };

  // One request for every proposal on the page and every signature on each of them. Six reads per
  // proposal fanned out would be three hundred arrivals, and the endpoint refills about twenty a second.
  const detail = new ReadBatch();
  const slots = ids.map((id) => ({
    id,
    proposal: detail.add<RawProposal>(`proposal.${id}`, timelock('getProposal', [BigInt(id)])),
    approvals: detail.add<bigint>(`approvals.${id}`, timelock('approvals', [BigInt(id)])),
    canExecute: detail.add<readonly [boolean, Hex]>(`canExecute.${id}`, timelock('canExecute', [BigInt(id)])),
    expires: detail.add<bigint>(`expiresAt.${id}`, timelock('expiresAt', [BigInt(id)])),
    approvedBy: signers?.map((signer) => ({
      signer,
      slot: detail.add<boolean>(`hasApproved.${id}.${signer}`, timelock('hasApproved', [BigInt(id), signer])),
    })),
  }));

  const results = await runBatch(client, detail);
  const now = chainTime ?? readAt;

  const proposals = slots
    .map((entry): Proposal | undefined => {
      const raw = results.get(entry.proposal);
      if (!raw || raw.createdAt === 0n) return undefined;

      const executeAfter = toDate(raw.executeAfter) ?? readAt;
      // The contract's own expiry, or the delay plus the grace period when that slot went
      // unanswered. Neither available leaves it unknown, and an unknown expiry must not be
      // allowed to read as an expired proposal.
      const expiresAt =
        toDate(results.get(entry.expires)) ??
        (grace === undefined ? undefined : new Date(executeAfter.getTime() + Number(grace) * 1000));
      const approvals = numberOf(results.get(entry.approvals));
      const refusal = results.get(entry.canExecute)?.[1];

      return {
        id: entry.id,
        target: raw.target,
        data: raw.data,
        createdAt: toDate(raw.createdAt) ?? readAt,
        executeAfter,
        expiresAt,
        executed: raw.executed,
        cancelled: raw.cancelled,
        approvals,
        approvedBy: entry.approvedBy?.filter(({ slot }) => results.get(slot) === true).map(({ signer }) => signer),
        status: statusOf({
          raw,
          approvals,
          required: base.requiredApprovals,
          executeAfter,
          expiresAt,
          now,
        }),
        refusal: refusal && refusal !== '0x00000000' ? REFUSALS.get(refusal) : undefined,
      };
    })
    .filter((proposal): proposal is Proposal => proposal !== undefined);

  return { ...base, proposals };
}

/**
 * Executed and cancelled are on the record that was read, so they stand on their own. Everything
 * below needs the quorum, the count of approvals and the expiry, and a threshold invented for a
 * missing one decides both the badge on the card and whether Execute is offered at all.
 *
 * Exported so the rule can be held to in a test without a chain in front of it.
 */
export function statusOf(input: {
  raw: RawProposal;
  approvals: number | undefined;
  required: number | undefined;
  executeAfter: Date;
  expiresAt: Date | undefined;
  now: Date;
}): ProposalStatus {
  if (input.raw.executed) return 'executed';
  if (input.raw.cancelled) return 'cancelled';
  if (input.approvals === undefined || input.required === undefined || input.expiresAt === undefined) return 'not-read';
  if (input.now > input.expiresAt) return 'expired';
  if (input.approvals < input.required) return 'awaiting-approvals';
  if (input.now < input.executeAfter) return 'waiting-out-the-delay';
  return 'executable';
}

function toDate(seconds: bigint | undefined): Date | undefined {
  return seconds === undefined || seconds === 0n ? undefined : new Date(Number(seconds) * 1000);
}

function numberOf(value: bigint | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}
