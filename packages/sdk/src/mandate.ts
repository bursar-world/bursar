import { encodeFunctionData, getContract, parseEventLogs } from 'viem';
import type { Address, GetContractReturnType, Hex, PublicClient, Transport, Chain, TypedDataDomain } from 'viem';
import {
  CLASS_MASK_ALL,
  CURRENT_CONTRACT_SET,
  DEFAULT_CLASS_MASK,
  SPEND_CLASS_BIT,
  SpendClassError,
  classLabel,
  classMaskOf,
  classOfLabel,
  contractSetOfEscrow,
  escrowAbi,
  mandateAccountAbi,
  mandateAccountAbiV1,
  micro,
  reputationAbi,
  settlementAssetAbi,
} from '@bursar/core';
import type { ContractSet, SpendClass } from '@bursar/core';
import type { Micro } from '@bursar/core';

import { assertMandateDomain, limitsV1, signLimitsAuthorization, signSpendApproval } from './authorization.js';
import type { LimitsAuthorization } from './authorization.js';
import { canonicalStringify, commitCanonical, toCapabilityId, toDataUri } from './commit.js';
import { openConnection, requireSigner, type Connection, type ConnectOptions } from './connection.js';
import { disputes, type DisputeClient, type DisputeRecord } from './dispute.js';
import { jobCommit, jobURI, readJobURI, type JobDocument, type JobSpec } from './job.js';
import {
  AmbiguousSpendError,
  CallRefusedError,
  InsufficientFundsError,
  InvalidArgumentError,
  MandateDeniedError,
  MissingEventError,
  NotAMandateAccountError,
  denialOf,
  denialReasonFor,
  type DenialReason,
  type MandateSnapshot,
} from './errors.js';
import { formatDuration, toDate, usd } from './format.js';
import {
  UINT256_MAX,
  checkAddress,
  checkAmount,
  checkBytes32,
  checkCapability,
  checkEscrowId,
  checkPositiveAmount,
  checkProof,
  checkRange,
  checkSignature,
  toSeconds,
} from './guards.js';
import { random32 } from './random.js';
import { logsFrom } from './receipt.js';
import { decodeRevertData, returnedNoData, type RevertInfo } from './revert.js';
import { boundCredit, laneRefusal } from './lane-refusals.js';
import { laneContext, laneOf, rwa, type BuyReceipt } from './rwa.js';
import { collateral, type CollateralClient } from './collateral.js';
import { sendCall, type ExplainRevert, type Sent } from './send.js';
import { payRequest, type FetchTarget, type PaidResponse, type PaymentLane } from './x402/fetch.js';
import {
  LockStatus,
  MerchantGate,
  WindowKind,
  toLockStatus,
  type MandateLimits,
  type MandateLimitsInput,
  type MandateStatus,
  type Remaining,
  type SignedApproval,
  type SpendApproval,
  type SpendWindow,
  type TotalSpend,
} from './types.js';

/** How long a provider has to answer when the caller does not say. Clamped to the escrow's bounds. */
export const DEFAULT_TTL_SECONDS = 300;

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const;

/**
 * Seconds a deadline keeps above the escrow's floor, measured from the block it was computed
 * against.
 *
 * The escrow checks the deadline against the block the spend lands in, not the one read here, and
 * every second between the two comes off the ttl. A deadline one second over the floor reverts
 * `BadTtl` as soon as the transaction waits a block. A minute covers a slow signer and a few
 * blocks of queueing without keeping the provider waiting noticeably longer.
 */
const DEADLINE_MARGIN_SECONDS = 60n;

export type PayRequest = {
  /** The provider being paid. It becomes the payee of the escrow lock this opens. */
  readonly to: Address;
  readonly amount: Micro;
  /** A capability label such as `gpu.render:1`, or a 32-byte id if you already have one. */
  readonly capability: string;
  /** Committed as canonical JSON, so the provider can prove which request it answered. */
  readonly input?: unknown;
  /** An already-computed input commitment. Supply this or `input`, never both. */
  readonly inputCommit?: Hex;
  /** Where the provider fetches the input. The chain stores the string, never the payload. */
  readonly inputURI?: string;
  /** Seconds the provider has to deliver. Defaults to five minutes inside the escrow's bounds. */
  readonly ttlSeconds?: number;
  /** An absolute deadline in unix seconds. Overrides `ttlSeconds`. */
  readonly deadline?: bigint;
  /** Required under a Merkle merchant gate, rejected under an allowlist gate. */
  readonly merchantProof?: readonly Hex[];
  /** The principal's consent, for a spend at or above the approval threshold. */
  readonly approval?: SignedApproval;
};

export type PaymentReceipt = {
  /** The escrow lock this payment opened. The provider takes it by committing to its output. */
  readonly escrowId: bigint;
  readonly hash: Hex;
  readonly explorer: string;
  readonly blockNumber: bigint;
  readonly merchant: Address;
  readonly capability: string;
  readonly capabilityId: Hex;
  readonly amount: Micro;
  readonly inputCommit: Hex;
  /** Where the provider reads the committed input. Empty only when nothing was committed. */
  readonly inputURI: string;
  readonly deadline: Date;
  /** What each window now holds against it, as the account counted this payment. */
  readonly spent: { readonly daily: Micro; readonly monthly: Micro };
  /** What is left after this payment, read back from the account. */
  readonly remaining: Remaining;
};

/**
 * Hiring one agent to do a piece of work for another.
 *
 * The same money, the same limits and the same refusals as `pay`. What it adds is the brief: the
 * spec is committed with the payment, so the provider can prove what it was asked for, the payer
 * can prove what it asked, and a resolver reading a contested job has the terms in front of it
 * rather than a bag of arguments.
 */
export type HireRequest = {
  /** The agent being hired. It becomes the payee of the escrow lock this opens. */
  readonly provider: Address;
  /** The capability being bought, named and versioned: `research.summarize:1`. */
  readonly capability: string;
  readonly spec: JobSpec;
  /** What the job is worth, in micro-USD. It is locked, not sent, until the work is delivered. */
  readonly budget: Micro;
  /** Seconds the provider has to deliver. Defaults to five minutes inside the escrow's bounds. */
  readonly deliverWithinSeconds?: number;
  /** An absolute deadline in unix seconds. Overrides `deliverWithinSeconds`. */
  readonly deliverBy?: bigint;
  /** Required under a Merkle merchant gate, rejected under an allowlist gate. */
  readonly providerProof?: readonly Hex[];
  /** The principal's consent, for a budget at or above the approval threshold. */
  readonly approval?: SignedApproval;
};

export type HireReceipt = PaymentReceipt & {
  /** The escrow lock the job runs against. The same number `pay` calls an escrow id. */
  readonly jobId: bigint;
  readonly task: string;
  /** The hash of the brief the provider is bound to. It is the lock's own input commitment. */
  readonly specCommit: Hex;
  /** Where the brief is published. Inline by default, so it travels with the lock. */
  readonly specURI: string;
};

/** A hired job as it stands, from the side that paid for it. */
export type JobStatus = {
  readonly jobId: bigint;
  readonly provider: Address;
  readonly payer: Address;
  readonly capabilityId: Hex;
  readonly budget: Micro;
  /** What the provider takes home, after the settlement fee charged on its side. */
  readonly payout: Micro;
  readonly status: LockStatus;
  readonly deliverBy: Date;
  readonly specCommit: Hex;
  readonly specURI: string;
  /** The brief itself, when it was published inline. Null when it lives somewhere this cannot read. */
  readonly spec: JobDocument | null;
  readonly deliveredAt: Date | null;
  /** The hash of what was delivered. Check bytes against it with `verifyDelivery`. */
  readonly deliveryCommit: Hex | null;
  readonly deliveryURI: string | null;
  /** The last moment a delivered job can still be contested. Null while nothing has been delivered. */
  readonly disputableUntil: Date | null;
  readonly next: string;
};

