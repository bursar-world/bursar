import { encodeFunctionData, getContract, parseEventLogs } from 'viem';
import type { Address, GetContractReturnType, Hex, PublicClient, Transport, Chain, TypedDataDomain } from 'viem';
import { escrowAbi, mandateAccountAbi, micro, reputationAbi, settlementAssetAbi } from '@bursar/core';
import type { Micro } from '@bursar/core';

import { assertMandateDomain, signLimitsAuthorization, signSpendApproval } from './authorization.js';
import type { LimitsAuthorization } from './authorization.js';
import { canonicalStringify, commitCanonical, toCapabilityId, toDataUri } from './commit.js';
import { connectFor, requireSigner, type Connection, type ConnectOptions } from './connection.js';
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
import { sendCall, type ExplainRevert, type Sent } from './send.js';
import { payRequest, type FetchTarget, type PaidResponse } from './x402/fetch.js';
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
  /** What the provider takes home, after the protocol fee charged on its side of the settlement. */
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
  };
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

  readonly #account: AccountContract;
  readonly #terms: EscrowBounds;
  #disputeClient: Promise<DisputeClient> | undefined;

  constructor(init: {
    address: Address;
    connection: Connection;
    escrow: Address;
    settlementAsset: Address;
    terms: EscrowBounds;
  }) {
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
    return toLimits(await this.#account.read.limits());
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
    ]);

    return {
      address: this.address,
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

  async allowsCapability(capability: string): Promise<boolean> {
    return this.#account.read.capabilities([toCapabilityId(checkCapability('capability', capability))]);
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
    const capability = checkCapability('capability', request.capability);
    const capabilityId = toCapabilityId(capability);
    const amount = checkAmount('amount', request.amount);

    const [[allowed, selector], remaining, daily, monthly] = await Promise.all([
      this.#account.read.previewSpend([to, capabilityId, amount]),
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
          snapshot: { limits: await this.limits(), remaining, daily, monthly },
        })
      : undefined;

    const message =
      denial?.message ??
      `Mandate ${this.address} refused this spend with ${selector}, which this package does not ` +
        'recognise. The deployment is ahead of @bursar/sdk; upgrade the package.';

    return {
      allowed: false,
      reason,
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
   * The agent's own wallet pays: the `exact` scheme is a signature from the address holding the
   * funds, and this contract cannot produce one. Before signing, each payment is checked against
   * the mandate's per-call cap, merchant and capability allowlists, and state. What it refuses is
   * never signed, and the refusal names the limit that stopped it.
   *
   * The daily and monthly windows are read but never debited on this path. A payment larger than
   * what a window has left is refused, yet a hundred payments that each fit all clear, because
   * none of them is counted. For spending the windows count and enforce, use `pay` or `hire`,
   * which move funds from the mandate into the escrow.
   */
  async fetch(input: FetchTarget, options: MandateFetchOptions): Promise<PaidResponse> {
    const { capability, maxAmount, validForSeconds, fetchFn, ...init } = options;

    return payRequest(input, {
      connection: this.connection,
      through: { mandate: this, capability },
      init,
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

  async #pay(request: PayRequest, action: 'pay' | 'hire'): Promise<PaymentReceipt> {
    const to = checkAddress('to', request.to);
    const capability = checkCapability('capability', request.capability);
    const capabilityId = toCapabilityId(capability);
    const amount = checkPositiveAmount('amount', request.amount);
    // Before the deadline read, so a read-only client is told it cannot pay under the name of the
    // call it made, not the contract function underneath it.
    requireSigner(this.connection, action);
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
    const data = approval
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

    const context: SpendContext = { merchant: to, capability, capabilityId, amount };

    const sent = await sendCall(this.connection, {
      to: this.address,
      data,
      action: approval ? 'spendApproved' : 'spend',
      explain: this.#explainSpend(context),
    });

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
      merchant: to,
      capability,
      capabilityId,
      amount,
      inputCommit,
      inputURI,
      deadline: toDate(deadline),
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
      encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'setLimits',
        args: [encodeLimits(limits)],
      }),
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

    return signLimitsAuthorization(
      this.connection,
      this.address,
      encodeLimits(limits),
      nonce,
      toSeconds('deadline', options.deadline),
    );
  }

  /** Relays a signed limit change. Anyone can send it; only the principal can have signed it. */
  async relayLimits(authorization: LimitsAuthorization): Promise<Sent> {
    return this.#send(
      'setLimitsWithAuthorization',
      encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'setLimitsWithAuthorization',
        args: [
          encodeLimits(authorization.limits),
          checkRange('nonce', authorization.nonce, UINT256_MAX),
          toSeconds('deadline', authorization.deadline),
          checkSignature('signature', authorization.signature),
        ],
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

  async setCapability(capability: string, allowed: boolean): Promise<Sent> {
    return this.#send(
      'setCapability',
      encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'setCapability',
        args: [toCapabilityId(checkCapability('capability', capability)), allowed],
      }),
    );
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
   * spend does, so an approval that is never used costs nothing and expires on its own.
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
      capabilityId: toCapabilityId(checkCapability('capability', input.capability)),
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
    return this.#send(
      'disputeSpend',
      encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'disputeSpend',
        args: [checkEscrowId('escrowId', escrowId)],
      }),
    );
  }

  /** Opened once and kept, because the escrow's pairing and the voting parameters do not move. */
  #disputes(): Promise<DisputeClient> {
    this.#disputeClient ??= disputes(this.connection);

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
    const [limits, remaining, daily, monthly] = await Promise.all([
      this.limits(),
      this.remaining(),
      this.window(WindowKind.Daily),
      this.window(WindowKind.Monthly),
    ]);

    return { limits, remaining, daily, monthly };
  }

  /**
   * Turns a refused spend into a sentence naming the limit and when it frees up. The reads run
   * only on the failure path, so the cost sits where a human is about to read the answer.
   */
  #explainSpend(context: SpendContext): ExplainRevert {
    return async (revert) => {
      if (!revert) return undefined;

      const reason = denialReasonFor(revert.errorName);
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

      return this.#explainEscrow(revert, context);
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
  const connection = connectFor(options, 'mandateAccount()');
  const client = connection.publicClient;

  const account = checkAddress('address', address);

  const [escrow, settlementAsset] = await discover(
    Promise.all([
      client.readContract({ address: account, abi: mandateAccountAbi, functionName: 'escrow' }),
      client.readContract({ address: account, abi: mandateAccountAbi, functionName: 'settlementAsset' }),
    ]),
    () => new NotAMandateAccountError({ address: account, contract: 'account' }),
  );

  const [minTtl, maxTtl, reputation, registry] = await discover(
    Promise.all([
      client.readContract({ address: escrow, abi: escrowAbi, functionName: 'minTtl' }),
      client.readContract({ address: escrow, abi: escrowAbi, functionName: 'maxTtl' }),
      client.readContract({ address: escrow, abi: escrowAbi, functionName: 'reputation' }),
      client.readContract({ address: escrow, abi: escrowAbi, functionName: 'registry' }),
    ]),
    () => new NotAMandateAccountError({ address: escrow, contract: 'escrow', account }),
  );

  return new MandateAccountClient({
    address: account,
    connection,
    escrow,
    settlementAsset,
    terms: { minTtl, maxTtl, reputation, registry },
  });
}
