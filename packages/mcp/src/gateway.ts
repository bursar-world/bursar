import {
  SpendClassError,
  classLabel,
  classOfLabel,
  escrowAbi,
  mandateAccountAbi,
  oracleRegistryAbi,
  settlementAssetAbi,
} from '@bursar/core';
import type { RhcPublicClient, SpendClass } from '@bursar/core';
import { decodeEventLog, encodeEventTopics } from 'viem';
import type { Address, Hex } from 'viem';

import {
  MAX_JOB_BYTES,
  capabilityId as toCapabilityId,
  canonicalStringify,
  commitCanonical,
  jobDocument,
  toDataUri,
} from './commit.js';
import { ToolError } from './errors.js';
import type { IndexedLog, SettlementIndex } from './explorer.js';
import { fromUint, instant, instantOrNull, money, moneyFromUint } from './format.js';
import { refusalForSelector } from './reasons.js';
import { toRelayApproval } from './relay.js';
import type { SpendRelay } from './relay.js';
import {
  FUNDS,
  disputeNext,
  mandateStatus,
  phaseName,
  quoteNext,
  refusalView,
  settlementNext,
  splitOf,
  statusOf,
  summarize,
  windowView,
} from './views.js';
import type {
  DisputeDetailView,
  DisputeReceiptView,
  DisputeRulingView,
  DisputeView,
  HireOrder,
  HireView,
  MandateGateway,
  MandateView,
  PayOrder,
  PayView,
  QuoteRequest,
  QuoteView,
  SettlementDetailView,
  SettlementStatus,
  SettlementView,
  SettlementsQuery,
  SettlementsView,
} from './types.js';

export type ChainGatewayOptions = {
  readonly client: RhcPublicClient;
  readonly account: Address;
  readonly escrow: Address;
  readonly settlementAsset: Address;
  /** Absent when no signer is configured. The server then advertises the read-only tools only. */
  readonly relay: SpendRelay | null;
  /** Where the settlement history is read from. The node cannot answer it; see explorer.ts. */
  readonly index: SettlementIndex;
};

/** Basis points, as every rate in the escrow is expressed. */
const BPS = 10_000n;

/** The line the escrow draws between a ruling that went the disputer's way and one that did not. */
const HALF_BPS = 5_000;

const DISPUTE_PHASE = { None: 0, Committing: 1, Revealing: 2, Finalized: 3, Failed: 4 } as const;

const DAILY = 0;
const MONTHLY = 1;

/**
 * Seconds a deadline keeps above the escrow's floor, measured from the block it was computed
 * against.
 *
 * The escrow checks the deadline against the block the spend lands in, not the one read here, and
 * every second between the two comes off the ttl. A ttl one second over the floor reverts `BadTtl`
 * as soon as the relay's transaction waits a block. A minute covers a slow relay and a few blocks
 * of queueing.
 */
const DEADLINE_MARGIN_SECONDS = 60n;