export type PreviewRequest = {
  readonly to: Address;
  readonly amount: Micro;
  readonly capability: string;
  /** Set when the spend will carry the principal's approval, which lifts the threshold check. */
  readonly approved?: boolean;
  /**
   * The class a bare label is read under. Defaults to `service`, which is what `pay` and an x402
   * payment spend under; pass `hire` to preview a `hire`. A label already namespaced, such as
   * `hire:research.summarize:1`, is previewed as written.
   */
  readonly spendClass?: 'service' | 'hire';
};

/**
 * What the mandate would decide right now. The account answers without reverting, so a refusal
 * costs nothing and can be quoted before a payment is signed.
 */
export type Decision = {
  readonly allowed: boolean;
  readonly reason: DenialReason | undefined;
  readonly errorName: string | undefined;
  /** The sentence `pay` would have thrown. Empty when the spend is allowed. */
  readonly message: string;
  /** The error `pay` would have thrown, ready to throw or to log. */
  readonly denial: MandateDeniedError | undefined;
  readonly remaining: Remaining;
  readonly daily: SpendWindow;
  readonly monthly: SpendWindow;
};

/** Everything `fetch` takes, plus what the mandate needs to decide whether to pay. */
export type MandateFetchOptions = RequestInit & {
  /** The capability this call falls under. The mandate's allowlist is read against it. */
  readonly capability: string;
  /** A ceiling this call will not pay past, whatever the mandate would have allowed. */
  readonly maxAmount?: Micro;
  /** How long the signed authorization stays valid. Defaults to the offer's own timeout. */
  readonly validForSeconds?: number;
  readonly fetchFn?: typeof fetch;
  /**
   * `mandate` pays from this account through `spend`, with every window enforced on chain.
   * `wallet`, the default, pays from the agent's wallet: per-call only; windows client-enforced.
   */
  readonly lane?: PaymentLane;
};

export type WithdrawArgs = {
  readonly to: Address;
  readonly amount: Micro;
  /** Defaults to the settlement asset. Name another to sweep a mistaken airdrop. */
  readonly token?: Address;
};

/** What the escrow imposes on a spend, read once because none of it can change. */
type EscrowBounds = {
  readonly minTtl: bigint;
  readonly maxTtl: bigint;
  /** The smallest lock the escrow opens. One micro-USDG on an escrow before v3. */
  readonly minLock: Micro;
  readonly reputation: Address;
  readonly registry: Address;
};

type SpendContext = {
  readonly merchant: Address;
  readonly capability: string;
  readonly capabilityId: Hex;
  readonly amount: Micro;
};

type AccountContract = GetContractReturnType<
  typeof mandateAccountAbi,
  PublicClient<Transport, Chain>,
  Address
>;

type RawWindow = { cap: bigint; spent: bigint; duration: bigint; start: bigint; epoch: bigint };

type RawLimits = {
  perCallCap: bigint;
  dailyCap: bigint;
  monthlyCap: bigint;
  dailyWindow: bigint;
  monthlyWindow: bigint;
  approvalThreshold: bigint;
  validFrom: bigint;
  validUntil: bigint;
  /** Absent on a v1 account. */
  classMask?: number;
  totalCap?: bigint;
  lane?: number;
};

function toWindow(kind: WindowKind, raw: RawWindow): SpendWindow {
  return {
    kind,
    cap: micro(raw.cap),
    spent: micro(raw.spent),
    remaining: micro(raw.cap > raw.spent ? raw.cap - raw.spent : 0n),
    duration: raw.duration,
    startsAt: toDate(raw.start),
    resetsAt: toDate(raw.start + raw.duration),
    epoch: raw.epoch,
  };
}

function toLimits(raw: RawLimits): MandateLimits {
  return {
    perCallCap: micro(raw.perCallCap),
    dailyCap: micro(raw.dailyCap),
    monthlyCap: micro(raw.monthlyCap),
    dailyWindow: raw.dailyWindow,
    monthlyWindow: raw.monthlyWindow,
    approvalThreshold: micro(raw.approvalThreshold),
    validFrom: raw.validFrom,
    validUntil: raw.validUntil,
    classMask: raw.classMask ?? 0,
    totalCap: micro(raw.totalCap ?? 0n),
    lane: raw.lane ?? 0,
  };
}

/**
 * One approval, with every field checked against the type it is encoded as.
 *
 * Shared by the signed path and the on-chain path, because they are the same consent and a field
 * that is checked in one and not the other is a hole with the same shape as the check.
 */
function checkApproval(approval: SpendApproval): SpendApproval {
  return {
    approvalId: checkBytes32('approval.approvalId', approval.approvalId),
    merchant: checkAddress('approval.merchant', approval.merchant),
    capabilityId: checkBytes32('approval.capabilityId', approval.capabilityId),
    amount: checkPositiveAmount('approval.amount', approval.amount),
    expiry: toSeconds('approval.expiry', approval.expiry),
  };
}

function checkEnum<T extends number>(field: string, value: T, allowed: readonly T[]): T {
  if (!allowed.includes(value)) {
    throw new InvalidArgumentError(field, `${field} must be one of ${allowed.join(', ')}, received ${value}.`, {
      value,
      allowed: [...allowed],
    });
  }

  return value;
}

/** Limits as the account holds them, with every field checked against the type it is encoded as. */
export function encodeLimits(input: MandateLimitsInput): MandateLimits {
  return {
    perCallCap: checkAmount('perCallCap', input.perCallCap),
    dailyCap: checkAmount('dailyCap', input.dailyCap),
    monthlyCap: checkAmount('monthlyCap', input.monthlyCap),
    dailyWindow: toSeconds('dailyWindow', input.dailyWindow),
    monthlyWindow: toSeconds('monthlyWindow', input.monthlyWindow),
    approvalThreshold: checkPositiveAmount('approvalThreshold', input.approvalThreshold),
    validFrom: toSeconds('validFrom', input.validFrom ?? 0n),
    validUntil: toSeconds('validUntil', input.validUntil ?? 0n),
    classMask: checkClassMask(
      input.classMask ?? (input.classes === undefined ? DEFAULT_CLASS_MASK : classMaskOf(input.classes)),
    ),
    totalCap: checkAmount('totalCap', input.totalCap ?? micro(0n)),
    lane: checkEnum('lane', input.lane ?? 0, [0, 1, 2]),
  };
}

/** A mask the account would take: at least one class, and no bit it does not know. */
function checkClassMask(mask: number): number {
  if (!Number.isInteger(mask) || mask <= 0 || (mask & ~CLASS_MASK_ALL) !== 0) {
    throw new InvalidArgumentError(
      'classMask',
      `classMask must allow at least one class and use only bits 0 to 2, received ${mask}. ` +
        'A mandate that allows no class refuses every spend, and the account will not store one.',
      { classMask: mask },
    );
  }
  return mask;
}

/**
 * Limits for a v1 account, which holds eight fields. A lifetime total cannot be dropped silently:
 * the principal asked for a ceiling the account would not enforce.
 */
function encodeLimitsV1(input: MandateLimitsInput) {
  const limits = encodeLimits(input);
  if (limits.totalCap > 0n) {
    throw new InvalidArgumentError(
      'totalCap',
      'This is a v1 mandate, which holds no lifetime total. Set the total budget as a second window ' +
        'instead, or create a v2 mandate.',
      { totalCap: limits.totalCap.toString() },
    );
  }
  return limitsV1(limits);
}

