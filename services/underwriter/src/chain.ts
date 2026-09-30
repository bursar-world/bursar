import {
  CURRENT_CONTRACT_SET,
  type ContractSet,
  type Micro,
  type RhcPublicClient,
  agentRegistryAbi,
  contractSetOfEscrow,
  escrowAbi,
  mandateAccountAbi,
  mandateAccountAbiV1,
  micro,
  reputationAbi,
  settlementAssetAbi,
} from '@bursar/core';
import { encodeFunctionData, zeroAddress } from 'viem';

import type { Address, Hex32 } from './document.js';
import { ChainUnavailableError } from './errors.js';
import { type Selector, ZERO_SELECTOR } from './selectors.js';

export type ChainWindow = {
  readonly capMicros: Micro;
  readonly spentMicros: Micro;
  readonly seconds: number;
  readonly startSeconds: bigint;
  readonly epoch: bigint;
};

export type ChainLimits = {
  readonly perCallCapMicros: Micro;
  readonly dailyCapMicros: Micro;
  readonly monthlyCapMicros: Micro;
  readonly dailyWindowSeconds: number;
  readonly monthlyWindowSeconds: number;
  readonly approvalThresholdMicros: Micro;
  readonly validFrom: bigint;
  readonly validUntil: bigint;
  /** Not on v1: the classes the mandate allows, one bit per class (0 service, 1 hire, 2 rwa). */
  readonly classMask?: number;
  /** Not on v1: the lifetime total, zero for none. */
  readonly totalCapMicros?: Micro;
  /** Not on v1: the settlement lane (0 escrow, 1 treasury, 2 collateral). */
  readonly lane?: number;
};

export type ChainMerchantGate = { readonly kind: 'allowlist' } | { readonly kind: 'merkleRoot'; readonly root: Hex32 };

/**
 * What the MandateAccount says about itself right now. This is the source of truth the document
 * is measured against; nothing here is inferred from the document.
 */
export type AccountState = {
  readonly account: Address;
  readonly principal: Address;
  readonly agent: Address;
  readonly settlementAsset: Address;
  readonly escrow: Address;
  /** Which contract build the account runs, known from its escrow. Absent reads as the current one. */
  readonly contractSet?: ContractSet;
  readonly paused: boolean;
  readonly revoked: boolean;
  readonly version: bigint;
  readonly nonce: bigint;
  readonly documentHash: Hex32;
  readonly limits: ChainLimits;
  readonly daily: ChainWindow;
  readonly monthly: ChainWindow;
  readonly remaining: { readonly perCall: Micro; readonly daily: Micro; readonly monthly: Micro };
  readonly merchantGate: ChainMerchantGate;
  /** Settlement-asset balance held by the account, in the same six decimals as every cap. */
  readonly balanceMicros: Micro;
};

export type EscrowTerms = {
  readonly escrow: Address;
  readonly settlementAsset: Address;
  readonly reputation: Address;
  readonly registry: Address | null;
  readonly minTtlSeconds: bigint;
  readonly maxTtlSeconds: bigint;
  /**
   * The smallest lock the escrow opens. An escrow before v3 refuses only an empty lock, so its
   * floor is one micro-USDG and it is never asked: it has no getter to answer with.
   */
  readonly minLockMicros: Micro;
  readonly feeBps: number;
  readonly disputeBondBps: number;
};

export type MerchantStanding = {
  readonly merchant: Address;
  readonly active: boolean;
  readonly blacklisted: boolean;
  /** The reputation cap: the largest single lock the escrow will open in this merchant's favour. */
  readonly capMicros: Micro;
};

/**
 * One answer from the settlement asset about one of its own controls.
 *
 * Three states rather than two, because "did not answer" is two different facts. USDG is a diamond
 * proxy: a selector it routes to no facet reverts `FacetNotFound`, which says the control has left
 * the token, while a read that times out says nothing about the token at all. Both refuse a spend.
 * One needs somebody to look at what the token exposes now, the other needs the chain back.
 */
export type ControlReading =
  | { readonly state: 'read'; readonly value: boolean }
  | { readonly state: 'absent'; readonly detail: string }
  | { readonly state: 'unreadable'; readonly detail: string };

export type PartyControl = { readonly address: Address; readonly frozen: ControlReading };

