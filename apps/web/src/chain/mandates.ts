import {
  COLLATERAL_LANE,
  collateralDeployment,
  contractSetOf,
  deploymentsForChain,
  isTotalBudgetWindow,
  micro,
  rwaDeployment,
} from '@bursar/core';
import type { ContractSet, Deployment, Micro } from '@bursar/core';
import { getCode, readContract } from 'viem/actions';
import { bytesToHex, hexToBytes, keccak256 } from 'viem';
import type { Address, Hex } from 'viem';

import { ADDRESSES, CHAIN_ID, deployment, sameAddress } from './rhc';
import { mandateAccountAbi, mandateAccountFactoryAbi, settlementAssetAbi } from './abi';
import { rhcClient } from './client';
import { ReadBatch, runBatch } from './batch';
import { toLimitsTuple } from './limits';
import type { LimitsForm } from './limits';

/** Enough of a mandate to list it. The full reading is one account at a time through readSystem. */
export type MandateSummary = {
  readonly address: Address;
  readonly agent: Address;
  readonly paused: boolean;
  readonly revoked: boolean;
  readonly balance: Micro;
  readonly perCallCap: Micro;
  readonly dailyRemaining: Micro;
  readonly monthlyRemaining: Micro;
  /**
   * Whether the mandate has a total budget, which never refills. On v2 it is `totalCap`; on v1 the
   * second window set never to roll. `monthlyRemaining` is what is left of it when there is one.
   */
  readonly totalBudget: boolean;
  readonly version: bigint;
};

/**
 * Every mandate a principal created, through each factory live on this chain: the current one
 * first, then the v1 factory whose accounts still hold funds and history. One call per factory.
 */
export async function mandatesOf(principal: Address): Promise<readonly Address[]> {
  const factories = mandateFactories();
  const lists = await Promise.all(
    (factories.length > 0 ? factories : [ADDRESSES.mandateAccountFactory]).map(
      async (factory) =>
        (await readContract(rhcClient(), {
          address: factory,
          abi: mandateAccountFactoryAbi,
          functionName: 'accountsOf',
          args: [principal],
        })) as readonly Address[],
    ),
  );
  return lists.flat();
}

/**
 * Every factory on this chain that deploys standard mandate accounts: each record's own, then the
 * v2.1 factory behind the treasury and collateral lanes where a record carries one.
 */
export function mandateFactories(): readonly Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const d of deploymentsForChain(CHAIN_ID)) {
    for (const factory of [d.contracts.MandateAccountFactory, d.rwa?.MandateAccountFactoryV21]) {
      if (factory === undefined || seen.has(factory.toLowerCase())) continue;
      seen.add(factory.toLowerCase());
      out.push(factory);
    }
  }
  return out;
}

/**
 * A live mandate anyone can read, for a visitor with no wallet. The record's `exampleMandate`; the
 * core package does not carry that field, so it is named here per chain.
 */
export function exampleMandate(): Address | undefined {
  return CHAIN_ID === 4663 ? '0x420BeB507F72173E7d78e0f956968f64fb508356' : undefined;
}

/**
 * How a mandate is funded, as the website names the three lanes.
 *
 * Prefund holds USDG and spends it. Treasury parks the idle part in a treasury token and the
 * account unparks it inside a spend. Collateral borrows the shortfall against stock or treasury
 * tokens posted to the vault. Treasury and collateral need an account that asks its park for USDG
 * inside a spend, which is the v2.1 build and every account from v3 on; the vault also refuses any
 * account outside lane 1.
 */
export type FundingLane = 'prefund' | 'treasury' | 'collateral';

export const FUNDING_LANES: readonly FundingLane[] = ['prefund', 'treasury', 'collateral'];

export const LANE_NAME: Readonly<Record<FundingLane, string>> = {
  prefund: 'Prefund',
  treasury: 'Treasury',
  collateral: 'Collateral',
};

export function readFundingLane(value: unknown): FundingLane | undefined {
  return typeof value === 'string' && (FUNDING_LANES as readonly string[]).includes(value) ? (value as FundingLane) : undefined;
}

/** The value written into the account's `lane` field. Treasury is lane 0 with a park named. */
export function laneValue(lane: FundingLane): number {
  return lane === 'collateral' ? COLLATERAL_LANE : 0;
}