/**
 * One spending mandate, from both sides of it: an agent pays through it, a principal decides what
 * it may pay for.
 *
 * Amounts are micro-USD in USDG's own six decimals. The chain's native balance is ETH and pays
 * fees only; nothing here reads it, and the two are never added.
 */
export class MandateAccountClient {
  readonly address: Address;
  readonly connection: Connection;
  /** The escrow this account settles through, fixed when the account was deployed. */
  readonly escrow: Address;
  readonly settlementAsset: Address;
  /**
   * Which build of the contracts this account runs. A v1 account is read and written through the
   * v1 ABI: eight-field limits, no class in the spend request, no native total.
   */
  readonly contractSet: ContractSet;

  readonly #account: AccountContract;
  readonly #terms: EscrowBounds;
  #disputeClient: Promise<DisputeClient> | undefined;

  constructor(init: {
    address: Address;
    connection: Connection;
    escrow: Address;
    settlementAsset: Address;
    terms: EscrowBounds;
    contractSet?: ContractSet;
  }) {
    this.contractSet = init.contractSet ?? CURRENT_CONTRACT_SET;
    this.address = init.address;
    this.connection = init.connection;
    this.escrow = init.escrow;
    this.settlementAsset = init.settlementAsset;
    this.#terms = init.terms;
    this.#account = getContract({
      address: init.address,
      abi: mandateAccountAbi,
      client: init.connection.publicClient,
    });
  }

  async limits(): Promise<MandateLimits> {
    if (this.contractSet === 'v1') {
      return toLimits(
        await this.connection.publicClient.readContract({
          address: this.address,
          abi: mandateAccountAbiV1,
          functionName: 'limits',
        }),
      );
    }
    return toLimits(await this.#account.read.limits());
  }

  /** The lifetime total as the account counts it. Null on a v1 account, which has none. */
  async total(): Promise<TotalSpend | null> {
    if (this.contractSet === 'v1') return null;
    const { totalCap: cap } = await this.limits();
    if (cap === 0n) return null;
    const spent = await this.#account.read.totalSpent();
    return { cap, spent: micro(spent), remaining: micro(cap > spent ? cap - spent : 0n) };
  }

  async window(kind: WindowKind): Promise<SpendWindow> {
    const checked = checkEnum('kind', kind, [WindowKind.Daily, WindowKind.Monthly]);

    return toWindow(checked, await this.#account.read.window([checked]));
  }

  /** What the agent can spend right now, with the clock on each bucket. */
  async remaining(): Promise<Remaining> {
    const [caps, daily, monthly] = await Promise.all([
      this.#account.read.remaining(),
      this.window(WindowKind.Daily),
      this.window(WindowKind.Monthly),
    ]);

    return {
      perCall: micro(caps[0]),
      daily: micro(caps[1]),
      monthly: micro(caps[2]),
      dailyResetsAt: daily.resetsAt,
      monthlyResetsAt: monthly.resetsAt,
    };
  }

  /** The settlement asset this account holds: what it can pay out before it needs funding. */
  async balance(): Promise<Micro> {
    const balance = await this.connection.publicClient.readContract({
      address: this.settlementAsset,
      abi: settlementAssetAbi,
      functionName: 'balanceOf',
      args: [this.address],
    });

    return micro(balance);
  }

  /** Everything the mandate holds, in one pass. */
  async status(): Promise<MandateStatus> {
    const read = this.#account.read;

    const [
      principal,
      pendingPrincipal,
      agent,
      paused,
      revoked,
      version,
      gate,
      merchantRoot,
      documentHash,
      nonce,
      limits,
      remaining,
      daily,
      monthly,
      balance,
      total,
    ] = await Promise.all([
      read.principal(),
      read.pendingPrincipal(),
      read.agent(),
      read.paused(),
      read.revoked(),
      read.version(),
      read.merchantGate(),
      read.merchantRoot(),
      read.documentHash(),
      read.nonce(),
      this.limits(),
      this.remaining(),
      this.window(WindowKind.Daily),
      this.window(WindowKind.Monthly),
      this.balance(),
      this.total(),
    ]);

    return {
      address: this.address,
      contractSet: this.contractSet,
      principal,
      pendingPrincipal,
      agent,
      escrow: this.escrow,
      settlementAsset: this.settlementAsset,
      balance,
      paused,
      revoked,
      version,
      limits,
      remaining,
      daily,
      monthly,
      merchantGate: gate === MerchantGate.MerkleRoot ? MerchantGate.MerkleRoot : MerchantGate.Allowlist,
      merchantRoot,
      documentHash,
      nonce,
      total,
    };
  }

  /** What is still creditable against a spend: what it committed, less what has come back. */
  async creditable(escrowId: bigint): Promise<Micro> {
    return micro(await this.#account.read.creditable([checkEscrowId('escrowId', escrowId)]));
  }

  /** Whether an approval id was registered on chain, and whether it has been used or revoked. */
  async approval(approvalId: Hex): Promise<{ registered: boolean; spent: boolean }> {
    const [registered, spent] = await this.#account.read.approvals([
      checkBytes32('approvalId', approvalId),
    ]);

    return { registered, spent };
  }

  async allowsMerchant(merchant: Address): Promise<boolean> {
    return this.#account.read.merchants([checkAddress('merchant', merchant)]);
  }

  /**
   * Whether `pay` or `hire` may spend on a capability, read the way they spend: a bare label is a
   * service, `hire:` and `rwa:` labels are read as written, and a 32-byte id is taken as it is.
   */
  async allowsCapability(capability: string): Promise<boolean> {
    return this.#account.read.capabilities([allowedCapabilityId(capability)]);
  }

  /** The Merkle leaf for a merchant, for building a roster off chain. */
  async merchantLeaf(merchant: Address): Promise<Hex> {
    return this.#account.read.merchantLeaf([checkAddress('merchant', merchant)]);
  }

  /** The EIP-712 domain this account signs under, checked against the account itself. */
  async domain(): Promise<TypedDataDomain> {
    return assertMandateDomain(this.connection, this.address);
  }

  /**
   * What the mandate would decide, without spending anything.
   *
   * Under a Merkle merchant gate the account cannot settle the merchant term without a proof, so
   * it reports `merchant-proof-required` and answers every other check. That leaves the caller one
   * question to resolve off chain.
   */
  async preview(request: PreviewRequest): Promise<Decision> {
    const to = checkAddress('to', request.to);
    const written = checkCapability('capability', request.capability).trim();
    const capability =
      classOfLabel(written) === undefined ? spendLabel(request.spendClass ?? 'service', written) : written;
    const capabilityId = toCapabilityId(capability);
    const amount = checkAmount('amount', request.amount);
    const spendClass = SPEND_CLASS_BIT[classOfLabel(capability) ?? 'service'];

    const [[allowed, selector], remaining, daily, monthly] = await Promise.all([
      this.contractSet === 'v1'
        ? this.connection.publicClient.readContract({
            address: this.address,
            abi: mandateAccountAbiV1,
            functionName: 'previewSpend',
            args: [to, capabilityId, amount],
          })
        : this.#account.read.previewSpend([to, capabilityId, amount, spendClass]),
      this.remaining(),
      this.window(WindowKind.Daily),
      this.window(WindowKind.Monthly),
    ]);

    const decoded = decodeRevertData(selector);
    const reason = decoded ? denialReasonFor(decoded.errorName) : undefined;
    const cleared = allowed || (request.approved === true && reason === 'approval-required');

    if (cleared) {
      return {
        allowed: true,
        reason: undefined,
        errorName: undefined,
        message: '',
        denial: undefined,
        remaining,
        daily,
        monthly,
      };
    }

    const denial = reason
      ? new MandateDeniedError({
          reason,
          errorName: decoded?.errorName ?? '',
          mandate: this.address,
          merchant: to,
          capability,
          capabilityId,
          amount,
          snapshot: { limits: await this.limits(), remaining, daily, monthly, total: await this.total() },
        })
      : undefined;

    const message =
      denial?.message ??
      `Mandate ${this.address} refused this spend with ${selector}, which this package does not ` +
        'recognise. The deployment is ahead of @bursar/sdk; upgrade the package.';

    return {
      allowed: false,
      reason: denial?.reason ?? reason,
      errorName: decoded?.errorName,
      message,
      denial,
      remaining,
      daily,
      monthly,
    };
  }

  /**
   * Throws unless the mandate would allow this spend. The x402 path calls it before signing
   * anything, so a refusal costs one read and no payment.
   *
   * This is a read. It records nothing, so a payment it clears is never debited from the daily or
   * monthly window, and a run of such payments is not held to either cap. Only `pay` and `hire`
   * spend against the windows.
   */
  async assertCanPay(request: PreviewRequest): Promise<void> {
    const decision = await this.preview(request);
    if (decision.allowed) return;

    throw decision.denial ?? new CallRefusedError(decision.errorName ?? 'Unknown', decision.message);
  }

  /**
   * Fetches a resource, paying for it over x402 if it asks to be paid.
   *
   * With `lane: 'mandate'` this account pays through `spend`: the windows move by the amount paid
   * and the contract refuses what they do not cover. The server has to offer the `escrow` scheme.
   *
   * The default `wallet` lane has the agent's own wallet pay under `exact`. Per-call only; windows
   * client-enforced. Each payment is checked against the per-call cap, merchant and capability
   * allowlists and state before it is signed, and the windows are read but never debited, so a
   * hundred payments that each fit all clear.
   */
  async fetch(input: FetchTarget, options: MandateFetchOptions): Promise<PaidResponse> {
    const { capability, maxAmount, validForSeconds, fetchFn, lane, ...init } = options;

    return payRequest(input, {
      connection: this.connection,
      through: { mandate: this, capability },
      init,
      ...(lane === undefined ? {} : { lane }),
      ...(maxAmount === undefined ? {} : { maxAmount }),
      ...(validForSeconds === undefined ? {} : { validForSeconds }),
      ...(fetchFn === undefined ? {} : { fetchFn }),
    });
  }

  /**
   * Pays a provider through the mandate.
   *
   * The account checks its own limits, moves the amount into the escrow against a deadline, and
   * the provider claims it by committing to what it delivered. Nothing is paid out until that
   * happens: a provider that never answers leaves the funds to be reclaimed with `timeout`, and
   * the allowance the spend consumed is credited back to the window it came from.
   */
  async pay(request: PayRequest): Promise<PaymentReceipt> {
    return this.#pay(request, 'pay');
  }

  /**
   * `pay` spends in the `service` class and `hire` in the `hire` class. The class is the namespace
   * of the capability id the lock carries, so a mandate that allows only services refuses a hire on
   * chain, whatever label the caller wrote.
   */
  async #pay(request: PayRequest, action: 'pay' | 'hire'): Promise<PaymentReceipt> {
    const to = checkAddress('to', request.to);
    const capability = spendLabel(action === 'hire' ? 'hire' : 'service', checkCapability('capability', request.capability));
    const capabilityId = toCapabilityId(capability);
    const amount = checkPositiveAmount('amount', request.amount);
    // Before the deadline read, so a read-only client is told it cannot pay under the name of the
    // call it made, not the contract function underneath it.
    requireSigner(this.connection, action);
    // The account's own preview does not know the escrow's floor, so a payment under it would pass
    // every limit and then revert inside the lock.
    if (amount < this.#terms.minLock) {
      throw new CallRefusedError('BelowMinLock', belowMinLock(amount, this.#terms.minLock), {
        amount: amount.toString(),
        minLock: this.#terms.minLock.toString(),
      });
    }
    const { commit: inputCommit, uri: inputURI } = this.#input(request);
    const deadline = await this.#deadline(request);
    const proof = request.merchantProof === undefined ? [] : checkProof('merchantProof', request.merchantProof);

    const spendRequest = {
      merchant: to,
      capabilityId,
      inputCommit,
      inputURI,
      amount,
      deadline,
    } as const;

    const approval = request.approval;
    const data = this.contractSet === 'v1'
      ? encodeFunctionData(
          approval
            ? {
                abi: mandateAccountAbiV1,
                functionName: 'spendApproved',
                args: [
                  spendRequest,
                  proof,
                  checkApproval(approval.approval),
                  checkSignature('approval.signature', approval.signature),
                ],
              }
            : { abi: mandateAccountAbiV1, functionName: 'spend', args: [spendRequest, proof] },
        )
      : this.#spendData({ ...spendRequest, spendClass: SPEND_CLASS_BIT[action === 'hire' ? 'hire' : 'service'] }, proof, approval);

    const context: SpendContext = { merchant: to, capability, capabilityId, amount };

    const sent = await sendCall(this.connection, {
      to: this.address,
      data,
      action: approval ? 'spendApproved' : 'spend',
      explain: this.#explainSpend(context),
    });

    return this.#receipt(sent, { to, capability, capabilityId, amount, inputCommit, inputURI, deadline });
  }

  #spendData(
    spendRequest: {
      merchant: Address;
      capabilityId: Hex;
      inputCommit: Hex;
      inputURI: string;
      amount: Micro;
      deadline: bigint;
      spendClass: number;
    },
    proof: readonly Hex[],
    approval: SignedApproval | undefined,
  ): Hex {
    return approval
      ? encodeFunctionData({
          abi: mandateAccountAbi,
          functionName: 'spendApproved',
          args: [
            spendRequest,
            proof,
            checkApproval(approval.approval),
            checkSignature('approval.signature', approval.signature),
          ],
        })
      : encodeFunctionData({
          abi: mandateAccountAbi,
          functionName: 'spend',
          args: [spendRequest, proof],
        });
  }

  async #receipt(
    sent: Sent,
    paid: {
      to: Address;
      capability: string;
      capabilityId: Hex;
      amount: Micro;
      inputCommit: Hex;
      inputURI: string;
      deadline: bigint;
    },
  ): Promise<PaymentReceipt> {
    // `Spent` is the same event on both sets, so the current ABI decodes a v1 receipt too.
    const spends = parseEventLogs({
      abi: mandateAccountAbi,
      eventName: 'Spent',
      logs: logsFrom(sent.receipt.logs, this.address),
    });

    const spent = spends[0];
    if (!spent) throw new MissingEventError('Spent', this.address, sent.hash);

    if (spends.length > 1) {
      throw new AmbiguousSpendError(sent.hash, this.address, spends.length);
    }

    return {
      escrowId: spent.args.escrowId,
      hash: sent.hash,
      explorer: sent.explorer,
      blockNumber: sent.blockNumber,
      merchant: paid.to,
      capability: paid.capability,
      capabilityId: paid.capabilityId,
      amount: paid.amount,
      inputCommit: paid.inputCommit,
      inputURI: paid.inputURI,
      deadline: toDate(paid.deadline),
      spent: { daily: micro(spent.args.dailySpent), monthly: micro(spent.args.monthlySpent) },
      remaining: await this.remaining(),
    };
  }

  /**
   * Hires a provider to do a piece of work, paid through this mandate.
   *
   * A hire is a payment with a brief attached. The mandate checks the same limits, the escrow
   * takes the same lock, and a refusal names the same condition, so an agent that already knows
   * how to pay knows how to hire. What changes is what the lock commits to: the task, the
   * arguments and the acceptance criteria, in canonical JSON, published inline so the provider
   * reads them straight off the chain. The provider delivers by committing to its answer, which
   * releases the funds in the same transaction. Nothing is paid out before that, and a job nobody
   * answers returns the budget when its deadline passes.
   */
  async hire(request: HireRequest): Promise<HireReceipt> {
    const spec = jobCommit(request.spec);
    const uri = jobURI(request.spec);

    const receipt = await this.#pay({
      to: request.provider,
      amount: request.budget,
      capability: request.capability,
      inputCommit: spec,
      inputURI: uri,
      ...(request.deliverWithinSeconds === undefined ? {} : { ttlSeconds: request.deliverWithinSeconds }),
      ...(request.deliverBy === undefined ? {} : { deadline: request.deliverBy }),
      ...(request.providerProof === undefined ? {} : { merchantProof: request.providerProof }),
      ...(request.approval === undefined ? {} : { approval: request.approval }),
    }, 'hire');

    return {
      ...receipt,
      jobId: receipt.escrowId,
      task: request.spec.task.trim(),
      specCommit: spec,
      specURI: uri,
    };
  }

  /**
   * One job this mandate paid for, as the escrow holds it.
   *
   * A lock opened by somebody else is somebody else's business and is refused rather than
   * reported, because the amounts and the deadline here are read as this mandate's exposure.
   */
  async job(jobId: bigint): Promise<JobStatus> {
    const id = checkEscrowId('jobId', jobId);
    const escrowContract = getContract({
      address: this.escrow,
      abi: escrowAbi,
      client: this.connection.publicClient,
    }).read;

    const [lock, disputeWindow, feeBps] = await Promise.all([
      escrowContract.getLock([id]),
      escrowContract.disputeWindow(),
      escrowContract.feeBps(),
    ]);

    const status = toLockStatus(lock.status);

    if (status === LockStatus.None) {
      throw new InvalidArgumentError('jobId', `No job carries id ${id}. Nothing was read.`, {
        jobId: id.toString(),
      });
    }

    if (lock.payer.toLowerCase() !== this.address.toLowerCase()) {
      throw new InvalidArgumentError(
        'jobId',
        `Job ${id} was paid for by ${lock.payer}, not by this mandate. Nothing was read.`,
        { jobId: id.toString(), payer: lock.payer, mandate: this.address },
      );
    }

    const amount = micro(lock.amount);
    const delivered = lock.releasedAt === 0n ? null : toDate(lock.releasedAt);

    return {
      jobId: id,
      provider: lock.payee,
      payer: lock.payer,
      capabilityId: lock.capabilityId,
      budget: amount,
      payout: micro(amount - (amount * BigInt(feeBps)) / 10_000n),
      status,
      deliverBy: toDate(lock.deadline),
      specCommit: lock.inputCommit,
      specURI: lock.inputURI,
      spec: publishedSpec(lock.inputURI),
      deliveredAt: delivered,
      deliveryCommit: isZeroBytes32(lock.outputCommit) ? null : lock.outputCommit,
      deliveryURI: lock.outputURI === '' ? null : lock.outputURI,
      disputableUntil:
        lock.releasedAt === 0n || disputeWindow === 0n ? null : toDate(lock.releasedAt + disputeWindow),
      next: jobNote(status, lock.deadline, lock.releasedAt, disputeWindow),
    };
  }

  /**
   * The dispute against one of this mandate's payments, and the ruling once there is one. Null
   * when nobody has contested it.
   */
  async disputeOf(escrowId: bigint): Promise<DisputeRecord | null> {
    return (await this.#disputes()).of(checkEscrowId('escrowId', escrowId));
  }

  /** Writes the whole limit set and bumps `version`. Partial updates do not exist. */
  async setLimits(limits: MandateLimitsInput): Promise<Sent> {
    return this.#send(
      'setLimits',
      this.contractSet === 'v1'
        ? encodeFunctionData({ abi: mandateAccountAbiV1, functionName: 'setLimits', args: [encodeLimitsV1(limits)] })
        : encodeFunctionData({ abi: mandateAccountAbi, functionName: 'setLimits', args: [encodeLimits(limits)] }),
    );
  }

  /**
   * Signs a limit change for a relayer to send. The principal needs neither gas nor a hot key: a
   * Safe or any other ERC-1271 signer can authorise this.
   */
  async signLimits(
    limits: MandateLimitsInput,
    options: { deadline: number | bigint; nonce?: bigint },
  ): Promise<LimitsAuthorization> {
    const nonce =
      options.nonce === undefined ? await this.#account.read.nonce() : checkRange('nonce', options.nonce, UINT256_MAX);

    if (this.contractSet === 'v1') encodeLimitsV1(limits);

    return signLimitsAuthorization(
      this.connection,
      this.address,
      encodeLimits(limits),
      nonce,
      toSeconds('deadline', options.deadline),
      this.contractSet,
    );
  }

  /** Relays a signed limit change. Anyone can send it; only the principal can have signed it. */
  async relayLimits(authorization: LimitsAuthorization): Promise<Sent> {
    const nonce = checkRange('nonce', authorization.nonce, UINT256_MAX);
    const deadline = toSeconds('deadline', authorization.deadline);
    const signature = checkSignature('signature', authorization.signature);

    return this.#send(
      'setLimitsWithAuthorization',
      this.contractSet === 'v1'
        ? encodeFunctionData({
            abi: mandateAccountAbiV1,
            functionName: 'setLimitsWithAuthorization',
            args: [encodeLimitsV1(authorization.limits), nonce, deadline, signature],
          })
        : encodeFunctionData({
            abi: mandateAccountAbi,
            functionName: 'setLimitsWithAuthorization',
            args: [encodeLimits(authorization.limits), nonce, deadline, signature],
          }),
    );
  }

  async setMerchant(merchant: Address, allowed: boolean): Promise<Sent> {
    return this.#send(
      'setMerchant',
      encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'setMerchant',
        args: [checkAddress('merchant', merchant), allowed],
      }),
    );
  }

  /**
   * Switches which roster decides who can be paid. A Merkle gate needs a non-zero root and an
   * allowlist gate needs a zero one. An empty root denies every merchant and reads as an outage,
   * not a policy.
   */
  async setMerchantGate(gate: MerchantGate, root: Hex = ZERO_BYTES32): Promise<Sent> {
    return this.#send(
      'setMerchantGate',
      encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'setMerchantGate',
        args: [
          checkEnum('gate', gate, [MerchantGate.Allowlist, MerchantGate.MerkleRoot]),
          checkBytes32('merchantRoot', root),
        ],
      }),
    );
  }

  /**
   * Allows or refuses one capability, keyed the way `pay` and `hire` spend on it. A bare label such
   * as `gpu.render:1` is allowed as a service, which is the class `pay` spends in. A hire is named
   * `hire:research.summarize:1`, and a label already carrying a class is stored as written. A 32-byte
   * id is stored as given.
   */
  async setCapability(capability: string, allowed: boolean): Promise<Sent> {
    return this.#send(
      'setCapability',
      encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'setCapability',
        args: [allowedCapabilityId(capability), allowed],
      }),
    );
  }

  /**
   * Buys `usd` of an eligible stock (by symbol or address) for this mandate. Sent by the agent.
   * See `RwaClient` for the treasury lane and the purchase policy.
   */
  async buy(asset: string, usd: Micro): Promise<BuyReceipt> {
    return rwa(this).buy(asset, usd);
  }

  /** The collateral lane for this mandate: posted collateral, credit, health and repayment. */
  collateral(): CollateralClient {
    return collateral(this);
  }

  async setPaused(paused: boolean): Promise<Sent> {
    return this.#send(
      'setPaused',
      encodeFunctionData({ abi: mandateAccountAbi, functionName: 'setPaused', args: [paused] }),
    );
  }

  async setAgent(agent: Address): Promise<Sent> {
    return this.#send(
      'setAgent',
      encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'setAgent',
        args: [checkAddress('agent', agent)],
      }),
    );
  }

  async revokeAgent(): Promise<Sent> {
    return this.#send(
      'revokeAgent',
      encodeFunctionData({ abi: mandateAccountAbi, functionName: 'revokeAgent' }),
    );
  }

  /** Anchors the hash of the mandate document this account enforces, for an auditor to tie back. */
  async setDocumentHash(documentHash: Hex): Promise<Sent> {
    return this.#send(
      'setDocumentHash',
      encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'setDocumentHash',
        args: [checkBytes32('documentHash', documentHash)],
      }),
    );
  }

  async transferPrincipal(to: Address): Promise<Sent> {
    return this.#send(
      'transferPrincipal',
      encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'transferPrincipal',
        args: [checkAddress('to', to)],
      }),
    );
  }

  /** Called by the incoming principal. A transfer nobody accepts changes nothing. */
  async acceptPrincipal(): Promise<Sent> {
    return this.#send(
      'acceptPrincipal',
      encodeFunctionData({ abi: mandateAccountAbi, functionName: 'acceptPrincipal' }),
    );
  }

  /**
   * Funds the mandate from the signer's own balance.
   *
   * Sends the allowance the account needs to pull with, when it is short, and then the deposit. A
   * plain transfer to the account funds it just as well; this path exists because it emits a
   * `Deposited` event and reports what actually arrived.
   */
  async deposit(amount: Micro): Promise<Sent> {
    const value = checkPositiveAmount('amount', amount);
    const { account } = requireSigner(this.connection, 'deposit');

    const allowance = await this.connection.publicClient.readContract({
      address: this.settlementAsset,
      abi: settlementAssetAbi,
      functionName: 'allowance',
      args: [account.address, this.address],
    });

    if (allowance < value) {
      await sendCall(this.connection, {
        to: this.settlementAsset,
        data: encodeFunctionData({
          abi: settlementAssetAbi,
          functionName: 'approve',
          args: [this.address, value],
        }),
        action: 'approve',
      });
    }

    return this.#send(
      'deposit',
      encodeFunctionData({ abi: mandateAccountAbi, functionName: 'deposit', args: [value] }),
    );
  }

  /** Moves funds out. `token` is free so a mistaken airdrop can be swept. */
  async withdraw(args: WithdrawArgs): Promise<Sent> {
    return this.#send(
      'withdraw',
      encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'withdraw',
        args: [
          args.token === undefined ? this.settlementAsset : checkAddress('token', args.token),
          checkAddress('to', args.to),
          checkPositiveAmount('amount', args.amount),
        ],
      }),
    );
  }

  /**
   * Signs consent for one spend at or above the approval threshold.
   *
   * The result is handed to the agent and carried into `pay`. Nothing reaches the chain until the
   * spend does, so an approval that is never used costs nothing and expires on its own. The
   * capability is read as `pay` reads it, so a bare label consents to a service; consent to a hire
   * names it with the `hire:` prefix.
   */
  async signApproval(input: {
    merchant: Address;
    capability: string;
    amount: Micro;
    expiry: number | bigint;
    approvalId?: Hex;
  }): Promise<SignedApproval> {
    const approval = checkApproval({
      approvalId: input.approvalId ?? random32(),
      merchant: input.merchant,
      capabilityId: allowedCapabilityId(input.capability),
      amount: input.amount,
      expiry: toSeconds('expiry', input.expiry),
    });

    return { approval, signature: await signSpendApproval(this.connection, this.address, approval) };
  }

  /** Registers an approval on chain instead of signing one. The agent then pays with no signature. */
  async approveSpend(approval: SpendApproval): Promise<Sent> {
    return this.#send(
      'approveSpend',
      encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'approveSpend',
        args: [checkApproval(approval)],
      }),
    );
  }

  /** Burns an approval id. Reaches an approval that only ever existed as a signature. */
  async revokeApproval(approvalId: Hex): Promise<Sent> {
    return this.#send(
      'revokeApproval',
      encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'revokeApproval',
        args: [checkBytes32('approvalId', approvalId)],
      }),
    );
  }

  /**
   * Contests a payment this mandate opened. The account posts the escrow's dispute bond from its
   * own balance, because it is the payer of record on every lock it opened.
   */
  async disputeSpend(escrowId: bigint): Promise<Sent> {
    const admin = this.#explainAdmin('disputeSpend');

    return this.#send(
      'disputeSpend',
      encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'disputeSpend',
        args: [checkEscrowId('escrowId', escrowId)],
      }),
      async (revert, error) =>
        revert?.errorName === 'TooLate'
          ? new CallRefusedError(
              revert.errorName,
              'Too late to contest this payment. While the escrow holds it, it can be contested until the ' +
                "provider's deadline; after that the escrow refunds the mandate through timeout, which " +
                'anyone can send. Once the provider has been paid, it can be contested only inside the ' +
                'dispute window after the release.',
              { mandate: this.address, escrowId: escrowId.toString() },
            )
          : admin(revert, error),
    );
  }

  /** Opened once and kept, because the escrow's pairing and the voting parameters do not move. */
  #disputes(): Promise<DisputeClient> {
    this.#disputeClient ??= disputes(this.connection, this.escrow);

    return this.#disputeClient;
  }

  #send(action: string, data: Hex, explain?: ExplainRevert): Promise<Sent> {
    return sendCall(this.connection, {
      to: this.address,
      data,
      action,
      explain: explain ?? this.#explainAdmin(action),
    });
  }

  /**
   * What the lock commits to and where the provider reads it.
   *
   * A commitment with nowhere to fetch the bytes is a lock nobody can answer: the provider is
   * asked to prove it worked on a payload it has no copy of, and the shipped worker refuses the
   * job outright. So an input committed here is also published here, inline, in the same
   * canonical bytes that were hashed. A caller hosting the payload itself passes `inputURI` and
   * keeps it.
   */
  #input(request: PayRequest): { commit: Hex; uri: string } {
    if (request.input !== undefined && request.inputCommit !== undefined) {
      throw new InvalidArgumentError(
        'inputCommit',
        'pay() takes either input to commit or an inputCommit already computed, not both.',
      );
    }

    if (request.inputCommit !== undefined) {
      return { commit: checkBytes32('inputCommit', request.inputCommit), uri: request.inputURI ?? '' };
    }

    if (request.input !== undefined) {
      return {
        commit: commitCanonical(request.input),
        uri: request.inputURI ?? toDataUri(canonicalStringify(request.input)),
      };
    }

    return { commit: ZERO_BYTES32, uri: request.inputURI ?? '' };
  }

  /**
   * The escrow wants a deadline strictly inside its own bounds, measured against the chain's
   * clock. A laptop a few seconds fast is not that clock, and the difference turns a valid ttl
   * into `BadTtl` on the far side of a paid transaction. The floor here sits
   * `DEADLINE_MARGIN_SECONDS` above the escrow's, for the time the spend spends reaching a block.
   */
  async #deadline(request: PayRequest): Promise<bigint> {
    const { minTtl, maxTtl } = this.#terms;
    const floor = minTtl + DEADLINE_MARGIN_SECONDS;
    const block = await this.connection.publicClient.getBlock({ blockTag: 'latest' });
    const now = block.timestamp;

    if (request.deadline !== undefined) {
      const deadline = toSeconds('deadline', request.deadline);
      if (deadline < now + floor || deadline >= now + maxTtl) {
        throw new InvalidArgumentError(
          'deadline',
          `deadline has to be at least ${formatDuration(floor)} and less than ` +
            `${formatDuration(maxTtl)} from now. The chain clock reads ${toDate(now).toISOString()}.`,
          { deadline: deadline.toString(), minTtl: floor.toString(), maxTtl: maxTtl.toString() },
        );
      }

      return deadline;
    }

    if (request.ttlSeconds !== undefined) {
      const ttl = toSeconds('ttlSeconds', request.ttlSeconds);
      if (ttl < floor || ttl >= maxTtl) {
        throw new InvalidArgumentError(
          'ttlSeconds',
          `ttlSeconds has to be at least ${floor} and less than ${maxTtl} on this escrow.`,
          { ttl: ttl.toString(), minTtl: floor.toString(), maxTtl: maxTtl.toString() },
        );
      }

      return now + ttl;
    }

    const wanted = BigInt(DEFAULT_TTL_SECONDS);
    const ttl = wanted < floor ? floor : wanted >= maxTtl ? maxTtl - 1n : wanted;

    return now + ttl;
  }

  async #snapshot(): Promise<MandateSnapshot> {
    const [limits, remaining, daily, monthly, total] = await Promise.all([
      this.limits(),
      this.remaining(),
      this.window(WindowKind.Daily),
      this.window(WindowKind.Monthly),
      this.total(),
    ]);

    return { limits, remaining, daily, monthly, total };
  }

  /**
   * Turns a refused spend into a sentence naming the limit and when it frees up. The reads run
   * only on the failure path, so the cost sits where a human is about to read the answer.
   */
  #explainSpend(context: SpendContext): ExplainRevert {
    return async (revert) => {
      if (!revert) return undefined;

      const reason = denialOf(revert);
      if (reason) {
        return new MandateDeniedError({
          reason,
          errorName: revert.errorName,
          mandate: this.address,
          merchant: context.merchant,
          capability: context.capability,
          capabilityId: context.capabilityId,
          amount: context.amount,
          snapshot: await this.#snapshot(),
        });
      }

      const escrow = await this.#explainEscrow(revert, context);
      if (escrow) return escrow;

      // A mandate short of USDG covers the difference inside the spend, from its park or on credit,
      // and a refusal there comes back through this call.
      const recorded = laneOf(this.connection);
      const bound = await boundCredit(revert, {
        client: this.connection.publicClient,
        pool: recorded?.collateral?.CreditPool,
        mandate: this.address,
      });
      const lane = laneRefusal(bound, 'spend', laneContext(this.connection, recorded));
      return lane === null
        ? undefined
        : new CallRefusedError(lane.code, lane.message, { mandate: this.address, owner: lane.owner });
    };
  }

  /** Admin calls fail on authority more often than on anything else, so name that first. */
  #explainAdmin(action: string): ExplainRevert {
    return async (revert) => {
      if (revert?.errorName === 'NotPrincipal') {
        const principal = await this.#account.read.principal();
        return new CallRefusedError(
          revert.errorName,
          `Only the principal can change this mandate, and that is ${principal}.`,
          { mandate: this.address, principal },
        );
      }

      if (revert?.errorName === 'MerkleGateActive') {
        return new CallRefusedError(
          revert.errorName,
          'This mandate gates merchants by Merkle root, so the per-address allowlist is not the ' +
            'roster it reads. Move the gate back with setMerchantGate before editing the allowlist.',
          { mandate: this.address },
        );
      }

      if (revert?.errorName === 'TransferMismatch') {
        return new CallRefusedError(
          revert.errorName,
          'The settlement asset moved a different amount than it was asked to. A mandate funded ' +
            'in an asset that does not move exactly what it is told to would pay one provider ' +
            'out of a lock that belongs to another, so the account refuses it.',
          { settlementAsset: this.settlementAsset },
        );
      }

      if (revert?.errorName === 'AlreadyPrincipal') {
        return new CallRefusedError(
          revert.errorName,
          'That address is already the principal. Naming it again would revoke nothing it has signed; ' +
            'withdraw an approval with revokeApproval instead.',
          { mandate: this.address },
        );
      }

      if (revert?.errorName === 'NotPendingPrincipal') {
        const pending = await this.#account.read.pendingPrincipal();
        return new CallRefusedError(
          revert.errorName,
          `Only the incoming principal can accept the transfer, and that is ${pending}.`,
          { mandate: this.address, pendingPrincipal: pending },
        );
      }

      return revert === undefined ? undefined : this.#explainLimits(revert, action);
    };
  }

  /**
   * The conditions a limit change is checked against, and the three a signed one adds.
   *
   * Every one of these leaves the limits in force untouched, which is the first thing a principal
   * asks. They are written out here so the generic revert error stays what it says it is: a name
   * this package has no sentence for.
   */
  async #explainLimits(revert: RevertInfo, action: string): Promise<Error | undefined> {
    switch (revert.errorName) {
      case 'BadWindow':
        return new CallRefusedError(
          revert.errorName,
          'A spending window has to be longer than zero seconds, because the caps are measured over ' +
            'it. Set dailyWindow and monthlyWindow to the periods you want counted, such as 86400n ' +
            'and 2592000n. The limits in force are unchanged.',
          { mandate: this.address },
        );

      case 'BadValidity':
        return new CallRefusedError(
          revert.errorName,
          'validUntil has to fall after validFrom. Leave validUntil at 0n for a mandate with no end ' +
            'date. The limits in force are unchanged.',
          { mandate: this.address },
        );

      case 'BadApprovalThreshold':
        return new CallRefusedError(
          revert.errorName,
          'approvalThreshold of zero would put every spend behind the principal, which reads as a ' +
            'broken agent. Set the amount at which a spend needs consent, or set it above perCallCap ' +
            'to say that no spend does. The limits in force are unchanged.',
          { mandate: this.address },
        );

      case 'AuthorizationExpired':
        return new CallRefusedError(
          revert.errorName,
          'The authorization passed its deadline before it reached the chain. Sign another with ' +
            'signLimits and a deadline that leaves room for the relay. The limits in force are unchanged.',
          { mandate: this.address },
        );

      case 'BadNonce': {
        const nonce = await this.#account.read.nonce();
        return new CallRefusedError(
          revert.errorName,
          `The authorization was signed against a different nonce, and this mandate is at ${nonce}. ` +
            'Every limit change the principal makes moves it, so an authorization held back is ' +
            'stranded. Sign another with signLimits, which reads the nonce as it stands.',
          { mandate: this.address, nonce: nonce.toString() },
        );
      }

      case 'BadSignature': {
        const principal = await this.#account.read.principal();
        return new CallRefusedError(
          revert.errorName,
          `The signature on this authorization does not recover to ${principal}, which is the ` +
            'principal of this mandate. A signature made for another account, another chain or ' +
            'another set of limits reads exactly like this one. signLimits reads the domain from ' +
            'the contract that checks it.',
          { mandate: this.address, principal },
        );
      }

      case 'ZeroAddress':
        return new CallRefusedError(
          revert.errorName,
          `${action} was given the zero address where the account needs a real one.`,
          { mandate: this.address },
        );

      case 'ZeroAmount':
        return new CallRefusedError(
          revert.errorName,
          `${action} was given an amount of zero, which the account refuses before it checks ` +
            'anything else.',
          { mandate: this.address },
        );

      default:
        return undefined;
    }
  }

  async #explainEscrow(revert: RevertInfo, context: SpendContext): Promise<Error | undefined> {
    switch (revert.errorName) {
      case 'PayeeCapExceeded': {
        const cap = await this.connection.publicClient.readContract({
          address: this.#terms.reputation,
          abi: reputationAbi,
          functionName: 'capOf',
          args: [context.merchant],
        });

        return new CallRefusedError(
          revert.errorName,
          `The escrow refused the lock: ${context.merchant} can hold at most ${usd(micro(cap))} in ` +
            `one job right now and this payment is ${usd(context.amount)}. That ceiling rises as ` +
            'the provider settles jobs. Split the job or pay a provider with more history.',
          { merchant: context.merchant, cap: cap.toString() },
        );
      }

      case 'PartyNotAllowed':
        return new CallRefusedError(
          revert.errorName,
          `The escrow refused the lock: ${context.merchant} is not an active party in the agent ` +
            'registry. A provider has to be registered and staked, and not barred, before it can be paid.',
          { merchant: context.merchant, registry: this.#terms.registry },
        );

      case 'BadTtl':
        return new CallRefusedError(
          revert.errorName,
          `The escrow refused the deadline. It has to be more than ${formatDuration(this.#terms.minTtl)} ` +
            `and less than ${formatDuration(this.#terms.maxTtl)} from now.`,
          { minTtl: this.#terms.minTtl.toString(), maxTtl: this.#terms.maxTtl.toString() },
        );

      case 'BelowMinLock':
        return new CallRefusedError(revert.errorName, belowMinLock(context.amount, this.#terms.minLock), {
          amount: context.amount.toString(),
          minLock: this.#terms.minLock.toString(),
        });

      case 'TransferMismatch':
        return new CallRefusedError(
          revert.errorName,
          'The settlement asset moved a different amount than it was asked to. The escrow settles ' +
            'every lock at its face amount and refuses an asset that does not.',
        );

      case 'ERC20InsufficientBalance':
        return new InsufficientFundsError(this.address, await this.balance(), context.amount);

      case 'Error': {
        const reason = typeof revert.args[0] === 'string' ? revert.args[0] : '';
        return /balance|funds/i.test(reason)
          ? new InsufficientFundsError(this.address, await this.balance(), context.amount)
          : undefined;
      }

      default:
        return undefined;
    }
  }
}

