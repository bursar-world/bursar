import { toFunctionSelector } from 'viem';
import type { Address, Hex } from 'viem';

import { contractSetOf, deploymentByContract, deploymentsForChain } from '@bursar/core';
import type { Deployment } from '@bursar/core';

import { ADDRESSES, CHAIN_ID, ReadBatch, TOKEN_ROLES, addBlockNumber, addChainTime, adminTimelockAbi, rhcClient, runBatch, sameAddress } from '@/chain';
import { PAUSABLE, governedByKey, pauseControllerOf } from '@/chain/admin-actions';
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

/**
 * One governance delay contract. Every set of payment contracts deployed on this chain brought its
 * own, and the token contracts answer to the one their record names. A proposal only executes on
 * the delay that administers its target, so every proposal and every control on the page names
 * which one it belongs to.
 */
export type TimelockTag = {
  readonly address: Address;
  readonly current: boolean;
  /** What it governs, in the reader's words. */
  readonly name: string;
  /**
   * How its brake treats a target that refuses the pause. The current build skips that one and
   * stops the rest; earlier builds stop none of them. Undefined for a delay no record names.
   */
  readonly brake: 'each-target' | 'all-or-nothing' | undefined;
};

export function governanceTimelocks(): readonly TimelockTag[] {
  const records = deploymentsForChain(CHAIN_ID);
  const out: TimelockTag[] = [];
  for (const address of [ADDRESSES.adminTimelock, ...records.map((d) => d.contracts.AdminTimelock), TOKEN_ROLES.adminTimelock]) {
    if (out.some((entry) => sameAddress(entry.address, address))) continue;
    out.push({
      address,
      current: sameAddress(address, ADDRESSES.adminTimelock),
      name: governedBy(address, records),
      brake: brakeOf(address),
    });
  }
  return out;
}

function brakeOf(address: Address): TimelockTag['brake'] {
  const record = deploymentByContract('AdminTimelock', address);
  if (record === undefined) return undefined;
  return contractSetOf(record) === 'v3' ? 'each-target' : 'all-or-nothing';
}

/**
 * What one delay administers, named from the records that list it and the token record. A delay
 * neither the current set nor an earlier one names is the token record's alone.
 */
