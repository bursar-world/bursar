import {
  BURSAR_SUBJECT_KEY,
  RULING_FEEDBACK_TAG,
  V2_ABIS,
  agentRegistryAbi,
  contractSetAtLeast,
  contractSetOfEscrow,
  createRhcClient,
  escrowAbi,
  identityRegistryAbi,
  mandateAccountAbi,
  mandateAccountAbiV1,
  oracleRegistryAbi,
  reputationAbi,
  reputationRegistryAbi,
} from '@bursar/core';
import type { ContractSet, RhcChain, RhcPublicClient, RpcPool, RpcPoolEvent, RpcProvider } from '@bursar/core';
import { encodeFunctionData, getAbiItem, getAddress, keccak256 } from 'viem';
import type { Address, Hex } from 'viem';

import type { ResolverKey } from './keys.js';
import { describeError } from './log.js';

const isZeroAddress = (address: Address): boolean => /^0x0{40}$/i.test(address);

/** Mirrors `IOracleRegistry.DisputeStatus`. */
export const DisputeStatus = { None: 0, Committing: 1, Revealing: 2, Finalized: 3, Failed: 4 } as const;

/** Mirrors `IOracleRegistry.ResolverStatus`. */
export const ResolverStatus = { None: 0, Active: 1, Unbonding: 2, Exited: 3 } as const;

/** Mirrors `IEscrow.LockStatus`. */
export const LockStatus = { None: 0, Locked: 1, Released: 2, TimedOut: 3, Disputed: 4, Cancelled: 5, Resolved: 6 } as const;

/** Every deadline here is a block timestamp. The wall clock of this machine decides nothing. */
export type Head = { readonly number: bigint; readonly timestamp: bigint };

export type RegistryTerms = {
  readonly commitWindow: bigint;
  readonly revealWindow: bigint;
  readonly quorum: number;
  readonly maxVoters: number;
  readonly maxDeviation: number;
};

export type DisputeState = {
  readonly escrowId: bigint;
  readonly openedAt: bigint;
  readonly commitEndsAt: bigint;
  readonly revealEndsAt: bigint;
  readonly commitCount: number;
  readonly revealCount: number;
  readonly medianScore: number;
  readonly refundBps: number;
  readonly status: number;
};

export type LockState = {
  readonly payer: Address;
  readonly payee: Address;
  readonly disputer: Address;
  readonly capabilityId: Hex;
  readonly inputCommit: Hex;
  readonly outputCommit: Hex;
  readonly inputURI: string;
  readonly outputURI: string;
  readonly amount: bigint;
  readonly deadline: bigint;
  readonly releasedAt: bigint;
  readonly bond: bigint;
  readonly disputedAt: bigint;
  readonly status: number;
};

export type DisputeOpenedLog = {
  readonly disputeId: bigint;
  readonly escrowId: bigint;
  readonly blockNumber: bigint;
};

export type ResolverRecord = {
  readonly bond: bigint;
  readonly status: number;
  readonly slashes: number;
  readonly finalized: number;
};

/** What a payer that is a mandate account had agreed to, read at the snapshot block. */
export type MandateFacts = {
  readonly capabilityAllowed: boolean;
  readonly merchantAllowed: boolean;
  readonly validUntil: bigint;
};

export type PayeeFacts = {
  readonly active: boolean | null;
  readonly released: bigint;
  readonly timedOut: bigint;
  readonly disputed: bigint;
};

export type TxOutcome = {
  readonly hash: Hex;
  readonly status: 'success' | 'reverted';
  readonly blockNumber: bigint;
  readonly gasUsed: bigint;
};

/**
 * A write that did not come back mined, and which half of it failed.
 *
 * `refused` means nothing was signed: the simulation reverted or the node rejected the
 * transaction outright, and there is nothing in flight. `unconfirmed` means a transaction left
 * with this hash and no receipt came back inside the wait, so it may still land and the next
 * attempt has to replace it at the same nonce rather than queue behind it. The difference is the
 * whole of what a caller needs to decide whether trying again is safe.
 */