function isZeroBytes32(value: Hex): boolean {
  return /^0x0*$/u.test(value);
}

/**
 * The brief as published, when it was published inline.
 *
 * A URI pointing anywhere else is left unread. Following one on a counterparty's word is a
 * request forgery, and the commitment pins the bytes either way: fetch them under your own policy
 * and check them with `verifyDelivery`.
 */
function publishedSpec(uri: string): JobDocument | null {
  try {
    return readJobURI(uri);
  } catch {
    return null;
  }
}

function jobNote(status: LockStatus, deadline: bigint, releasedAt: bigint, disputeWindow: bigint): string {
  switch (status) {
    case LockStatus.Locked:
      return `The provider has until ${toDate(deadline).toISOString()} to deliver. The budget is held ` +
        'by the escrow until it does, and returns to the mandate if it does not.';
    case LockStatus.Released: {
      const closes = releasedAt + disputeWindow;

      return disputeWindow === 0n
        ? 'Delivered and paid. Check the delivered bytes against the commitment with verifyDelivery.'
        : `Delivered and paid. Check the delivered bytes against the commitment with verifyDelivery; ` +
            `if the work is wrong, contest it before ${toDate(closes).toISOString()}.`;
    }
    case LockStatus.TimedOut:
      return 'Nothing was delivered by the deadline. The budget is back in the mandate and the daily ' +
        'and monthly windows have been credited what this job took from them.';
    case LockStatus.Cancelled:
      return 'The provider declined the job. The budget is back in the mandate, and declining early ' +
        "counts nothing against the provider's history.";
    case LockStatus.Disputed:
      return 'This job is contested. Read the dispute for the phase it is in and the ruling when one ' +
        'lands.';
    case LockStatus.Resolved:
      return 'The dispute is closed and the escrow has moved the money on the ruling. Read the dispute ' +
        'for how it was split.';
    default:
      return 'No job carries this id.';
  }
}