/**
 * What the token issuer says about this spend: whether the asset moves at all, and whether these
 * parties may move it. Neither is the principal's to set and neither is this service's.
 */
export type IssuerControls = {
  readonly asset: Address;
  readonly paused: ControlReading;
  /** One reading per party asked about, in the order they were asked. */
  readonly parties: readonly PartyControl[];
};

export type PreviewResult = { readonly allowed: boolean; readonly selector: Selector };

export type SimulationResult = { readonly ok: true } | { readonly ok: false; readonly selector: Selector | null };

export type SpendCall = {
  readonly account: Address;
  readonly agent: Address;
  readonly merchant: Address;
  readonly capabilityId: Hex32;
  readonly inputCommit: Hex32;
  readonly inputURI: string;
  readonly amountMicros: Micro;
  readonly deadline: bigint;
  readonly merchantProof: readonly Hex32[];
  /** Not on v1: 0 service, 1 hire. Checked against the mandate's class mask. */
  readonly spendClass?: number;
  readonly blockNumber?: bigint;
};

/**
 * `IEscrow.LockStatus`, by the uint8 the contract returns. Only the states that have handed money
 * back to the payer are named, because those are the only ones a refund is recorded against.
 */
export const ESCROW_REFUNDED_STATUSES: ReadonlyMap<number, string> = new Map([
  [3, 'TimedOut'],
  [5, 'Cancelled'],
  [6, 'Resolved'],
]);

/** One escrow lock as the chain holds it, reduced to what a refund is checked against. */
export type EscrowLock = {
  readonly id: bigint;
  readonly payer: Address;
  readonly amountMicros: Micro;
  readonly status: number;
};

/** A block as one reading, so the height a decision was taken at travels with its clock. */
export type BlockRef = { readonly number: bigint; readonly timestamp: bigint };

/**
 * The chain reads the underwriter depends on. It is an interface, so a decision can be tested
 * against every state a MandateAccount can hold without deploying one, and so a caller can put a
 * cache or a multicall in front of it.
 *
 * Every read takes the height it is to be answered at. A decision is a statement about one block:
 * the version it names, the headroom it reports and the verdict it acts on all have to come from
 * the same state, or the journal entry describes limits that never decided anything.
 */
export type MandateChain = {
  readAccount(account: Address, blockNumber?: bigint): Promise<AccountState>;
  previewSpend(
    account: Address,
    merchant: Address,
    capabilityId: Hex32,
    amountMicros: Micro,
    blockNumber?: bigint,
    spendClass?: number,
  ): Promise<PreviewResult>;
  readEscrowTerms(escrow: Address, blockNumber?: bigint): Promise<EscrowTerms>;
  /**
   * `paused()` on the settlement asset and `isFrozen(address)` on each party, at the same height
   * as every other read a decision rests on.
   *
   * It never throws. A control that refuses to answer is a reading of its own, because the
   * decision has to tell a facet the token no longer routes from a chain that did not come back,
   * and those two are fixed by different people.
   */
  readIssuerControls(
    asset: Address,
    parties: readonly Address[],
    blockNumber?: bigint,
  ): Promise<IssuerControls>;
  readMerchantStanding(terms: EscrowTerms, merchant: Address, blockNumber?: bigint): Promise<MerchantStanding>;
  /**
   * The account's own roster entries. Read for reconciliation, never to decide: `previewSpend`
   * already applied them, and these tell the operator whether the document agrees.
   */
  readMerchantAllowed(account: Address, merchant: Address, blockNumber?: bigint): Promise<boolean>;
  readCapabilityAllowed(account: Address, capabilityId: Hex32, blockNumber?: bigint): Promise<boolean>;
  /** Latest block timestamp, in unix seconds. The clock the contract's own checks run against. */
  blockTimestamp(): Promise<bigint>;
  /**
   * The head, number and timestamp together, which is what lets a quote pin its reads. An
   * implementation that cannot name a height leaves this out and its reads answer wherever the
   * pool routes them; the shipped client always can.
   */
  latestBlock?(): Promise<BlockRef>;
  simulateSpend(call: SpendCall): Promise<SimulationResult>;
  /**
   * One lock off the escrow. Optional so an injected chain written before refunds were checked
   * still compiles; without it every refund is refused, because a refund nobody can check against
   * the chain is a credit taken on the caller's word.
   */
  readEscrowLock?(escrow: Address, id: bigint): Promise<EscrowLock>;
  /** `decimals()` on the settlement asset. Every amount here assumes six. */
  readAssetDecimals?(asset: Address): Promise<number>;
};