export class WriteFailed extends Error {
  readonly action: string;
  readonly hash: Hex | null;
  readonly kind: 'refused' | 'unconfirmed';

  constructor(action: string, kind: WriteFailed['kind'], hash: Hex | null, cause: unknown) {
    super(`${action} ${kind === 'refused' ? 'was refused' : 'was not confirmed'}: ${describeError(cause)}`);
    this.name = 'WriteFailed';
    this.action = action;
    this.kind = kind;
    this.hash = hash;
    this.cause = cause;
  }
}

/** How much above the estimate a write is priced, in basis points. 10,000 is the estimate itself. */
export type Pricing = { readonly feeBps: number };

export const PRICE_NORMAL: Pricing = { feeBps: 10_000 };

/**
 * Every call the service makes against the chain, in one narrow surface. The voter is tested
 * against a fake of exactly this, so the list here is also the list of what the service can do.
 */
export type ChainPort = {
  head(): Promise<Head>;
  terms(registry: Address): Promise<RegistryTerms>;
  escrowResolver(escrow: Address): Promise<Address>;
  nextDisputeId(registry: Address): Promise<bigint>;
  disputeIdOf(registry: Address, escrowId: bigint): Promise<bigint>;
  /**
   * Every address the registry bars from voting on a dispute. A v3 registry recorded the payer's
   * principal when the dispute opened; a v2 registry reads it from the payer at each vote, so it is
   * read here the same way; a v1 registry bars nobody.
   */
  parties(registry: Address, disputeId: bigint, contractSet: ContractSet): Promise<readonly Address[]>;
  disputeOpenedLogs(registry: Address, fromBlock: bigint, toBlock: bigint): Promise<readonly DisputeOpenedLog[]>;
  dispute(registry: Address, disputeId: bigint): Promise<DisputeState>;
  lock(escrow: Address, escrowId: bigint, blockNumber?: bigint): Promise<LockState>;
  committedBy(registry: Address, disputeId: bigint, resolver: Address): Promise<Hex>;
  revealedBy(registry: Address, disputeId: bigint, resolver: Address): Promise<{ revealed: boolean; score: number }>;
  commitmentHash(registry: Address, disputeId: bigint, resolver: Address, score: number, salt: Hex): Promise<Hex>;
  resolver(registry: Address, resolver: Address): Promise<ResolverRecord>;
  openVotes(registry: Address, resolver: Address): Promise<number>;
  bondable(registry: Address, resolver: Address, bond: bigint): Promise<boolean>;
  balance(address: Address): Promise<bigint>;
  mandate(payer: Address, capabilityId: Hex, payee: Address, blockNumber: bigint): Promise<MandateFacts | null>;
  payee(escrow: Address, payee: Address, blockNumber: bigint): Promise<PayeeFacts>;
  commit(key: ResolverKey, registry: Address, disputeId: bigint, commitment: Hex, pricing: Pricing): Promise<TxOutcome>;
  reveal(key: ResolverKey, registry: Address, disputeId: bigint, score: number, salt: Hex, pricing: Pricing): Promise<TxOutcome>;
  finalize(key: ResolverKey, registry: Address, disputeId: bigint, pricing: Pricing): Promise<TxOutcome>;
};

/** An ERC-8004 identity as the registry answers for it. `subject` is its `bursar.subject` entry. */
export type IdentityFacts = { readonly owner: Address; readonly subject: Address | null };