/**
 * Runs the reads a client opens on, and turns an empty answer into the sentence for it.
 *
 * Anything else is left alone. A node that times out and an address holding no contract are
 * different facts, and reporting the first as the second sends a caller to check an address that
 * was right all along.
 */
async function discover<T>(reads: Promise<T>, missing: () => NotAMandateAccountError): Promise<T> {
  try {
    return await reads;
  } catch (error) {
    if (returnedNoData(error)) throw missing();

    throw error;
  }
}

/**
 * Opens a client for one mandate account.
 *
 * The escrow, the settlement asset and the escrow's deadline bounds are read once here. A payment
 * later is one simulation, one transaction and one receipt, with no round of discovery in front of
 * it. An address that answers none of those reads is not a mandate account, and that surfaces here
 * before a transaction is paid for.
 */
export async function mandateAccount(
  address: Address,
  options: Connection | ConnectOptions = {},
): Promise<MandateAccountClient> {
  const connection = await openConnection(options, 'mandateAccount()');
  const client = connection.publicClient;

  const account = checkAddress('address', address);

  const [escrow, settlementAsset] = await discover(
    Promise.all([
      client.readContract({ address: account, abi: mandateAccountAbi, functionName: 'escrow' }),
      client.readContract({ address: account, abi: mandateAccountAbi, functionName: 'settlementAsset' }),
    ]),
    () => new NotAMandateAccountError({ address: account, contract: 'account' }),
  );

  // An escrow no record names is a local or forked deployment, which runs the current source.
  const contractSet = contractSetOfEscrow(escrow) ?? CURRENT_CONTRACT_SET;

  const [minTtl, maxTtl, reputation, registry, minLock] = await discover(
    Promise.all([
      client.readContract({ address: escrow, abi: escrowAbi, functionName: 'minTtl' }),
      client.readContract({ address: escrow, abi: escrowAbi, functionName: 'maxTtl' }),
      client.readContract({ address: escrow, abi: escrowAbi, functionName: 'reputation' }),
      client.readContract({ address: escrow, abi: escrowAbi, functionName: 'registry' }),
      contractSet !== 'v1' && contractSet !== 'v2'
        ? client.readContract({ address: escrow, abi: escrowAbi, functionName: 'minLock' })
        : Promise.resolve(1n),
    ]),
    () => new NotAMandateAccountError({ address: escrow, contract: 'escrow', account }),
  );

  return new MandateAccountClient({
    address: account,
    connection,
    escrow,
    settlementAsset,
    terms: { minTtl, maxTtl, minLock: micro(minLock), reputation, registry },
    contractSet,
  });
}