export function createChainGateway(options: ChainGatewayOptions): MandateGateway {
  const { client, account, escrow, settlementAsset, relay } = options;

  const accountContract = { address: account, abi: mandateAccountAbi } as const;
  const escrowContract = { address: escrow, abi: escrowAbi } as const;
  const assetContract = { address: settlementAsset, abi: settlementAssetAbi } as const;

  function requireRelay(): SpendRelay {
    if (relay === null) {
      throw new ToolError(
        'relay_unconfigured',
        'This server is reading the mandate only. Give it a signer and restart it: BURSAR_SIGNER=local ' +
          'with BURSAR_SIGNER_KEY to sign in this process, or BURSAR_RELAY_URL to sign through one of ' +
          'your own.',
      );
    }

    return relay;
  }

  // The account fixes its escrow and settlement asset at creation and neither can change, so one
  // read serves the whole process. Every tool checks them against this server's configuration,
  // because a spend or a dispute sent through the wrong escrow is not a mistake that shows on
  // screen until the money has moved.
  let wiring: Promise<{ readonly escrow: Address; readonly asset: Address }> | null = null;

  async function assertWired(): Promise<void> {
    wiring ??= client
      .multicall({
        allowFailure: false,
        contracts: [
          { ...accountContract, functionName: 'escrow' },
          { ...accountContract, functionName: 'settlementAsset' },
        ],
      })
      .then(([onChainEscrow, onChainAsset]) => ({ escrow: onChainEscrow, asset: onChainAsset }))
      .catch((error: unknown) => {
        // A failed read is not an answer about the wiring, so the next call asks again.
        wiring = null;
        throw error;
      });

    const wired = await wiring;

    assertWiring(wired.escrow, escrow, 'escrow');
    assertWiring(wired.asset, settlementAsset, 'settlement asset');
  }

  async function inspect(): Promise<MandateView> {
    const [block, reads] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.multicall({
        allowFailure: false,
        contracts: [
          { ...accountContract, functionName: 'principal' },
          { ...accountContract, functionName: 'agent' },
          { ...accountContract, functionName: 'paused' },
          { ...accountContract, functionName: 'revoked' },
          { ...accountContract, functionName: 'version' },
          { ...accountContract, functionName: 'documentHash' },
          { ...accountContract, functionName: 'settlementAsset' },
          { ...accountContract, functionName: 'escrow' },
          { ...accountContract, functionName: 'limits' },
          { ...accountContract, functionName: 'window', args: [DAILY] },
          { ...accountContract, functionName: 'window', args: [MONTHLY] },
          { ...accountContract, functionName: 'merchantGate' },
          { ...accountContract, functionName: 'merchantRoot' },
          { ...escrowContract, functionName: 'minTtl' },
          { ...escrowContract, functionName: 'maxTtl' },
          { ...escrowContract, functionName: 'disputeWindow' },
          { ...escrowContract, functionName: 'disputeTimeoutPeriod' },
          { ...escrowContract, functionName: 'disputeBondBps' },
          { ...escrowContract, functionName: 'feeBps' },
          { ...assetContract, functionName: 'balanceOf', args: [account] },
        ],
      }),
    ]);

    const [
      principal,
      agent,
      paused,
      revoked,
      version,
      documentHash,
      accountAsset,
      accountEscrow,
      limits,
      dailyWindow,
      monthlyWindow,
      gate,
      roster,
      minTtl,
      maxTtl,
      disputeWindow,
      disputeTimeout,
      disputeBondBps,
      feeBps,
      balance,
    ] = reads;

    // Read in the same call as everything else, so inspect costs one request and seeds the check
    // the other tools make.
    wiring ??= Promise.resolve({ escrow: accountEscrow, asset: accountAsset });
    assertWiring(accountEscrow, escrow, 'escrow');
    assertWiring(accountAsset, settlementAsset, 'settlement asset');

    const now = block.timestamp;
    const status = mandateStatus(paused, revoked, limits.validFrom, limits.validUntil, now);
    const daily = windowView(dailyWindow, now);
    const monthly = windowView(monthlyWindow, now);

    return {
      account,
      chainId: client.chain.id,
      status,
      summary: summarize(status, daily, monthly, moneyFromUint(balance).usdg),
      principal,
      agent,
      version: version.toString(),
      balance: moneyFromUint(balance),
      settlementAsset,
      perCallCap: moneyFromUint(limits.perCallCap),
      approvalThreshold: moneyFromUint(limits.approvalThreshold),
      daily,
      monthly,
      validFrom: limits.validFrom === 0n ? null : instant(limits.validFrom),
      // Null is "no expiry" either way: zero is how the contract says it, and a time past the end of
      // the calendar is how a principal who set the largest uint64 said it.
      validUntil: limits.validUntil === 0n ? null : instantOrNull(limits.validUntil),
      providerGate: gate === 0 ? 'allowlist' : 'roster',
      providerRoster: gate === 0 ? null : roster,
      documentHash: isZeroHash(documentHash) ? null : documentHash,
      escrow: {
        address: escrow,
        minTtlSeconds: Number(minTtl),
        maxTtlSeconds: Number(maxTtl),
        disputeWindowSeconds: Number(disputeWindow),
        disputeTimeoutSeconds: Number(disputeTimeout),
        disputeBondBps,
        feeBps,
      },
      observedAt: instant(now),
      blockNumber: block.number.toString(),
    };
  }

  async function quote(request: QuoteRequest): Promise<QuoteView> {
    await assertWired();

    // A label already namespaced is quoted as written; a bare one under the class being quoted.
    const capability =
      classOfLabel(request.capability.trim()) === undefined
        ? spendLabel(request.spendClass ?? 'service', request.capability)
        : request.capability.trim();
    const capabilityId = toCapabilityId(capability);
    const [block, reads] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.multicall({
        allowFailure: false,
        contracts: [
          { ...accountContract, functionName: 'previewSpend', args: [request.provider, capabilityId, request.amount] },
          { ...accountContract, functionName: 'remaining' },
          { ...accountContract, functionName: 'approvalThreshold' },
          { ...assetContract, functionName: 'balanceOf', args: [account] },
          { ...accountContract, functionName: 'window', args: [DAILY] },
          { ...accountContract, functionName: 'window', args: [MONTHLY] },
        ],
      }),
    ]);

    const [[allowed, reason], [perCall, daily, monthly], threshold, balance, dailyWindow, monthlyWindow] = reads;
    const now = block.timestamp;
    const refusal = refusalView(
      refusalForSelector(reason),
      windowView(dailyWindow, now),
      windowView(monthlyWindow, now),
    );
    const approvalRequired = request.amount >= threshold;
    const funded = balance >= request.amount;

    return {
      provider: request.provider,
      capability,
      capabilityId,
      amount: money(request.amount),
      allowed,
      approvalRequired,
      funded,
      refusal,
      remaining: {
        perCall: moneyFromUint(perCall),
        daily: moneyFromUint(daily),
        monthly: moneyFromUint(monthly),
        balance: moneyFromUint(balance),
      },
      next: quoteNext(allowed, refusal, approvalRequired, funded, request.amount, fromUint(balance)),
      observedAt: instant(now),
    };
  }

  /** A payment is a spend in the service class. */
  async function pay(order: PayOrder): Promise<PayView> {
    return spend(order, 'service');
  }

  /**
   * The one spending path. The class decides the namespace of the capability id the lock carries,
   * so a mandate that allows only services refuses a hire on chain.
   */
  async function spend(order: PayOrder, spendClass: SpendClass): Promise<PayView> {
    const submitter = requireRelay();
    await assertWired();
    const capability = spendLabel(spendClass, order.capability);
    const capabilityId = toCapabilityId(capability);
    const canonical = canonicalStringify(order.input);
    const inputBytes = Buffer.byteLength(canonical, 'utf8');

    // The arguments ride to the provider inside the escrow lock as a data URI, and the model writes
    // them. Over the limit the provider refuses the job while the escrow still holds the money, so
    // the funds sit locked until the deadline against an input nobody will ever read.
    if (inputBytes > MAX_JOB_BYTES) {
      throw new ToolError(
        'invalid_arguments',
        `input serialises to ${inputBytes} bytes and a provider reads at most ${MAX_JOB_BYTES}. ` +
          'Send the arguments themselves, not a document: publish anything larger yourself and ' +
          'pass a reference to it.',
        { inputBytes, maxInputBytes: MAX_JOB_BYTES },
      );
    }

    const [block, reads] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.multicall({
        allowFailure: false,
        contracts: [
          { ...accountContract, functionName: 'previewSpend', args: [order.provider, capabilityId, order.amount] },
          { ...accountContract, functionName: 'merchantGate' },
          { ...escrowContract, functionName: 'minTtl' },
          { ...escrowContract, functionName: 'maxTtl' },
          { ...assetContract, functionName: 'balanceOf', args: [account] },
          { ...accountContract, functionName: 'window', args: [DAILY] },
          { ...accountContract, functionName: 'window', args: [MONTHLY] },
        ],
      }),
    ]);

    const [[, reason], gate, minTtl, maxTtl, balance, dailyWindow, monthlyWindow] = reads;

    // The escrow bounds the delivery window on both sides, so a job cannot be created that is
    // impossible to answer or that ties the mandate's funds up indefinitely.
    const floor = minTtl + DEADLINE_MARGIN_SECONDS;

    if (BigInt(order.ttlSeconds) < floor || BigInt(order.ttlSeconds) >= maxTtl) {
      throw new ToolError(
        'invalid_arguments',
        `deliverWithinSeconds has to sit between ${floor.toString()} and ` +
          `${(maxTtl - 1n).toString()} for this escrow.`,
        { minTtlSeconds: Number(floor), maxTtlSeconds: Number(maxTtl - 1n) },
      );
    }

    if (gate === 0 && order.providerProof.length > 0) {
      throw new ToolError(
        'mandate_refused',
        'This mandate lists providers by address, so pay without a provider proof.',
        { revert: 'AllowlistGateActive', subject: 'provider' },
      );
    }

    // The quote runs here as well as in `mandate_quote_spend`, because a refused spend that reaches
    // the signer costs gas to revert and an agent may have skipped the quote. Two answers are not
    // refusals: consent that the caller is carrying, and a provider the quote cannot see because
    // the roster is off chain.
    const refusal = refusalView(
      refusalForSelector(reason),
      windowView(dailyWindow, block.timestamp),
      windowView(monthlyWindow, block.timestamp),
    );
    const carried =
      (refusal?.code === 'ApprovalRequired' && order.approval !== null) ||
      (refusal?.code === 'MerkleGateActive' && order.providerProof.length > 0);

    if (refusal && !carried) {
      throw new ToolError('mandate_refused', refusal.message, {
        revert: refusal.code,
        subject: refusal.subject,
        ...(refusal.resetsAt === undefined
          ? {}
          : { resetsAt: refusal.resetsAt, resetsInSeconds: refusal.resetsInSeconds }),
      });
    }

    const amount = money(order.amount);

    if (balance < order.amount) {
      throw new ToolError(
        'mandate_underfunded',
        `The mandate holds ${moneyFromUint(balance).usdg} USDG and this spend needs ${amount.usdg}. The limits ` +
          'allow it, so what is missing is a deposit from the principal.',
        { balance: moneyFromUint(balance).micro, amount: amount.micro },
      );
    }

    const inputCommit = commitCanonical(order.input);
    const inputURI = toDataUri(canonical);
    const deadline = block.timestamp + BigInt(order.ttlSeconds);
    const receipt = await submitter.spend({
      mandateAccount: account,
      merchant: order.provider,
      capabilityId,
      inputCommit,
      inputURI,
      amount: amount.micro,
      deadline: deadline.toString(),
      merchantProof: order.providerProof,
      approval: order.approval === null ? null : toRelayApproval(order.approval, order.provider, capabilityId),
    });

    return {
      settlementId: receipt.escrowId.toString(),
      txHash: receipt.txHash,
      provider: order.provider,
      capability,
      capabilityId,
      amount,
      inputCommit,
      inputURI,
      deliverBy: instant(deadline),
      status: 'held',
      next:
        `The escrow holds ${amount.usdg} USDG for the provider until ${instant(deadline)}. ` +
        `Read settlement ${receipt.escrowId.toString()} to see whether it was delivered and paid.`,
    };
  }

  /**
   * Hiring another agent is paying a provider under the same limits and refusals. What it adds is
   * the brief (task, arguments, acceptance) in the one canonical form both halves hash, committed
   * and published with the payment.
   *
   * It runs through `pay` rather than beside it, so there is one spending path and one refusal
   * taxonomy, and a job document can never be locked under rules a payment would not have been.
   */
  async function hire(order: HireOrder): Promise<HireView> {
    const document = jobDocument(order.spec);
    const view = await spend({
      provider: order.provider,
      capability: order.capability,
      input: document as unknown as Record<string, unknown>,
      amount: order.budget,
      ttlSeconds: order.ttlSeconds,
      providerProof: order.providerProof,
      approval: order.approval,
    }, 'hire');

    return {
      ...view,
      jobId: view.settlementId,
      task: document.task,
      specCommit: view.inputCommit,
      next:
        `The escrow holds ${view.amount.usdg} USDG against this brief until ${view.deliverBy}. The ` +
        `provider is paid by committing to what it delivered, which releases the funds in the same ` +
        `transaction. Read settlement ${view.settlementId} to see whether that happened, and check ` +
        'the delivered bytes against the commitment it reports before treating the job as done.',
    };
  }

  async function settlements(query: SettlementsQuery): Promise<SettlementsView> {
    await assertWired();

    const head = await client.getBlock({ blockTag: 'latest' });
    const to = query.beforeBlock === null ? head.number : minBigint(query.beforeBlock, head.number);

    // Read the mandate's own Spent log, not the escrow's. The history then stays one address wide
    // however busy the escrow is.
    const page = await options.index.logsOf(account, { before: to, maxRows: rowsFor(query.limit) });
    const spends = toSpendLogs(page.logs);

    const found: SpendLog[] = [];

    for (const entry of spends) {
      // The page runs past `limit` to finish the block it is in. A cursor names a block, so a cut
      // inside one would drop whatever shared it.
      if (found.length >= query.limit && entry.block !== found[found.length - 1]?.block) break;

      found.push(entry);
    }

    const stoppedOnLimit = found.length < spends.length;
    const more = stoppedOnLimit || page.truncated;
    const last = found[found.length - 1];

    // What this reply covers, completely. Stopping on the caller's limit leaves the history whole
    // down to the last block reported; stopping on the index's page ceiling leaves it whole down to
    // the oldest row read, which may hold no settlement at all.
    const floor = stoppedOnLimit ? (last?.block ?? to) : (page.oldestBlock ?? to);

    const locks =
      found.length === 0
        ? []
        : await client.multicall({
            allowFailure: false,
            contracts: found.map(
              (entry) => ({ ...escrowContract, functionName: 'getLock', args: [entry.id] }) as const,
            ),
          });

    const rows: SettlementView[] = [];

    for (const [index, entry] of found.entries()) {
      const lock = locks[index];

      if (lock === undefined) continue;

      const status = statusOf(lock.status);

      rows.push({
        settlementId: entry.id.toString(),
        provider: entry.provider,
        capabilityId: entry.capabilityId,
        amount: moneyFromUint(entry.amount),
        status,
        funds: FUNDS[status],
        deliverBy: instant(lock.deadline),
        paidAtBlock: entry.block.toString(),
        txHash: entry.tx,
      });
    }

    const next = floor - 1n;

    return {
      settlements: rows,
      scannedFromBlock: more ? floor.toString() : '0',
      scannedToBlock: to.toString(),
      cursor: more && next >= 0n ? next.toString() : null,
      observedAt: instant(head.timestamp),
    };
  }

  async function settlement(settlementId: bigint): Promise<SettlementDetailView> {
    await assertWired();

    const [block, reads] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.multicall({
        allowFailure: false,
        contracts: [
          { ...escrowContract, functionName: 'getLock', args: [settlementId] },
          { ...escrowContract, functionName: 'disputeWindow' },
          { ...escrowContract, functionName: 'disputeTimeoutPeriod' },
          { ...accountContract, functionName: 'creditable', args: [settlementId] },
        ],
      }),
    ]);

    const [lock, disputeWindow, disputeTimeout, creditable] = reads;
    const status = statusOf(lock.status);

    if (status === 'unknown') {
      throw new ToolError('unknown_settlement', `No settlement carries id ${settlementId.toString()}.`);
    }

    // An id names a lock in the escrow, which is shared. A lock this mandate did not open is
    // somebody else's business and is not reported here.
    if (lock.payer.toLowerCase() !== account.toLowerCase()) {
      throw new ToolError(
        'unknown_settlement',
        `Settlement ${settlementId.toString()} was not paid for by this mandate.`,
      );
    }

    const now = block.timestamp;
    const released = lock.releasedAt === 0n ? null : lock.releasedAt;
    const disputableUntil = released === null ? null : released + BigInt(disputeWindow);
    const dispute: DisputeView | null =
      lock.disputedAt === 0n
        ? null
        : {
            openedAt: instant(lock.disputedAt),
            openedBy: lock.disputer,
            bond: moneyFromUint(lock.bond),
            resolveBy: instant(lock.disputedAt + BigInt(disputeTimeout)),
            note:
              'The resolver rules on the split. If no ruling lands by resolveBy, the held funds and the bond come ' +
              'back to the mandate.',
          };

    return {
      settlementId: settlementId.toString(),
      provider: lock.payee,
      payer: lock.payer,
      capabilityId: lock.capabilityId,
      amount: moneyFromUint(lock.amount),
      status,
      funds: FUNDS[status],
      deliverBy: instant(lock.deadline),
      inputCommit: lock.inputCommit,
      inputURI: lock.inputURI,
      outputCommit: isZeroHash(lock.outputCommit) ? null : lock.outputCommit,
      outputURI: lock.outputURI === '' ? null : lock.outputURI,
      deliveredAt: released === null ? null : instant(released),
      disputableUntil: disputableUntil === null ? null : instant(disputableUntil),
      refundableFrom: status === 'held' ? instant(lock.deadline) : null,
      refundableToMandate: moneyFromUint(refundable(status, lock.amount, creditable)),
      dispute,
      next: settlementNext(status, lock.deadline, disputableUntil, now),
      observedAt: instant(now),
    };
  }

  async function openDispute(settlementId: bigint): Promise<DisputeReceiptView> {
    const submitter = requireRelay();
    await assertWired();
    const [block, reads] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.multicall({
        allowFailure: false,
        contracts: [
          { ...escrowContract, functionName: 'getLock', args: [settlementId] },
          { ...escrowContract, functionName: 'disputeWindow' },
          { ...escrowContract, functionName: 'disputeBondBps' },
          { ...escrowContract, functionName: 'resolver' },
          { ...assetContract, functionName: 'balanceOf', args: [account] },
        ],
      }),
    ]);

    const [lock, disputeWindow, bondBps, resolver, balance] = reads;
    const bond = assertContestable(settlementId, lock, {
      account,
      now: block.timestamp,
      disputeWindow: BigInt(disputeWindow),
      bondBps,
      resolver,
      balance,
    });

    const receipt = await submitter.dispute({ mandateAccount: account, escrowId: settlementId });

    return {
      settlementId: settlementId.toString(),
      txHash: receipt.txHash,
      status: 'disputed',
      next:
        `The mandate posted a bond of ${moneyFromUint(bond).usdg} USDG and the resolver now rules on the split. ` +
        'Read the settlement for the ruling and for the time by which it has to land.',
    };
  }

  /**
   * The dispute against one settlement, and the ruling once there is one.
   *
   * Two different things are called a dispute and the difference is where the money is. While the
   * escrow still holds it, contesting hands the split to bonded resolvers and costs a bond. Once
   * the provider has been paid there is nothing left to split, so the complaint is recorded
   * against the provider's history and no resolver ever votes on it. Both are reported, and
   * neither is described as the other.
   */
  async function dispute(settlementId: bigint): Promise<DisputeDetailView> {
    await assertWired();

    const [block, reads] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.multicall({
        allowFailure: false,
        contracts: [
          { ...escrowContract, functionName: 'getLock', args: [settlementId] },
          { ...escrowContract, functionName: 'resolver' },
          { ...escrowContract, functionName: 'feeBps' },
          { ...escrowContract, functionName: 'resolverFeeBps' },
          { ...escrowContract, functionName: 'disputeBondBps' },
          { ...escrowContract, functionName: 'disputeTimeoutPeriod' },
        ],
      }),
    ]);

    const [lock, registry, feeBps, resolverFeeBps, disputeBondBps, disputeTimeout] = reads;
    const status = statusOf(lock.status);

    if (status === 'unknown') {
      throw new ToolError('unknown_settlement', `No settlement carries id ${settlementId.toString()}.`);
    }

    if (lock.payer.toLowerCase() !== account.toLowerCase()) {
      throw new ToolError(
        'unknown_settlement',
        `Settlement ${settlementId.toString()} was not paid for by this mandate.`,
      );
    }

    if (lock.disputedAt === 0n) {
      throw new ToolError(
        'not_disputed',
        `Nobody has contested settlement ${settlementId.toString()}. mandate_get_settlement reports ` +
          'where it stands and whether the window to contest it is still open.',
        { settlementId: settlementId.toString() },
      );
    }

    // A complaint raised after the provider was paid never reaches a resolver: the escrow records
    // it against the provider's history and closes the settlement in the same call.
    const recordOnly = lock.releasedAt !== 0n;
    const hasResolver = !/^0x0+$/u.test(registry);

    const disputeId =
      recordOnly || !hasResolver
        ? 0n
        : await client.readContract({
            address: registry,
            abi: oracleRegistryAbi,
            functionName: 'disputeIdOf',
            args: [settlementId],
          });

    const [vote, config] =
      disputeId === 0n
        ? [null, null]
        : await client.multicall({
            allowFailure: false,
            contracts: [
              { address: registry, abi: oracleRegistryAbi, functionName: 'getDispute', args: [disputeId] },
              { address: registry, abi: oracleRegistryAbi, functionName: 'config' },
            ],
          });

    // The escrow zeroes the bond the moment a ruling returns or forfeits it, so what was actually
    // posted is recomputed from the rate rather than read off a settled lock.
    const bond = recordOnly ? 0n : (lock.amount * BigInt(disputeBondBps)) / BPS;

    const ruling: DisputeRulingView | null =
      vote !== null && vote.status === DISPUTE_PHASE.Finalized
        ? rulingOf(lock, vote.medianScore, vote.refundBps, { feeBps, resolverFeeBps })
        : null;

    const phase = vote === null ? 'none' : phaseName(vote.status);

    return {
      settlementId: settlementId.toString(),
      disputeId: disputeId.toString(),
      phase,
      openedAt: instant(lock.disputedAt),
      openedBy: lock.disputer,
      bond: moneyFromUint(bond),
      amount: moneyFromUint(lock.amount),
      provider: lock.payee,
      recordOnly,
      commitEndsAt: vote === null ? null : instant(vote.commitEndsAt),
      revealEndsAt: vote === null ? null : instant(vote.revealEndsAt),
      commitCount: vote?.commitCount ?? 0,
      revealCount: vote?.revealCount ?? 0,
      quorum: config?.quorum ?? 0,
      resolveBy: recordOnly ? null : instant(lock.disputedAt + BigInt(disputeTimeout)),
      ruling,
      settlementStatus: status,
      next: disputeNext({ phase, recordOnly, ruling, status, hasResolver }),
      observedAt: instant(block.timestamp),
    };
  }

  return { inspect, quote, pay, hire, settlements, settlement, openDispute, dispute };
}