/** The ERC-8004 registries, read and written apart from the dispute surface so the voter's fake stays whole. */
export type ReputationPort = {
  /** Null for a token the identity registry does not hold. */
  identity(registry: Address, agentId: bigint): Promise<IdentityFacts | null>;
  /** Whether `client` already left feedback on `agentId` under the ruling tag and this `tag2`. */
  posted(registry: Address, agentId: bigint, client: Address, tag2: string): Promise<boolean>;
  giveFeedback(
    key: ResolverKey,
    registry: Address,
    agentId: bigint,
    score: number,
    tag2: string,
    endpoint: string,
    feedbackURI: string,
    pricing: Pricing,
  ): Promise<TxOutcome>;
};

export type ChainOptions = {
  readonly chain: RhcChain;
  readonly providers: readonly RpcProvider[];
  /**
   * Hosts a transaction may be sent to, in order of preference. Each write goes to exactly one of
   * them, the first that answers for the right chain, and a replacement goes where the original
   * went. Nothing is broadcast through the pool, which fails over without asking whether a write
   * already reached the host it gave up on.
   */
  readonly writeUrls: readonly string[];
  readonly confirmTimeoutMs: number;
  /** Two providers in production. A fork or a local node sets this false where a reader can see it. */
  readonly requireRedundancy?: boolean;
  readonly onRpcEvent?: (event: RpcPoolEvent) => void;
  readonly fetch?: typeof fetch;
  /** Between receipt polls. Tests shorten it. */
  readonly receiptPollMs?: number;
};

/**
 * The v1 registry's `finalize` wraps the escrow call in a try, and a caller who sends it with just
 * enough gas for the outer frame makes the inner call run out, fail quietly, and close the dispute
 * as Failed with the money still frozen. Twice the estimate and never under 1.5M leaves the 1/64
 * that the EVM holds back far above anything the escrow's `resolve` spends.
 */
const FINALIZE_GAS_FLOOR = 1_500_000n;

/** Headroom on every other write. An estimate taken a block early can come in a little short. */
const GAS_HEADROOM_BPS = 15_000n;

/** A single JSON-RPC call to one host is abandoned after this long. */
const RPC_TIMEOUT_MS = 10_000;

/** How long a write host gets to say which chain it serves before the next one is tried. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * A transaction the write host never mined and never forgot is treated as gone after this long,
 * so a nonce it was holding can be reused. Robinhood Chain's sequencer includes or rejects within
 * seconds; ten minutes is far past anything it does on purpose.
 */
const PENDING_TTL_MS = 600_000;

const DISPUTE_OPENED = getAbiItem({ abi: oracleRegistryAbi, name: 'DisputeOpened' });