function belowMinLock(amount: Micro, minLock: Micro): string {
  return (
    `The escrow opens no lock under ${usd(minLock)}, and this payment is ${usd(amount)}. The floor ` +
    'keeps every payment large enough that contesting it costs a bond. Nothing was sent; pay at ' +
    'least the floor.'
  );
}

/**
 * The id an allowlist entry or an approval is keyed by, under the rule `pay` spends by. A bare
 * label is a service, a label already in a class stays in it, and a 32-byte id is taken as the id it
 * is, since an id cannot be read back to a class.
 */
function allowedCapabilityId(capability: string): Hex {
  const written = checkCapability('capability', capability).trim();
  if (/^0x[0-9a-fA-F]{64}$/u.test(written)) return written as Hex;

  return toCapabilityId(classOfLabel(written) === undefined ? spendLabel('service', written) : written);
}

/**
 * The namespaced capability label a spend in `spendClass` carries, or an argument error naming the
 * field. See `classLabel` in `@bursar/core` for the rules.
 */
function spendLabel(spendClass: SpendClass, label: string): string {
  try {
    return classLabel(spendClass, label);
  } catch (error) {
    if (error instanceof SpendClassError) {
      throw new InvalidArgumentError('capability', error.message, { ...error.details });
    }
    throw error;
  }
}