/**
 * How a ruling cut the settlement, derived exactly as `Escrow._split` derives it. The resolver fee
 * comes off the top, the refund splits what is left, and the protocol fee is charged only on the
 * provider's share, so the four legs add back up to the locked amount with nothing over.
 */
function rulingOf(
  lock: { amount: bigint; payer: Address; disputer: Address },
  medianScore: number,
  refundBps: number,
  rates: { feeBps: number; resolverFeeBps: number },
): DisputeRulingView {
  const split = splitOf(lock.amount, refundBps, rates);
  const vindicated =
    lock.disputer.toLowerCase() === lock.payer.toLowerCase()
      ? refundBps >= HALF_BPS
      : refundBps <= HALF_BPS;

  return {
    medianScore,
    refundBps,
    refundedToMandate: moneyFromUint(split.refunded),
    paidToProvider: moneyFromUint(split.paid),
    resolverFee: moneyFromUint(split.resolverFee),
    protocolFee: moneyFromUint(split.protocolFee),
    bondReturned: vindicated,
  };
}

/**
 * What comes back to the mandate if this settlement ends in its favour, as money.
 *
 * The account's `creditable` is not that figure and cannot be reported as it. It is the budget the
 * spend still has committed, and the escrow only clears it when funds actually return, so a lock
 * the provider was paid out of keeps its full commitment for good. Reading it as money is how a
 * finished payment came to be reported as paid and refundable in the same object. Once the escrow
 * has moved the funds, nothing is refundable, whatever the budget still carries.
 */