function toWindow(raw: { cap: bigint; spent: bigint; duration: bigint; start: bigint; epoch: bigint }): ChainWindow {
  return {
    capMicros: micro(raw.cap),
    spentMicros: micro(raw.spent),
    seconds: Number(raw.duration),
    startSeconds: raw.start,
    epoch: raw.epoch,
  };
}

/**
 * Walks an error chain for revert bytes. viem, the RPC pool and the node each wrap the payload
 * differently, and the selector is the whole answer. This looks for it wherever it landed.
 */
export function revertSelector(error: unknown): Selector | null {
  const seen = new Set<unknown>();
  let cursor: unknown = error;

  while (cursor !== null && typeof cursor === 'object' && !seen.has(cursor)) {
    seen.add(cursor);
    const data = (cursor as { data?: unknown }).data;
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8}/.test(data)) {
      return data.slice(0, 10).toLowerCase() as Selector;
    }
    if (data !== null && typeof data === 'object') {
      const nested = (data as { data?: unknown }).data;
      if (typeof nested === 'string' && /^0x[0-9a-fA-F]{8}/.test(nested)) {
        return nested.slice(0, 10).toLowerCase() as Selector;
      }
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }

  return null;
}

/** What a diamond answers for a selector none of its facets declare. Read from USDG on 4663. */
export const FACET_NOT_FOUND: Selector = '0x800ab12c';

/**
 * Every sentence and every revert payload an error chain carries, lowercased into one string.
 *
 * `revertSelector` finds the four bytes when the node returns them. This finds the name when the
 * node decoded it instead, which is the other half of the same question.
 */
function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cursor: unknown = error;

  while (cursor !== null && cursor !== undefined && typeof cursor === 'object' && !seen.has(cursor)) {
    seen.add(cursor);
    const record = cursor as Record<string, unknown>;
    for (const field of ['shortMessage', 'message', 'details', 'reason'] as const) {
      const value = record[field];
      if (typeof value === 'string') parts.push(value);
    }
    cursor = record['cause'];
  }

  return parts.join(' ').toLowerCase();
}

/**
 * Why a control read failed, as a reading rather than as a throw.
 *
 * The selector is checked first because it is the token's own answer. The name is checked too,
 * since a node that decodes the error hands back `FacetNotFound` and never the four bytes.
 */
export function controlFailure(error: unknown): ControlReading {
  const detail = errorLine(error);
  return revertSelector(error) === FACET_NOT_FOUND || errorText(error).includes('facetnotfound')
    ? { state: 'absent', detail }
    : { state: 'unreadable', detail };
}

/** Whatever a chain client threw, in one line a refusal can carry. */
function errorLine(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const short = record['shortMessage'];
    if (typeof short === 'string' && short.length > 0) return short;
    const message = record['message'];
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return String(error);
}

/**
 * An address with no code at it answers a call with empty data. viem raises this, and every read
 * of every function on that address raises it the same way. It is the shape a mistyped or
 * wrong-network address takes, and it is worth telling apart from a chain that is down: one is
 * fixed by editing a variable, the other by waiting or changing provider.
 */
function isNoContract(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (cursor !== null && typeof cursor === 'object' && !seen.has(cursor)) {
    seen.add(cursor);
    const candidate = cursor as { name?: unknown; message?: unknown; cause?: unknown };
    if (candidate.name === 'ContractFunctionZeroDataError') return true;
    if (typeof candidate.message === 'string' && candidate.message.includes('returned no data ("0x")')) return true;
    cursor = candidate.cause;
  }
  return false;
}