/** Where a lane's account names its park after it is created, if anywhere. */
export function laneParkOf(lane: FundingLane): Address | undefined {
  if (lane === 'treasury') return rwaDeployment(CHAIN_ID)?.TreasuryPark;
  if (lane === 'collateral') return collateralDeployment(CHAIN_ID)?.CollateralVault;
  return undefined;
}

/** Whether this chain carries the contracts a lane needs. Prefund always works. */
export function laneAvailable(lane: FundingLane): boolean {
  if (lane === 'prefund') return true;
  return newAccountsDraw() && laneParkOf(lane) !== undefined;
}

/**
 * Whether an account the new-mandate factory deploys asks its park for USDG inside a spend. On v2
 * only the v2.1 factory's accounts do; from v3 on the set's own factory deploys that build.
 */
function newAccountsDraw(): boolean {
  return rwaDeployment(CHAIN_ID)?.MandateAccountFactoryV21 !== undefined || contractSetOf(deployment()) === 'v3';
}

/**
 * The factory new mandates are created through. The v2.1 factory when the chain has one, for every
 * lane, so a prefund mandate can take a park later; otherwise the record's own.
 */
export function newMandateFactory(): Address {
  return rwaDeployment(CHAIN_ID)?.MandateAccountFactoryV21 ?? ADDRESSES.mandateAccountFactory;
}

/**
 * The runtime code every account a factory deploys runs, with its per-account fields zeroed.
 *
 * Anything can answer `principal()` and `limits()` and look like a mandate to a reader, and a page on
 * this domain that shows owner controls for a look-alike lends the domain to whoever deployed it. The
 * factory's list cannot settle it on its own: it files an account under the principal that created
 * it, so a mandate whose ownership moved would read as foreign. The code settles it for every
 * account. Each factory deploys one contract, and its only immutables are the escrow and the
 * settlement asset, which are the same for all of its accounts, plus the EIP-712 cache: the
 * account's own address and the domain separator built from it. Zero those two and every genuine
 * account hashes to its build's value, and a contract that matches one and names itself in the
 * address field is a genuine account.
 *
 * One entry per build. The offsets come from `immutableReferences` in the compiled artifact: an
 * address sits in the low 20 bytes of its 32-byte slot. The v2 hash was taken from
 * 0x420BeB507F72173E7d78e0f956968f64fb508356 on chain 4663, whose code matches the artifact byte for
 * byte outside the immutables. The v2.1 build (the treasury and collateral lanes) speaks the v2 ABI
 * with more behind it, so it answers as v2; its hash was taken from
 * 0x4686C3566E1C50b4cC14c37A1088b7892d7D7407.
 *
 * The v3 build was fingerprinted before its escrow existed, from an account deployed on a local
 * chain with id 4663. Its hash is taken with the escrow and the settlement asset zeroed as well, and
 * an account of it is genuine only when every slot of each names the escrow and the asset of a v3
 * record for this chain. Until that record exists no v3 account is recognised.
 */
type MandateFingerprint = {
  readonly set: ContractSet;
  readonly length: number;
  readonly selfAddress: { readonly offset: number; readonly length: 20 };
  readonly domainSeparator: { readonly offset: number; readonly length: 32 };
  /** Where a build hashed with its escrow and settlement asset zeroed keeps each of them. */
  readonly pinned?: { readonly escrow: readonly number[]; readonly settlementAsset: readonly number[] };
  readonly maskedHash: Hex;
  /** The account asks its park for USDG when a spend or purchase runs short. */
  readonly draws: boolean;
};

const MANDATE_CODE: readonly MandateFingerprint[] = [
  {
    set: 'v1',
    length: 16_607,
    selfAddress: { offset: 8_522, length: 20 },
    domainSeparator: { offset: 8_594, length: 32 },
    maskedHash: '0x5588423c534f95c86931f78024212ef022e8f777a95cd18e4ce4d945a06cbdbe',
    draws: false,
  },
  {
    set: 'v2',
    length: 19_835,
    selfAddress: { offset: 10_786, length: 20 },
    domainSeparator: { offset: 10_858, length: 32 },
    maskedHash: '0xf11d2c8e0e96768711954cbe9a7c2fa69674c47258b5ecb615f8d4c063079bef',
    draws: false,
  },
  {
    set: 'v2',
    length: 20_331,
    selfAddress: { offset: 10_971, length: 20 },
    domainSeparator: { offset: 11_043, length: 32 },
    maskedHash: '0x179f3eaab82df63c910bf4891ad166a24daec88a85b343f1abc8d9857c5c01b5',
    draws: true,
  },
  {
    set: 'v3',
    length: 20_138,
    selfAddress: { offset: 10_817, length: 20 },
    domainSeparator: { offset: 10_889, length: 32 },
    pinned: {
      escrow: [2_629, 3_275, 5_618, 9_353, 11_817, 11_932],
      settlementAsset: [2_526, 6_683, 8_722, 9_399, 11_874, 14_350],
    },
    maskedHash: '0x849b6ca52ca2d4ed385616cd7c37841ba9683ffbafcb4ecfa0f02f9c769d4fe2',
    draws: true,
  },
];