function refundable(status: SettlementStatus, held: bigint, committed: bigint): bigint {
  if (status !== 'held' && status !== 'disputed') return 0n;

  return minBigint(held, committed);
}

type EscrowLock = {
  payer: Address;
  amount: bigint;
  releasedAt: bigint;
  status: number;
};

type ContestTerms = {
  account: Address;
  now: bigint;
  disputeWindow: bigint;
  bondBps: number;
  resolver: Address;
  balance: bigint;
};

/**
 * Checks what the escrow would check, and answers with the bond the mandate is about to post.
 *
 * A dispute the escrow would reject still costs gas, and one it would accept costs the bond. The
 * agent sees both figures before the transaction, not after it.
 */
function assertContestable(settlementId: bigint, lock: EscrowLock, terms: ContestTerms): bigint {
  const status = statusOf(lock.status);

  if (status === 'unknown') {
    throw new ToolError('unknown_settlement', `No settlement carries id ${settlementId.toString()}.`);
  }

  if (lock.payer.toLowerCase() !== terms.account.toLowerCase()) {
    throw new ToolError('unknown_settlement', `Settlement ${settlementId.toString()} was not paid for by this mandate.`);
  }

  if (status === 'paid') {
    const closes = lock.releasedAt + terms.disputeWindow;

    if (terms.disputeWindow === 0n || terms.now > closes) {
      throw new ToolError(
        'not_contestable',
        `The window to contest settlement ${settlementId.toString()} closed at ${instant(closes)}. The payment ` +
          'is final.',
      );
    }

    // A complaint about work already paid for is recorded against the provider, never ruled on.
    // The escrow charges nothing for it.
    return 0n;
  }

  if (status !== 'held') {
    throw new ToolError('not_contestable', `Settlement ${settlementId.toString()} is ${status}. ${FUNDS[status]}`);
  }

  if (/^0x0+$/u.test(terms.resolver)) {
    throw new ToolError(
      'not_contestable',
      'This escrow has no resolver, so a dispute has nobody to hear it. A job that is never delivered is still ' +
        'refunded once its delivery deadline passes.',
    );
  }

  // Truncating division, matching the escrow, so the figure quoted here is the figure charged.
  const bond = (lock.amount * BigInt(terms.bondBps)) / 10_000n;

  if (terms.balance < bond) {
    throw new ToolError(
      'mandate_underfunded',
      `Contesting this posts a bond of ${moneyFromUint(bond).usdg} USDG and the mandate holds ` +
        `${moneyFromUint(terms.balance).usdg}. Ask the principal to fund the mandate first.`,
      { bond: moneyFromUint(bond).micro, balance: moneyFromUint(terms.balance).micro },
    );
  }

  return bond;
}