export function createMandateChain(client: RhcPublicClient): MandateChain {
  /**
   * Every chain read goes through here, and every failure leaves as this service's own sentence.
   *
   * What a caller gets told is what happened and what to do about it. The library's message is
   * kept on `cause` for the log: it is written for whoever is debugging viem, it carries a
   * documentation link to a project the customer is not using, and it names internals that are
   * this service's business.
   */
  const read = async <T>(work: () => Promise<T>, what: string, address?: Address): Promise<T> => {
    try {
      return await work();
    } catch (cause) {
      const where = address === undefined ? {} : { address };
      throw isNoContract(cause)
        ? new ChainUnavailableError(
            `could not read ${what}: no contract at ${address ?? 'that address'} on ${client.chain.name}, chain ${client.chain.id}, answers that call. Either nothing is deployed there, or the address is for a different contract.`,
            { what, ...where, chainId: client.chain.id },
            cause,
          )
        : new ChainUnavailableError(
            `could not read ${what}: ${client.chain.name}, chain ${client.chain.id}, did not answer`,
            { what, ...where, chainId: client.chain.id },
            cause,
          );
    }
  };

  // An account's escrow is immutable, so which build it runs is read once. An escrow no record
  // names is taken as the current build.
  const sets = new Map<string, ContractSet>();
  const contractSet = async (account: Address): Promise<ContractSet> => {
    const known = sets.get(account.toLowerCase());
    if (known !== undefined) return known;
    const escrow = (await client.readContract({
      address: account,
      abi: mandateAccountAbi,
      functionName: 'escrow',
    })) as Address;
    const set = contractSetOfEscrow(escrow) ?? CURRENT_CONTRACT_SET;
    sets.set(account.toLowerCase(), set);
    return set;
  };

  /** Spread into every read, so one decision's reads cannot straddle two heights. */
  const at = (blockNumber: bigint | undefined): { blockNumber?: bigint } =>
    blockNumber === undefined ? {} : { blockNumber };

  const readAccount: MandateChain['readAccount'] = async (account, blockNumber) =>
    read(async () => {
      // `limits` is the one getter whose shape differs between builds: v2 appended the class mask,
      // the lifetime total and the lane, and a v1 account's eight words do not decode as eleven.
      // v3 accounts keep the v2 shape. Every other getter read here is the same in all three, so
      // the build decides only the ABI.
      const set = await contractSet(account);
      const call = <const T extends string>(functionName: T, args?: readonly unknown[]) =>
        client.readContract({
          address: account,
          abi: set === 'v1' ? mandateAccountAbiV1 : mandateAccountAbi,
          functionName,
          ...(args === undefined ? {} : { args }),
          ...at(blockNumber),
        } as never);

      const [
        principal,
        agent,
        settlementAsset,
        escrow,
        paused,
        revoked,
        version,
        nonce,
        documentHash,
        limits,
        daily,
        monthly,
        remaining,
        gate,
        merchantRoot,
      ] = (await Promise.all([
        call('principal'),
        call('agent'),
        call('settlementAsset'),
        call('escrow'),
        call('paused'),
        call('revoked'),
        call('version'),
        call('nonce'),
        call('documentHash'),
        call('limits'),
        call('window', [0]),
        call('window', [1]),
        call('remaining'),
        call('merchantGate'),
        call('merchantRoot'),
      ])) as [
        Address,
        Address,
        Address,
        Address,
        boolean,
        boolean,
        bigint,
        bigint,
        Hex32,
        {
          perCallCap: bigint;
          dailyCap: bigint;
          monthlyCap: bigint;
          dailyWindow: bigint;
          monthlyWindow: bigint;
          approvalThreshold: bigint;
          validFrom: bigint;
          validUntil: bigint;
          classMask?: number;
          totalCap?: bigint;
          lane?: number;
        },
        { cap: bigint; spent: bigint; duration: bigint; start: bigint; epoch: bigint },
        { cap: bigint; spent: bigint; duration: bigint; start: bigint; epoch: bigint },
        readonly [bigint, bigint, bigint],
        number,
        Hex32,
      ];

      const balance = (await client.readContract({
        address: settlementAsset,
        abi: settlementAssetAbi,
        functionName: 'balanceOf',
        args: [account],
        ...at(blockNumber),
      })) as bigint;

      return {
        account,
        principal,
        agent,
        settlementAsset,
        escrow,
        contractSet: set,
        paused,
        revoked,
        version,
        nonce,
        documentHash: documentHash.toLowerCase() as Hex32,
        limits: {
          perCallCapMicros: micro(limits.perCallCap),
          dailyCapMicros: micro(limits.dailyCap),
          monthlyCapMicros: micro(limits.monthlyCap),
          dailyWindowSeconds: Number(limits.dailyWindow),
          monthlyWindowSeconds: Number(limits.monthlyWindow),
          approvalThresholdMicros: micro(limits.approvalThreshold),
          validFrom: limits.validFrom,
          validUntil: limits.validUntil,
          ...(limits.classMask === undefined ? {} : { classMask: Number(limits.classMask) }),
          ...(limits.totalCap === undefined ? {} : { totalCapMicros: micro(limits.totalCap) }),
          ...(limits.lane === undefined ? {} : { lane: Number(limits.lane) }),
        },
        daily: toWindow(daily),
        monthly: toWindow(monthly),
        remaining: {
          perCall: micro(remaining[0]),
          daily: micro(remaining[1]),
          monthly: micro(remaining[2]),
        },
        merchantGate: gate === 1 ? { kind: 'merkleRoot', root: merchantRoot.toLowerCase() as Hex32 } : { kind: 'allowlist' },
        balanceMicros: micro(balance),
      } satisfies AccountState;
    }, `MandateAccount ${account}`, account);

  return {
    readAccount,

    previewSpend: async (account, merchant, capabilityId, amountMicros, blockNumber, spendClass = 0) =>
      read(async () => {
        const [allowed, selector] = (
          (await contractSet(account)) === 'v1'
            ? await client.readContract({
                address: account,
                abi: mandateAccountAbiV1,
                functionName: 'previewSpend',
                args: [merchant, capabilityId, amountMicros],
                ...at(blockNumber),
              })
            : await client.readContract({
                address: account,
                abi: mandateAccountAbi,
                functionName: 'previewSpend',
                args: [merchant, capabilityId, amountMicros, spendClass],
                ...at(blockNumber),
              })
        ) as readonly [boolean, Selector];
        return { allowed, selector: (allowed ? ZERO_SELECTOR : selector.toLowerCase()) as Selector };
      }, `previewSpend on ${account}`, account),

    readEscrowTerms: async (escrow, blockNumber) =>
      read(async () => {
        const call = <const T extends string>(functionName: T) =>
          client.readContract({ address: escrow, abi: escrowAbi, functionName, ...at(blockNumber) } as never);

        const floored = (contractSetOfEscrow(escrow) ?? CURRENT_CONTRACT_SET) === 'v3';

        const [settlementAsset, reputation, registry, minTtl, maxTtl, minLock, feeBps, disputeBondBps] = (await Promise.all([
          call('settlementAsset'),
          call('reputation'),
          call('registry'),
          call('minTtl'),
          call('maxTtl'),
          floored ? call('minLock') : Promise.resolve(1n),
          call('feeBps'),
          call('disputeBondBps'),
        ])) as [Address, Address, Address, bigint, bigint, bigint, number, number];

        return {
          escrow,
          settlementAsset,
          reputation,
          registry: registry === zeroAddress ? null : registry,
          minTtlSeconds: minTtl,
          maxTtlSeconds: maxTtl,
          minLockMicros: micro(minLock),
          feeBps,
          disputeBondBps,
        } satisfies EscrowTerms;
      }, `Escrow ${escrow}`, escrow),

    readIssuerControls: async (asset, parties, blockNumber) => {
      const control = async (functionName: 'paused' | 'isFrozen', args?: readonly unknown[]): Promise<ControlReading> => {
        try {
          const value = (await client.readContract({
            address: asset,
            abi: settlementAssetAbi,
            functionName,
            ...(args === undefined ? {} : { args }),
            ...at(blockNumber),
          } as never)) as boolean;
          return { state: 'read', value };
        } catch (error) {
          // Deliberately not routed through `read` above. Every other read turns a failure into a
          // refusal to answer at all; this one has to come back as a reading, because a control
          // that did not answer is still a fact the decision has to state.
          return controlFailure(error);
        }
      };

      // One wave, at the height the rest of the decision was taken at. The escrow terms and the
      // two roster reads are already in flight when this joins them, so the issuer's view of the
      // spend costs the decision no round trip it was not already paying for.
      const [paused, ...frozen] = await Promise.all([
        control('paused'),
        ...parties.map((address) => control('isFrozen', [address])),
      ]);

      const missing: ControlReading = {
        state: 'unreadable',
        detail: 'the batched read came back short one answer',
      };
      return {
        asset,
        paused: paused ?? missing,
        parties: parties.map((address, index) => ({ address, frozen: frozen[index] ?? missing })),
      };
    },

    readMerchantStanding: async (terms, merchant, blockNumber) =>
      read(async () => {
        // An unset registry means the escrow gates nobody, so the merchant is a party by
        // default. The reputation cap is a control either way and is always read.
        //
        // `isBlacklisted` here is the AgentRegistry's own roster of merchants this deployment has
        // barred, which is a decision the escrow owner made. USDG has issuer controls of its own,
        // under different names: `paused()` stops every transfer and `isFrozen(address)` stops one
        // party's. This path does not read either, so a refusal from here never means the token
        // refused. A USDG refusal is caught in asset.ts instead.
        const [active, blacklisted] =
          terms.registry === null
            ? [true, false]
            : ((await Promise.all([
                client.readContract({
                  address: terms.registry,
                  abi: agentRegistryAbi,
                  functionName: 'isActive',
                  args: [merchant],
                  ...at(blockNumber),
                }),
                client.readContract({
                  address: terms.registry,
                  abi: agentRegistryAbi,
                  functionName: 'isBlacklisted',
                  args: [merchant],
                  ...at(blockNumber),
                }),
              ])) as [boolean, boolean]);

        const cap = (await client.readContract({
          address: terms.reputation,
          abi: reputationAbi,
          functionName: 'capOf',
          args: [merchant],
          ...at(blockNumber),
        })) as bigint;

        return { merchant, active, blacklisted, capMicros: micro(cap) } satisfies MerchantStanding;
      }, `merchant standing for ${merchant}`),

    readMerchantAllowed: async (account, merchant, blockNumber) =>
      read(
        async () =>
          (await client.readContract({
            address: account,
            abi: mandateAccountAbi,
            functionName: 'merchants',
            args: [merchant],
            ...at(blockNumber),
          })) as boolean,
        `merchant roster on ${account}`,
        account,
      ),

    readCapabilityAllowed: async (account, capabilityId, blockNumber) =>
      read(
        async () =>
          (await client.readContract({
            address: account,
            abi: mandateAccountAbi,
            functionName: 'capabilities',
            args: [capabilityId],
            ...at(blockNumber),
          })) as boolean,
        `capability roster on ${account}`,
        account,
      ),

    blockTimestamp: async () =>
      read(async () => (await client.getBlock({ blockTag: 'latest' })).timestamp, 'the latest block'),

    latestBlock: async () =>
      read(async () => {
        const block = await client.getBlock({ blockTag: 'latest' });
        return { number: block.number, timestamp: block.timestamp };
      }, 'the latest block'),

    readEscrowLock: async (escrow, id) =>
      read(async () => {
        const lock = await client.readContract({ address: escrow, abi: escrowAbi, functionName: 'getLock', args: [id] });
        return { id, payer: lock.payer, amountMicros: micro(lock.amount), status: Number(lock.status) } satisfies EscrowLock;
      }, `lock ${id} on Escrow ${escrow}`, escrow),

    readAssetDecimals: async (asset) =>
      read(
        async () => Number(await client.readContract({ address: asset, abi: settlementAssetAbi, functionName: 'decimals' })),
        `decimals() on ${asset}`,
        asset,
      ),

    simulateSpend: async (call) => {
      const request = {
        merchant: call.merchant,
        capabilityId: call.capabilityId,
        inputCommit: call.inputCommit,
        inputURI: call.inputURI,
        amount: call.amountMicros,
        deadline: call.deadline,
      };

      try {
        const data =
          (await contractSet(call.account)) === 'v1'
            ? encodeFunctionData({ abi: mandateAccountAbiV1, functionName: 'spend', args: [request, call.merchantProof] })
            : encodeFunctionData({
                abi: mandateAccountAbi,
                functionName: 'spend',
                args: [{ ...request, spendClass: call.spendClass ?? 0 }, call.merchantProof],
              });
        await client.call({ account: call.agent, to: call.account, data, ...at(call.blockNumber) });
        return { ok: true };
      } catch (error) {
        const selector = revertSelector(error);
        // No selector means the call did not come back with revert bytes. That is a chain that
        // could not answer, not a mandate that said no.
        if (selector === null) {
          throw new ChainUnavailableError(
            `the spend simulation on ${call.account} came back with neither a result nor revert data, so the account has not said anything about this spend`,
            { account: call.account },
            error,
          );
        }
        return { ok: false, selector };
      }
    },
  };
}