/**
 * Which build `code` is, when it is a mandate account's runtime code deployed at `account`. Pure
 * given `records`, the deployments whose escrows a pinned build may name.
 */
export function mandateBuild(
  account: Address,
  code: Hex | undefined,
  records: readonly Deployment[] = deploymentsForChain(CHAIN_ID),
): { readonly set: ContractSet; readonly draws: boolean } | undefined {
  if (code === undefined) return undefined;
  const bytes = hexToBytes(code);

  for (const { set, length, selfAddress, domainSeparator, pinned, maskedHash, draws } of MANDATE_CODE) {
    if (bytes.length !== length) continue;

    const named = bytesToHex(bytes.subarray(selfAddress.offset, selfAddress.offset + selfAddress.length));
    if (!sameAddress(named, account)) continue;

    const masked = bytes.slice();
    masked.fill(0, selfAddress.offset, selfAddress.offset + selfAddress.length);
    masked.fill(0, domainSeparator.offset, domainSeparator.offset + domainSeparator.length);
    for (const offset of pinned === undefined ? [] : [...pinned.escrow, ...pinned.settlementAsset]) {
      masked.fill(0, offset, offset + 20);
    }
    if (keccak256(masked) !== maskedHash) continue;
    if (pinned !== undefined && !pinnedToRecord(bytes, pinned, set, records)) continue;
    return { set, draws };
  }

  return undefined;
}

/** Which build `code` is, when it is a mandate account's runtime code deployed at `account`. */
export function mandateCodeSet(
  account: Address,
  code: Hex | undefined,
  records: readonly Deployment[] = deploymentsForChain(CHAIN_ID),
): ContractSet | undefined {
  return mandateBuild(account, code, records)?.set;
}

/**
 * Every slot of the escrow names one address and every slot of the asset another, and a record of
 * the same build pairs the two. Checking one slot of each would pass code that names a genuine
 * escrow in one place and its own in the next.
 */
function pinnedToRecord(
  bytes: Uint8Array,
  pinned: NonNullable<MandateFingerprint['pinned']>,
  set: ContractSet,
  records: readonly Deployment[],
): boolean {
  const escrow = soleAddress(bytes, pinned.escrow);
  const asset = soleAddress(bytes, pinned.settlementAsset);
  if (escrow === undefined || asset === undefined) return false;
  return records.some(
    (d) => contractSetOf(d) === set && sameAddress(d.contracts.Escrow, escrow) && sameAddress(d.settlementAsset, asset),
  );
}

/** The address every one of these slots holds, or undefined when they disagree. */
function soleAddress(bytes: Uint8Array, offsets: readonly number[]): Address | undefined {
  const [first, ...rest] = offsets.map((offset) => bytesToHex(bytes.subarray(offset, offset + 20)));
  return first !== undefined && rest.every((value) => value === first) ? (first as Address) : undefined;
}

/** Whether `code` is a mandate account's runtime code, deployed at `account`. Pure given `records`. */
export function isMandateCode(
  account: Address,
  code: Hex | undefined,
  records: readonly Deployment[] = deploymentsForChain(CHAIN_ID),
): boolean {
  return mandateCodeSet(account, code, records) !== undefined;
}

/** The build an account the factories deployed runs, whoever owns it now. Undefined for anything else. */
export async function mandateCodeVersion(account: Address): Promise<ContractSet | undefined> {
  return mandateCodeSet(account, await getCode(rhcClient(), { address: account }));
}

/** Whether the address is an account a factory deployed, whoever owns it now. */
export async function isBursarMandate(account: Address): Promise<boolean> {
  return (await mandateCodeVersion(account)) !== undefined;
}

/**
 * The list view, in two requests whatever the count: one for the addresses, one batch for six
 * readings against each. Six calls per mandate fanned out is where a console with a dozen mandates
 * meets the endpoint's rate meter.
 */