type SpendLog = {
  readonly id: bigint;
  readonly provider: Address;
  readonly capabilityId: Hex;
  readonly amount: bigint;
  readonly block: bigint;
  readonly tx: Hex;
};

const SPENT_TOPIC = encodeEventTopics({ abi: mandateAccountAbi, eventName: 'Spent' })[0];

/**
 * How many index rows are read per settlement asked for.
 *
 * An account writes more than one line per payment: the spend, the credit when funds come back,
 * and whatever the principal changed in between. Four rows a settlement covers that without
 * turning a ten-row listing into four requests, and the reply carries a cursor either way.
 */
const ROWS_PER_SETTLEMENT = 4;
const MAX_INDEX_ROWS = 200;

function rowsFor(limit: number): number {
  return Math.min(MAX_INDEX_ROWS, limit * ROWS_PER_SETTLEMENT + 1);
}

/**
 * The spends in one page of the account's log, newest first.
 *
 * The account writes several kinds of line and only one of them is a payment, so the rest are
 * dropped here. A row the index mangled costs that row and not the listing: the caller is waiting
 * on a settlement, and one unreadable line is no reason to answer with nothing.
 */
function toSpendLogs(logs: readonly IndexedLog[]): readonly SpendLog[] {
  const spends: SpendLog[] = [];

  for (const log of logs) {
    const [signature, ...rest] = log.topics;

    if (signature === undefined || signature.toLowerCase() !== SPENT_TOPIC.toLowerCase()) continue;

    try {
      const { args } = decodeEventLog({
        abi: mandateAccountAbi,
        eventName: 'Spent',
        topics: [signature, ...rest],
        data: log.data,
      });

      spends.push({
        id: args.escrowId,
        provider: args.merchant,
        capabilityId: args.capabilityId,
        amount: args.amount,
        block: log.blockNumber,
        tx: log.transactionHash,
      });
    } catch {
      continue;
    }
  }

  return spends;
}

function assertWiring(onChain: Address, configured: Address, label: string): void {
  if (onChain.toLowerCase() === configured.toLowerCase()) return;

  throw new ToolError(
    'config_mismatch',
    `This mandate settles through a different ${label} than this server is configured for, so nothing ` +
      'was sent. Check MANDATE_ACCOUNT, MANDATE_ESCROW and BURSAR_SETTLEMENT_ASSET, then restart the server.',
    { onChain, configured },
  );
}

function isZeroHash(value: Hex): boolean {
  return /^0x0*$/u.test(value);
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** The namespaced label a spend in `spendClass` carries, or an argument error the agent can act on. */
function spendLabel(spendClass: SpendClass, label: string): string {
  try {
    return classLabel(spendClass, label);
  } catch (error) {
    if (error instanceof SpendClassError) {
      throw new ToolError('invalid_arguments', error.message, { ...error.details });
    }
    throw error;
  }
}