const STAKING_ABI = [
  {
    type: 'function',
    name: 'isBondable',
    stateMutability: 'view',
    inputs: [
      { name: 'resolver', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

type Pending = { readonly nonce: number; readonly hash: Hex; readonly label: string; readonly host: string; readonly at: number };

export function createChain(options: ChainOptions): { port: ChainPort; reputation: ReputationPort; client: RhcPublicClient; pool: RpcPool } {
  const doFetch = options.fetch ?? globalThis.fetch;
  const { client, pool } = createRhcClient({
    chain: options.chain,
    providers: options.providers,
    requireRedundancy: options.requireRedundancy ?? true,
    ...(options.onRpcEvent === undefined ? {} : { onEvent: options.onRpcEvent }),
    ...(options.fetch === undefined ? {} : { fetchFn: options.fetch }),
  });
  const receiptPollMs = options.receiptPollMs ?? 1_000;
  const receiptHosts = [...new Set([...options.writeUrls, ...options.providers.map((provider) => provider.url)])];

  const pending = new Map<string, Pending>();
  const staking = new Map<string, Address>();

  /** One host, one call, one timeout. Never the pool: see `ChainOptions.writeUrls`. */
  async function rpcOn<T>(url: string, method: string, params: readonly unknown[], timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${method} answered HTTP ${response.status}`);

    const body = (await response.json()) as { result?: T; error?: { message?: string } };
    if (body.error !== undefined) throw new Error(body.error.message ?? `${method} failed`);
    return body.result as T;
  }

  async function receipt(hash: Hex): Promise<TxOutcome | null> {
    // Asked of every host, because the one that accepted the transaction can be the one that is
    // down by the time it is mined, and a receipt is a receipt wherever it is read.
    for (const url of receiptHosts) {
      try {
        const found = await rpcOn<{ status: Hex; blockNumber: Hex; gasUsed: Hex } | null>(url, 'eth_getTransactionReceipt', [hash]);
        if (found !== null && found !== undefined) {
          return {
            hash,
            status: found.status === '0x1' ? 'success' : 'reverted',
            blockNumber: BigInt(found.blockNumber),
            gasUsed: BigInt(found.gasUsed),
          };
        }
      } catch {
        // One host not answering is the case this loop exists for. The next one is asked.
      }
    }
    return null;
  }

  async function known(hash: Hex): Promise<boolean> {
    for (const url of receiptHosts) {
      try {
        if ((await rpcOn<unknown>(url, 'eth_getTransactionByHash', [hash])) !== null) return true;
      } catch {
        // As above: the question is whether any host has it.
      }
    }
    return false;
  }

  async function awaitReceipt(action: string, hash: Hex): Promise<TxOutcome> {
    const deadline = Date.now() + options.confirmTimeoutMs;
    for (;;) {
      const found = await receipt(hash);
      if (found !== null) return found;
      if (Date.now() >= deadline) {
        throw new WriteFailed(action, 'unconfirmed', hash, new Error(`no receipt within ${options.confirmTimeoutMs} ms`));
      }
      await new Promise((resolve) => setTimeout(resolve, receiptPollMs));
    }
  }

  /**
   * Where this write goes and at which nonce.
   *
   * A retry of the same call replaces its own unconfirmed transaction: same host, same nonce, a
   * higher price. Anything else goes to the first host that answers for this chain, at that host's
   * pending count, so the count and the broadcast agree on what one host has seen.
   */
  async function slotFor(key: ResolverKey, label: string): Promise<{ host: string; nonce: number }> {
    const held = pending.get(key.address);
    if (held !== undefined) {
      const latest = await rpcOn<Hex>(held.host, 'eth_getTransactionCount', [key.address, 'latest']).then(
        (count) => Number(BigInt(count)),
        () => null,
      );
      const settled = latest !== null && latest > held.nonce;
      if (settled || Date.now() - held.at > PENDING_TTL_MS) pending.delete(key.address);
      else if (held.label === label && latest !== null) return { host: held.host, nonce: held.nonce };
    }

    const host = await writeHost();
    const count = await rpcOn<Hex>(host, 'eth_getTransactionCount', [key.address, 'pending']);
    return { host, nonce: Number(BigInt(count)) };
  }

  async function writeHost(): Promise<string> {
    const refusals: string[] = [];
    for (const url of options.writeUrls) {
      try {
        const chainId = Number(BigInt(await rpcOn<Hex>(url, 'eth_chainId', [], PROBE_TIMEOUT_MS)));
        if (chainId === options.chain.chainId) return url;
        refusals.push(`a host serves chain ${chainId}`);
      } catch (error) {
        refusals.push(describeError(error));
      }
    }
    throw new Error(`No write host answered for chain ${options.chain.chainId}: ${refusals.join('; ')}`);
  }

  async function send(
    key: ResolverKey,
    label: string,
    to: Address,
    data: Hex,
    pricing: Pricing,
    gasFor: (estimate: bigint) => bigint,
  ): Promise<TxOutcome> {
    let estimate: bigint;
    let fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };
    let slot: { host: string; nonce: number };
    try {
      // The estimate is the simulation. A revert here is the contract's answer and costs nothing.
      estimate = await client.estimateGas({ account: key.address, to, data });
      fees = await client.estimateFeesPerGas();
      slot = await slotFor(key, label);
    } catch (cause) {
      throw new WriteFailed(label, 'refused', null, cause);
    }

    const floor = options.chain.minFeeCap;
    const baseFee = fees.maxFeePerGas === undefined || fees.maxFeePerGas < floor ? floor : fees.maxFeePerGas;
    const maxFeePerGas = (baseFee * BigInt(pricing.feeBps)) / 10_000n;
    const tip = ((fees.maxPriorityFeePerGas ?? 0n) * BigInt(pricing.feeBps)) / 10_000n;

    const serialized = await key.account.signTransaction({
      chainId: options.chain.chainId,
      type: 'eip1559',
      nonce: slot.nonce,
      to,
      data,
      value: 0n,
      gas: gasFor(estimate),
      maxFeePerGas,
      maxPriorityFeePerGas: tip > maxFeePerGas ? maxFeePerGas : tip,
    });
    const hash = keccak256(serialized);

    try {
      await rpcOn<Hex>(slot.host, 'eth_sendRawTransaction', [serialized]);
    } catch (cause) {
      // "Already known", "nonce too low", a timeout after the host took it: in every one of these
      // the transaction may exist, and the answer is to look it up. Signing again is how one vote
      // becomes two transactions.
      if (!(await known(hash))) {
        pending.delete(key.address);
        throw new WriteFailed(label, 'refused', null, cause);
      }
    }

    pending.set(key.address, { nonce: slot.nonce, hash, label, host: slot.host, at: Date.now() });
    const outcome = await awaitReceipt(label, hash);
    pending.delete(key.address);
    return outcome;
  }

  const headroom = (estimate: bigint): bigint => (estimate * GAS_HEADROOM_BPS) / 10_000n;

  /** The payer's principal, where the payer is a contract that names one. */
  async function principalOf(payer: Address): Promise<Address[]> {
    try {
      const principal = await client.readContract({ address: payer, abi: mandateAccountAbi, functionName: 'principal' });
      return isZeroAddress(principal) ? [] : [principal];
    } catch {
      return [];
    }
  }

  async function stakingOf(registry: Address): Promise<Address> {
    const cached = staking.get(registry);
    if (cached !== undefined) return cached;
    const found = await client.readContract({ address: registry, abi: oracleRegistryAbi, functionName: 'staking' });
    staking.set(registry, found);
    return found;
  }

  const port: ChainPort = {
    head: async () => {
      const block = await client.getBlock({ blockTag: 'latest' });
      return { number: block.number, timestamp: block.timestamp };
    },

    terms: async (registry) => {
      const config = await client.readContract({ address: registry, abi: oracleRegistryAbi, functionName: 'config' });
      return {
        commitWindow: config.commitWindow,
        revealWindow: config.revealWindow,
        quorum: config.quorum,
        maxVoters: config.maxVoters,
        maxDeviation: config.maxDeviation,
      };
    },

    escrowResolver: (escrow) => client.readContract({ address: escrow, abi: escrowAbi, functionName: 'resolver' }),

    nextDisputeId: (registry) => client.readContract({ address: registry, abi: oracleRegistryAbi, functionName: 'nextDisputeId' }),

    disputeIdOf: (registry, escrowId) =>
      client.readContract({ address: registry, abi: oracleRegistryAbi, functionName: 'disputeIdOf', args: [escrowId] }),

    parties: async (registry, disputeId, contractSet) => {
      if (contractSet === 'v1') return [];
      if (contractSetAtLeast(contractSet, 'v3')) {
        const found = await client.readContract({ address: registry, abi: oracleRegistryAbi, functionName: 'partiesOf', args: [disputeId] });
        return found.filter((party) => !isZeroAddress(party));
      }
      const [payer, payee] = await client.readContract({
        address: registry,
        abi: V2_ABIS.OracleRegistry,
        functionName: 'partiesOf',
        args: [disputeId],
      });
      return [payer, payee, ...(await principalOf(payer))];
    },

    disputeOpenedLogs: async (registry, fromBlock, toBlock) => {
      const logs = await client.getLogs({ address: registry, event: DISPUTE_OPENED, fromBlock, toBlock, strict: true });
      return logs.map((entry) => ({ disputeId: entry.args.disputeId, escrowId: entry.args.escrowId, blockNumber: entry.blockNumber }));
    },

    dispute: async (registry, disputeId) => {
      const found = await client.readContract({ address: registry, abi: oracleRegistryAbi, functionName: 'getDispute', args: [disputeId] });
      return {
        escrowId: found.escrowId,
        openedAt: found.openedAt,
        commitEndsAt: found.commitEndsAt,
        revealEndsAt: found.revealEndsAt,
        commitCount: found.commitCount,
        revealCount: found.revealCount,
        medianScore: found.medianScore,
        refundBps: found.refundBps,
        status: found.status,
      };
    },

    lock: async (escrow, escrowId, blockNumber) => {
      const found = await client.readContract({
        address: escrow,
        abi: escrowAbi,
        functionName: 'getLock',
        args: [escrowId],
        ...(blockNumber === undefined ? {} : { blockNumber }),
      });
      return {
        payer: found.payer,
        payee: found.payee,
        disputer: found.disputer,
        capabilityId: found.capabilityId,
        inputCommit: found.inputCommit,
        outputCommit: found.outputCommit,
        inputURI: found.inputURI,
        outputURI: found.outputURI,
        amount: found.amount,
        deadline: found.deadline,
        releasedAt: found.releasedAt,
        bond: found.bond,
        disputedAt: found.disputedAt,
        status: found.status,
      };
    },

    committedBy: (registry, disputeId, resolver) =>
      client.readContract({ address: registry, abi: oracleRegistryAbi, functionName: 'committedBy', args: [disputeId, resolver] }),

    revealedBy: async (registry, disputeId, resolver) => {
      const [revealed, score] = await client.readContract({
        address: registry,
        abi: oracleRegistryAbi,
        functionName: 'revealedBy',
        args: [disputeId, resolver],
      });
      return { revealed, score };
    },

    commitmentHash: (registry, disputeId, resolver, score, salt) =>
      client.readContract({
        address: registry,
        abi: oracleRegistryAbi,
        functionName: 'commitmentHash',
        args: [disputeId, resolver, score, salt],
      }),

    resolver: async (registry, resolver) => {
      const found = await client.readContract({ address: registry, abi: oracleRegistryAbi, functionName: 'getResolver', args: [resolver] });
      return { bond: found.bond, status: found.status, slashes: found.slashes, finalized: found.finalized };
    },

    openVotes: (registry, resolver) =>
      client.readContract({ address: registry, abi: oracleRegistryAbi, functionName: 'openVotes', args: [resolver] }),

    bondable: async (registry, resolver, bond) =>
      client.readContract({ address: await stakingOf(registry), abi: STAKING_ABI, functionName: 'isBondable', args: [resolver, bond] }),

    balance: (address) => client.getBalance({ address }),

    mandate: async (payer, capabilityId, payee, blockNumber) => {
      const code = await client.getCode({ address: payer, blockNumber });
      if (code === undefined || code === '0x') return null;

      // A contract payer that is not a mandate account answers none of these, and that is a fact
      // about the payer, not a fault in the reading. It is reported as no mandate at all.
      try {
        // A v1 account returns eight limit fields and a later one eleven, so the escrow it was
        // created against decides which ABI decodes them.
        const escrow = await client.readContract({ address: payer, abi: mandateAccountAbi, functionName: 'escrow', blockNumber });
        const limits =
          contractSetOfEscrow(escrow) === 'v1'
            ? client.readContract({ address: payer, abi: mandateAccountAbiV1, functionName: 'limits', blockNumber })
            : client.readContract({ address: payer, abi: mandateAccountAbi, functionName: 'limits', blockNumber });
        const [capabilityAllowed, merchantAllowed, { validUntil }] = await Promise.all([
          client.readContract({ address: payer, abi: mandateAccountAbi, functionName: 'capabilities', args: [capabilityId], blockNumber }),
          client.readContract({ address: payer, abi: mandateAccountAbi, functionName: 'merchants', args: [payee], blockNumber }),
          limits,
        ]);
        return { capabilityAllowed, merchantAllowed, validUntil };
      } catch (error) {
        if (/reverted|returned no data/i.test(describeError(error))) return null;
        throw error;
      }
    },

    payee: async (escrow, payee, blockNumber) => {
      const [registry, reputation] = await Promise.all([
        client.readContract({ address: escrow, abi: escrowAbi, functionName: 'registry', blockNumber }),
        client.readContract({ address: escrow, abi: escrowAbi, functionName: 'reputation', blockNumber }),
      ]);
      const [active, stats] = await Promise.all([
        /^0x0+$/.test(registry)
          ? Promise.resolve(null)
          : client.readContract({ address: registry, abi: agentRegistryAbi, functionName: 'isActive', args: [payee], blockNumber }),
        client.readContract({ address: reputation, abi: reputationAbi, functionName: 'payeeStats', args: [payee], blockNumber }),
      ]);
      return { active, released: stats[0], timedOut: stats[1], disputed: stats[2] };
    },

    commit: (key, registry, disputeId, commitment, pricing) =>
      send(
        key,
        `commitVote:${registry}:${disputeId}`,
        registry,
        encodeFunctionData({ abi: oracleRegistryAbi, functionName: 'commitVote', args: [disputeId, commitment] }),
        pricing,
        headroom,
      ),

    reveal: (key, registry, disputeId, score, salt, pricing) =>
      send(
        key,
        `revealVote:${registry}:${disputeId}`,
        registry,
        encodeFunctionData({ abi: oracleRegistryAbi, functionName: 'revealVote', args: [disputeId, score, salt] }),
        pricing,
        headroom,
      ),

    finalize: (key, registry, disputeId, pricing) =>
      send(
        key,
        `finalize:${registry}:${disputeId}`,
        registry,
        encodeFunctionData({ abi: oracleRegistryAbi, functionName: 'finalize', args: [disputeId] }),
        pricing,
        (estimate) => (estimate * 2n > FINALIZE_GAS_FLOOR ? estimate * 2n : FINALIZE_GAS_FLOOR),
      ),
  };

  const reputation: ReputationPort = {
    identity: async (registry, agentId) => {
      try {
        const [owner, subject] = await Promise.all([
          client.readContract({ address: registry, abi: identityRegistryAbi, functionName: 'ownerOf', args: [agentId] }),
          client.readContract({ address: registry, abi: identityRegistryAbi, functionName: 'getMetadata', args: [agentId, BURSAR_SUBJECT_KEY] }),
        ]);
        return { owner: getAddress(owner), subject: /^0x[0-9a-fA-F]{40}$/.test(subject) ? getAddress(subject) : null };
      } catch {
        return null;
      }
    },

    posted: async (registry, agentId, who, tag2) => {
      const [clients] = await client.readContract({
        address: registry,
        abi: reputationRegistryAbi,
        functionName: 'readAllFeedback',
        args: [agentId, [who], RULING_FEEDBACK_TAG, tag2, true],
      });
      return clients.length > 0;
    },

    giveFeedback: (key, registry, agentId, score, tag2, endpoint, feedbackURI, pricing) =>
      send(
        key,
        `feedback:${registry}:${agentId.toString()}:${tag2}`,
        registry,
        encodeFunctionData({
          abi: reputationRegistryAbi,
          functionName: 'giveFeedback',
          args: [agentId, BigInt(score), 0, RULING_FEEDBACK_TAG, tag2, endpoint, feedbackURI, `0x${'0'.repeat(64)}`],
        }),
        pricing,
        headroom,
      ),
  };

  return { port, reputation, client, pool };
}