export async function readMandateSummaries(
  principal: Address,
  signal?: AbortSignal,
): Promise<readonly MandateSummary[]> {
  const addresses = await mandatesOf(principal);
  if (addresses.length === 0) return [];

  const batch = new ReadBatch();
  const slots = addresses.map((address) => ({
    address,
    agent: batch.add<Address>('agent', { address, abi: mandateAccountAbi as never, functionName: 'agent' }),
    paused: batch.add<boolean>('paused', { address, abi: mandateAccountAbi as never, functionName: 'paused' }),
    revoked: batch.add<boolean>('revoked', { address, abi: mandateAccountAbi as never, functionName: 'revoked' }),
    version: batch.add<bigint>('version', { address, abi: mandateAccountAbi as never, functionName: 'version' }),
    perCallCap: batch.add<bigint>('perCallCap', { address, abi: mandateAccountAbi as never, functionName: 'perCallCap' }),
    remaining: batch.add<readonly [bigint, bigint, bigint]>('remaining', { address, abi: mandateAccountAbi as never, functionName: 'remaining' }),
    second: batch.add<{ readonly duration: bigint }>('window', { address, abi: mandateAccountAbi as never, functionName: 'window', args: [1] }),
    // v2 only. A v1 account has neither function, and the failed slot reads as no native total.
    totalCap: batch.add<bigint>('totalCap', { address, abi: mandateAccountAbi as never, functionName: 'totalCap' }),
    remainingTotal: batch.add<bigint>('remainingTotal', { address, abi: mandateAccountAbi as never, functionName: 'remainingTotal' }),
    balance: batch.add<bigint>('balance', { address: ADDRESSES.usdg, abi: settlementAssetAbi as never, functionName: 'balanceOf', args: [address] }),
  }));

  const results = await runBatch(rhcClient(), batch, signal);

  return slots.map((slot) => {
    const remaining = results.get(slot.remaining);
    const totalCap = results.get(slot.totalCap) ?? 0n;
    const nativeTotal = totalCap > 0n;
    return {
      address: slot.address,
      agent: results.get(slot.agent) ?? ('0x' as Address),
      paused: results.get(slot.paused) ?? false,
      revoked: results.get(slot.revoked) ?? false,
      balance: micro(results.get(slot.balance) ?? 0n),
      perCallCap: micro(results.get(slot.perCallCap) ?? 0n),
      dailyRemaining: micro(remaining?.[1] ?? 0n),
      monthlyRemaining: micro((nativeTotal ? results.get(slot.remainingTotal) : remaining?.[2]) ?? 0n),
      totalBudget: nativeTotal || isTotalBudgetWindow(results.get(slot.second)?.duration ?? 0n),
      version: results.get(slot.version) ?? 0n,
    };
  });
}

/**
 * The address a mandate will deploy at, before it exists.
 *
 * The principal, the agent, the salt and the limits together fix it, so the account can be funded
 * before a single transaction is sent. Change any of the four and it is a different address.
 */
export async function predictMandate(args: {
  readonly principal: Address;
  readonly agent: Address;
  readonly salt: Hex;
  readonly limits: LimitsForm;
  /** The factory the create will go through. The same inputs land elsewhere on another factory. */
  readonly factory?: Address;
}): Promise<Address> {
  return (await readContract(rhcClient(), {
    address: args.factory ?? ADDRESSES.mandateAccountFactory,
    abi: mandateAccountFactoryAbi,
    functionName: 'predict',
    args: [args.principal, args.agent, args.salt, toLimitsTuple(args.limits)],
  })) as Address;
}

/** The predicted address, and whether something already stands at it. */
export type PredictedMandate = { readonly address: Address; readonly deployed: boolean };

/**
 * The address a create would land at, with the one condition that stops the create.
 *
 * The factory refuses a salt whose address already holds code, and it is the only way `create`
 * can fail on inputs the form collects. Reading the code alongside the prediction is what lets
 * the form say so before a wallet opens, rather than after the fee has been paid.
 */
export async function predictMandateSlot(args: {
  readonly principal: Address;
  readonly agent: Address;
  readonly salt: Hex;
  readonly limits: LimitsForm;
  readonly factory?: Address;
}): Promise<PredictedMandate> {
  const address = await predictMandate(args);
  const code = await getCode(rhcClient(), { address });
  return { address, deployed: code !== undefined && code !== '0x' };
}

/** Random 32 bytes, so two mandates with identical limits still land at different addresses. */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