function governedBy(address: Address, records: readonly Deployment[]): string {
  const record = records.find((d) => sameAddress(d.contracts.AdminTimelock, address));
  const payments = sameAddress(address, ADDRESSES.adminTimelock)
    ? 'payment, dispute and credit contracts'
    : record === undefined
      ? undefined
      : contractSetOf(record) === 'v1'
        ? 'first payment contracts'
        : 'earlier payment, dispute and credit contracts';

  if (payments === undefined) return 'Token, staking and buyback';
  return sameAddress(address, TOKEN_ROLES.adminTimelock) ? `Token, staking and buyback, and the ${payments}` : capitalised(payments);
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type Proposal = {
  readonly id: number;
  readonly timelock: TimelockTag;
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
  /** The address the target lets call `pause()`: its admin, or the escrow's pauser. */
  readonly admin: Address | undefined;
};

/** Everything the page shows about one delay contract. */
export type TimelockReading = {
  readonly tag: TimelockTag;
  /** False when this timelock did not answer how many proposals it holds. */
  readonly complete: boolean;
  readonly delaySeconds: bigint | undefined;
  readonly graceSeconds: bigint | undefined;
  readonly requiredApprovals: number | undefined;
  readonly signerCount: number | undefined;
  readonly signers: readonly Address[] | undefined;
  readonly guardian: Address | undefined;
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
  /** Every delay contract, the current one first. The fields below it repeat the current one. */
  readonly timelocks: readonly TimelockReading[];
  readonly delaySeconds: bigint | undefined;
  readonly graceSeconds: bigint | undefined;
  readonly requiredApprovals: number | undefined;
  readonly signerCount: number | undefined;
  readonly signers: readonly Address[] | undefined;
  readonly guardian: Address | undefined;
  /** Proposals from every timelock, newest first. */
  readonly proposals: readonly Proposal[];
  /** Every contract with a `pause()` a timelock can reach, and which one reaches it. */
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
/** Why `execute` would refuse right now, in the words the proposal card finishes its sentence with. */
const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  TimelockNotExpired: 'the delay has not run out yet',
  InsufficientApprovals: 'it does not have two approvals yet',
  ProposalExpired: 'its window to execute has closed',
  AlreadyExecuted: 'it has already been executed',
  AlreadyCancelled: 'it was cancelled',
  AlreadyVetoed: 'it was vetoed',
  ExecutionFailed: 'the target contract would refuse the call',
  ProposalNotFound: 'there is no such proposal',
};

const REFUSALS: ReadonlyMap<string, string> = new Map(
  adminTimelockAbi
    .filter((entry): entry is Extract<typeof entry, { type: 'error' }> => entry.type === 'error')
    .map((entry) => {
      const inputs = entry.inputs as readonly { readonly type: string }[];
      const selector = toFunctionSelector(`${entry.name}(${inputs.map((input) => input.type).join(',')})`);
      return [selector, REFUSAL_WORDS[entry.name] ?? 'the governance contract would refuse it'] as const;
    }),
);

export async function readGovernance(): Promise<Governance> {
  const client = rhcClient();
  const tags = governanceTimelocks();
  const call = (address: Address) => (functionName: string, args?: readonly unknown[]) => ({
    address,
    abi: adminTimelockAbi as never,
    functionName,
    ...(args === undefined ? {} : { args }),
  });

  const head = new ReadBatch();
  const blockSlot = addBlockNumber(head);
  const timeSlot = addChainTime(head);
  const heads = tags.map((tag) => {
    const timelock = call(tag.address);
    const key = tag.address.toLowerCase();
    return {
      tag,
      count: head.add<bigint>(`${key}.proposalCount`, timelock('proposalCount')),
      period: head.add<bigint>(`${key}.timelockPeriod`, timelock('timelockPeriod')),
      grace: head.add<bigint>(`${key}.GRACE_PERIOD`, timelock('GRACE_PERIOD')),
      required: head.add<bigint>(`${key}.REQUIRED_APPROVALS`, timelock('REQUIRED_APPROVALS')),
      signerCount: head.add<bigint>(`${key}.SIGNER_COUNT`, timelock('SIGNER_COUNT')),
      signers: head.add<readonly Address[]>(`${key}.getSigners`, timelock('getSigners')),
      guardian: head.add<Address>(`${key}.guardian`, timelock('guardian')),
    };
  });

  // Each target answers `pause()` only to the address it names, so which timelock can stop it is
  // a reading and never an assumption.
  const brakeSlots = PAUSABLE.map((key) => {
    const contract = governedByKey(key);
    const address = contract.address();
    const read = (functionName: string) => ({ address, abi: contract.abi as never, functionName });
    return {
      key,
      name: contract.name,
      address,
      paused: head.add<boolean>(`${key}.paused`, read('paused')),
      admin: head.add<Address>(`${key}.${pauseControllerOf(key)}`, read(pauseControllerOf(key))),
    };
  });

  const headResults = await runBatch(client, head);
  const readAt = new Date();
  const chainTime = toDate(headResults.get(timeSlot));
  const now = chainTime ?? readAt;

  const timelocks = heads.map(
    (slot): TimelockReading & { readonly count: bigint | undefined } => ({
      tag: slot.tag,
      count: headResults.get(slot.count),
      complete: headResults.get(slot.count) !== undefined,
      delaySeconds: headResults.get(slot.period),
      graceSeconds: headResults.get(slot.grace),
      requiredApprovals: numberOf(headResults.get(slot.required)),
      signerCount: numberOf(headResults.get(slot.signerCount)),
      signers: headResults.get(slot.signers),
      guardian: headResults.get(slot.guardian),
    }),
  );

  // One request for every proposal on the page and every signature on each of them. Six reads per
  // proposal fanned out would be hundreds of arrivals, and the endpoint refills about twenty a second.
  const detail = new ReadBatch();
  const slots = timelocks.flatMap((reading) => {
    // An unanswered count is not a count of zero. Walking ids down from it either way is how an
    // unread contract ends up telling a reader that nothing is pending.
    const ids: number[] = [];
    for (let id = Number(reading.count ?? 0n) - 1; id >= 0 && ids.length < MAX_SHOWN; id -= 1) ids.push(id);
    const timelock = call(reading.tag.address);
    const key = reading.tag.address.toLowerCase();
    return ids.map((id) => ({
      id,
      reading,
      proposal: detail.add<RawProposal>(`${key}.proposal.${id}`, timelock('getProposal', [BigInt(id)])),
      approvals: detail.add<bigint>(`${key}.approvals.${id}`, timelock('approvals', [BigInt(id)])),
      canExecute: detail.add<readonly [boolean, Hex]>(`${key}.canExecute.${id}`, timelock('canExecute', [BigInt(id)])),
      expires: detail.add<bigint>(`${key}.expiresAt.${id}`, timelock('expiresAt', [BigInt(id)])),
      approvedBy: reading.signers?.map((signer) => ({
        signer,
        slot: detail.add<boolean>(`${key}.hasApproved.${id}.${signer}`, timelock('hasApproved', [BigInt(id), signer])),
      })),
    }));
  });

  const results = slots.length === 0 ? undefined : await runBatch(client, detail);

  const proposals = slots
    .map((entry): Proposal | undefined => {
      const raw = results?.get(entry.proposal);
      if (!raw || raw.createdAt === 0n) return undefined;
      const grace = entry.reading.graceSeconds;

      const executeAfter = toDate(raw.executeAfter) ?? readAt;
      // The contract's own expiry, or the delay plus the grace period when that slot went
      // unanswered. Neither available leaves it unknown, and an unknown expiry must not be
      // allowed to read as an expired proposal.
      const expiresAt =
        toDate(results?.get(entry.expires)) ??
        (grace === undefined ? undefined : new Date(executeAfter.getTime() + Number(grace) * 1000));
      const approvals = numberOf(results?.get(entry.approvals));
      const refusal = results?.get(entry.canExecute)?.[1];

      return {
        id: entry.id,
        timelock: entry.reading.tag,
        target: raw.target,
        data: raw.data,
        createdAt: toDate(raw.createdAt) ?? readAt,
        executeAfter,
        expiresAt,
        executed: raw.executed,
        cancelled: raw.cancelled,
        approvals,
        approvedBy: entry.approvedBy?.filter(({ slot }) => results?.get(slot) === true).map(({ signer }) => signer),
        status: statusOf({
          raw,
          approvals,
          required: entry.reading.requiredApprovals,
          executeAfter,
          expiresAt,
          now,
        }),
        refusal: refusal && refusal !== '0x00000000' ? REFUSALS.get(refusal) : undefined,
      };
    })
    .filter((proposal): proposal is Proposal => proposal !== undefined)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const current = timelocks[0];
  return {
    blockNumber: headResults.get(blockSlot),
    chainTime,
    readAt,
    complete: timelocks.every((reading) => reading.complete),
    failures: headResults.failures + (results?.failures ?? 0),
    timelocks: timelocks.map(({ count: _count, ...reading }) => reading),
    delaySeconds: current?.delaySeconds,
    graceSeconds: current?.graceSeconds,
    requiredApprovals: current?.requiredApprovals,
    signerCount: current?.signerCount,
    signers: signersOf(timelocks),
    guardian: current?.guardian,
    proposals,
    brake: brakeSlots.map(
      (slot): BrakeTarget => ({
        key: slot.key,
        name: slot.name,
        address: slot.address,
        paused: headResults.get(slot.paused),
        admin: headResults.get(slot.admin),
      }),
    ),
  };
}

/** Every signer across the timelocks, once each. Undefined when any set went unread. */
function signersOf(timelocks: readonly TimelockReading[]): readonly Address[] | undefined {
  const out: Address[] = [];
  for (const reading of timelocks) {
    if (reading.signers === undefined) return undefined;
    for (const signer of reading.signers) if (!out.some((entry) => sameAddress(entry, signer))) out.push(signer);
  }
  return out;
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
