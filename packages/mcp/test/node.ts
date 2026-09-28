/**
 * A JSON-RPC endpoint backed by plain objects. The gateway talks to it through the real viem
 * client and the real pool, so every ABI encoding on the path is exercised.
 */
import {
  RHC_MAINNET,
  agentRegistryAbi,
  escrowAbi,
  mandateAccountAbi,
  oracleRegistryAbi,
  reputationAbi,
  settlementAssetAbi,
} from '@bursar/core';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAbiItem,
  keccak256,
  multicall3Abi,
  parseTransaction,
  toFunctionSelector,
  toHex,
} from 'viem';
import type { Abi, AbiFunction, Address, Hex } from 'viem';

export const ACCOUNT: Address = '0x00000000000000000000000000000000000acc01';
/**
 * Nothing is deployed on chain 4663 yet, so the escrow is named here rather than read from a
 * record that does not exist. The settlement asset is not invented: it is the USDG address the
 * chain config carries, because a test that faked it would not be exercising the same token.
 */
export const ESCROW: Address = '0x8E298457cDFc1Cb9ef6253D36d3BD5cFEf10F915';
export const ASSET: Address = RHC_MAINNET.usdg;
export const PRINCIPAL: Address = '0x1111111111111111111111111111111111111111';
export const AGENT: Address = '0x2222222222222222222222222222222222222222';
export const PROVIDER: Address = '0x3333333333333333333333333333333333333333';
export const RESOLVER: Address = '0x4444444444444444444444444444444444444444';
/** The dispute registry the escrow rules through, and the address this server votes as. */
export const ORACLE_REGISTRY: Address = RESOLVER;
export const VOTER: Address = '0x5555555555555555555555555555555555555555';
export const AGENT_REGISTRY: Address = '0x6666666666666666666666666666666666666666';
export const REPUTATION: Address = '0x7777777777777777777777777777777777777777';
export const STAKING: Address = '0x8888888888888888888888888888888888888888';
export const BRSR: Address = '0x00e503925880c4b07E5Fb70232D83aD871F57a7d';

export const ZERO_BYTES32: Hex = `0x${'00'.repeat(32)}`;

export type Lock = {
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

export type SpentLog = {
  escrowId: bigint;
  merchant: Address;
  capabilityId: Hex;
  amount: bigint;
  dailySpent: bigint;
  monthlySpent: bigint;
  blockNumber: bigint;
  txHash: Hex;
};

export type NodeState = {
  blockNumber: bigint;
  timestamp: bigint;
  principal: Address;
  agent: Address;
  paused: boolean;
  revoked: boolean;
  version: bigint;
  documentHash: Hex;
  settlementAsset: Address;
  escrow: Address;
  balance: bigint;
  limits: {
    perCallCap: bigint;
    dailyCap: bigint;
    monthlyCap: bigint;
    dailyWindow: bigint;
    monthlyWindow: bigint;
    approvalThreshold: bigint;
    validFrom: bigint;
    validUntil: bigint;
  };
  daily: { cap: bigint; spent: bigint; duration: bigint; start: bigint; epoch: bigint };
  monthly: { cap: bigint; spent: bigint; duration: bigint; start: bigint; epoch: bigint };
  merchantGate: number;
  merchantRoot: Hex;
  previewReason: Hex;
  creditable: bigint;
  /** What a write against the account reverts with, as a four-byte selector. Null lets it through. */
  writeRevert: Hex | null;
  /** The id the escrow assigns the next lock this account opens. */
  nextEscrowId: bigint;
  /** What a mined transaction reports. `0x0` is the race a call that passed its check can still lose. */
  receiptStatus: Hex;
  baseFeePerGas: bigint;
  terms: {
    minTtl: bigint;
    maxTtl: bigint;
    disputeWindow: bigint;
    disputeTimeoutPeriod: bigint;
    disputeBondBps: number;
    feeBps: number;
    resolverFeeBps: number;
    resolver: Address;
  };
  locks: Map<bigint, Lock>;
  spent: SpentLog[];
  oracle: OracleState;
  registry: RegistryState;
  reputation: ReputationState;
};

export type Dispute = {
  escrowId: bigint;
  openedAt: bigint;
  commitEndsAt: bigint;
  revealEndsAt: bigint;
  commitCount: number;
  revealCount: number;
  medianScore: number;
  refundBps: number;
  rewardShares: number;
  status: number;
};

export type OracleState = {
  config: {
    commitWindow: bigint;
    revealWindow: bigint;
    unbondingPeriod: bigint;
    quorum: number;
    maxVoters: number;
    maxDeviation: number;
    slashBps: number;
  };
  staking: Address;
  bondAsset: Address;
  minBond: bigint;
  bondable: boolean;
  resolver: { bond: bigint; unbondingAt: bigint; finalized: number; slashes: number; status: number };
  openVotes: number;
  rewards: bigint;
  nextDisputeId: bigint;
  disputes: Map<bigint, Dispute>;
  /** Keyed by `${disputeId}`, holding what this voter has sealed and published. */
  commitments: Map<string, Hex>;
  reveals: Map<string, readonly [boolean, number]>;
  disputeIdOf: Map<bigint, bigint>;
  /** Set to make the registry hash differently from the client, which is the one unrecoverable bug. */
  hashesDifferently: boolean;
};

export type RegistryState = {
  agent: { name: string; stake: bigint; registeredAt: bigint; active: boolean };
  registered: boolean;
  active: boolean;
  blacklisted: boolean;
  minStake: bigint;
  maxSlash: bigint;
  withdrawal: readonly [bigint, bigint];
  withdrawalDelay: bigint;
  paused: boolean;
};

export type ReputationState = {
  stats: readonly [bigint, bigint, bigint];
  score: number;
  cap: bigint;
  curve: { baseCap: bigint; capPerScore: bigint; maxCap: bigint };
};

export function defaultOracle(): OracleState {
  return {
    config: {
      commitWindow: 21_600n,
      revealWindow: 21_600n,
      unbondingPeriod: 604_800n,
      quorum: 2,
      maxVoters: 5,
      maxDeviation: 20,
      slashBps: 1_000,
    },
    staking: STAKING,
    bondAsset: BRSR,
    minBond: 25_000n * 10n ** 18n,
    bondable: true,
    resolver: { bond: 25_000n * 10n ** 18n, unbondingAt: 0n, finalized: 4, slashes: 0, status: 1 },
    openVotes: 1,
    rewards: 1_250_000n,
    nextDisputeId: 5n,
    disputes: new Map([
      [
        4n,
        {
          escrowId: 42n,
          openedAt: 1_800_000_000n,
          commitEndsAt: 1_800_021_600n,
          revealEndsAt: 1_800_043_200n,
          commitCount: 1,
          revealCount: 0,
          medianScore: 0,
          refundBps: 0,
          rewardShares: 0,
          status: 1,
        },
      ],
    ]),
    commitments: new Map(),
    reveals: new Map(),
    disputeIdOf: new Map([[42n, 4n]]),
    hashesDifferently: false,
  };
}

export function defaultRegistry(): RegistryState {
  return {
    agent: { name: 'render_farm', stake: 25_000_000n, registeredAt: 1_799_900_000n, active: true },
    registered: true,
    active: true,
    blacklisted: false,
    minStake: 5_000_000n,
    maxSlash: 2_500_000n,
    withdrawal: [0n, 0n],
    withdrawalDelay: 604_800n,
    paused: false,
  };
}

export function defaultReputation(): ReputationState {
  return {
    stats: [9n, 0n, 1n],
    score: 90,
    cap: 115_000_000n,
    curve: { baseCap: 25_000_000n, capPerScore: 1_000_000n, maxCap: 250_000_000n },
  };
}

export function defaultState(): NodeState {
  return {
    blockNumber: 61_540_000n,
    timestamp: 1_800_000_000n,
    principal: PRINCIPAL,
    agent: AGENT,
    paused: false,
    revoked: false,
    version: 3n,
    documentHash: ZERO_BYTES32,
    settlementAsset: ASSET,
    escrow: ESCROW,
    balance: 250_000_000n,
    limits: {
      perCallCap: 25_000_000n,
      dailyCap: 100_000_000n,
      monthlyCap: 1_000_000_000n,
      dailyWindow: 86_400n,
      monthlyWindow: 2_592_000n,
      approvalThreshold: 20_000_000n,
      validFrom: 1_700_000_000n,
      validUntil: 1_900_000_000n,
    },
    daily: { cap: 100_000_000n, spent: 30_000_000n, duration: 86_400n, start: 1_799_960_000n, epoch: 7n },
    monthly: { cap: 1_000_000_000n, spent: 400_000_000n, duration: 2_592_000n, start: 1_798_000_000n, epoch: 2n },
    merchantGate: 0,
    merchantRoot: ZERO_BYTES32,
    previewReason: '0x00000000',
    creditable: 0n,
    writeRevert: null,
    nextEscrowId: 77n,
    receiptStatus: '0x1',
    baseFeePerGas: 25_000_000_000n,
    terms: {
      minTtl: 30n,
      maxTtl: 604_800n,
      disputeWindow: 3_600n,
      disputeTimeoutPeriod: 259_200n,
      disputeBondBps: 500,
      feeBps: 50,
      resolverFeeBps: 100,
      resolver: RESOLVER,
    },
    locks: new Map(),
    spent: [],
    oracle: defaultOracle(),
    registry: defaultRegistry(),
    reputation: defaultReputation(),
  };
}

export function lock(overrides: Partial<Lock> = {}): Lock {
  return {
    payer: ACCOUNT,
    payee: PROVIDER,
    disputer: '0x0000000000000000000000000000000000000000',
    capabilityId: `0x${'11'.repeat(32)}`,
    inputCommit: `0x${'22'.repeat(32)}`,
    outputCommit: ZERO_BYTES32,
    inputURI: 'data:application/json;base64,eyJjaXR5IjoiUGFyaXMifQ==',
    outputURI: '',
    amount: 1_000_000n,
    deadline: 1_800_000_300n,
    releasedAt: 0n,
    bond: 0n,
    disputedAt: 0n,
    status: 1,
    counted: false,
    ...overrides,
  };
}

type Answer = { abi: Abi; functionName: string; resolve: (args: readonly unknown[], state: NodeState) => unknown };

function answer(
  abi: Abi,
  functionName: string,
  resolve: (args: readonly unknown[], state: NodeState) => unknown,
): [Hex, Answer] {
  const item = getAbiItem({ abi, name: functionName }) as AbiFunction;

  return [toFunctionSelector(item), { abi, functionName, resolve }];
}

const ACCOUNT_ANSWERS = new Map<Hex, Answer>([
  answer(mandateAccountAbi, 'principal', (_args, state) => state.principal),
  answer(mandateAccountAbi, 'agent', (_args, state) => state.agent),
  answer(mandateAccountAbi, 'paused', (_args, state) => state.paused),
  answer(mandateAccountAbi, 'revoked', (_args, state) => state.revoked),
  answer(mandateAccountAbi, 'version', (_args, state) => state.version),
  answer(mandateAccountAbi, 'documentHash', (_args, state) => state.documentHash),
  answer(mandateAccountAbi, 'settlementAsset', (_args, state) => state.settlementAsset),
  answer(mandateAccountAbi, 'escrow', (_args, state) => state.escrow),
  answer(mandateAccountAbi, 'limits', (_args, state) => state.limits),
  answer(mandateAccountAbi, 'window', (args, state) => (args[0] === 0 ? state.daily : state.monthly)),
  answer(mandateAccountAbi, 'merchantGate', (_args, state) => state.merchantGate),
  answer(mandateAccountAbi, 'merchantRoot', (_args, state) => state.merchantRoot),
  answer(mandateAccountAbi, 'approvalThreshold', (_args, state) => state.limits.approvalThreshold),
  answer(mandateAccountAbi, 'creditable', (_args, state) => state.creditable),
  // The three writes a signer may send. Answered here because every write is run as a call first.
  answer(mandateAccountAbi, 'spend', (_args, state) => write(state, state.nextEscrowId)),
  answer(mandateAccountAbi, 'spendApproved', (_args, state) => write(state, state.nextEscrowId)),
  answer(mandateAccountAbi, 'disputeSpend', (_args, state) => write(state, undefined)),
  answer(mandateAccountAbi, 'previewSpend', (_args, state) => [
    state.previewReason === '0x00000000',
    state.previewReason,
  ]),
  answer(mandateAccountAbi, 'remaining', (_args, state) => [
    state.limits.perCallCap,
    headroom(state.daily),
    headroom(state.monthly),
  ]),
]);

const ESCROW_ANSWERS = new Map<Hex, Answer>([
  answer(escrowAbi, 'minTtl', (_args, state) => state.terms.minTtl),
  answer(escrowAbi, 'maxTtl', (_args, state) => state.terms.maxTtl),
  answer(escrowAbi, 'disputeWindow', (_args, state) => state.terms.disputeWindow),
  answer(escrowAbi, 'disputeTimeoutPeriod', (_args, state) => state.terms.disputeTimeoutPeriod),
  answer(escrowAbi, 'disputeBondBps', (_args, state) => state.terms.disputeBondBps),
  answer(escrowAbi, 'feeBps', (_args, state) => state.terms.feeBps),
  answer(escrowAbi, 'resolver', (_args, state) => state.terms.resolver),
  answer(escrowAbi, 'resolverFeeBps', (_args, state) => state.terms.resolverFeeBps),
  answer(escrowAbi, 'getLock', (args, state) => state.locks.get(args[0] as bigint) ?? lock({ status: 0, amount: 0n })),
]);

const ASSET_ANSWERS = new Map<Hex, Answer>([answer(settlementAssetAbi, 'balanceOf', (_args, state) => state.balance)]);

const STAKING_ABI = [
  {
    type: 'function',
    name: 'minBondOf',
    stateMutability: 'view',
    inputs: [{ name: 'resolver', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
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

const ORACLE_ANSWERS = new Map<Hex, Answer>([
  answer(oracleRegistryAbi, 'config', (_args, state) => state.oracle.config),
  answer(oracleRegistryAbi, 'staking', (_args, state) => state.oracle.staking),
  answer(oracleRegistryAbi, 'bondAsset', (_args, state) => state.oracle.bondAsset),
  answer(oracleRegistryAbi, 'settlementAsset', (_args, state) => state.settlementAsset),
  answer(oracleRegistryAbi, 'getResolver', (_args, state) => state.oracle.resolver),
  answer(oracleRegistryAbi, 'openVotes', (_args, state) => state.oracle.openVotes),
  answer(oracleRegistryAbi, 'rewardsOf', (_args, state) => state.oracle.rewards),
  answer(oracleRegistryAbi, 'nextDisputeId', (_args, state) => state.oracle.nextDisputeId),
  answer(oracleRegistryAbi, 'disputeIdOf', (args, state) => state.oracle.disputeIdOf.get(args[0] as bigint) ?? 0n),
  answer(
    oracleRegistryAbi,
    'getDispute',
    (args, state) => state.oracle.disputes.get(args[0] as bigint) ?? emptyDispute(),
  ),
  answer(
    oracleRegistryAbi,
    'committedBy',
    (args, state) => state.oracle.commitments.get(String(args[0])) ?? ZERO_BYTES32,
  ),
  answer(
    oracleRegistryAbi,
    'revealedBy',
    (args, state) => state.oracle.reveals.get(String(args[0])) ?? [false, 0],
  ),
  // Computed rather than stored, so the check the gateway runs before it seals anything is a real
  // comparison against an independently encoded hash.
  answer(oracleRegistryAbi, 'commitmentHash', (args, state) =>
    state.oracle.hashesDifferently
      ? (`0x${'de'.repeat(32)}` as Hex)
      : keccak256(
          encodeAbiParameters(
            [{ type: 'uint256' }, { type: 'address' }, { type: 'uint8' }, { type: 'bytes32' }],
            [args[0] as bigint, args[1] as Address, args[2] as number, args[3] as Hex],
          ),
        ),
  ),
]);

const REGISTRY_ANSWERS = new Map<Hex, Answer>([
  answer(agentRegistryAbi, 'getAgent', (_args, state) => state.registry.agent),
  answer(agentRegistryAbi, 'isRegistered', (_args, state) => state.registry.registered),
  answer(agentRegistryAbi, 'isActive', (_args, state) => state.registry.active),
  answer(agentRegistryAbi, 'isBlacklisted', (_args, state) => state.registry.blacklisted),
  answer(agentRegistryAbi, 'minStake', (_args, state) => state.registry.minStake),
  answer(agentRegistryAbi, 'maxSlash', (_args, state) => state.registry.maxSlash),
  answer(agentRegistryAbi, 'withdrawals', (_args, state) => state.registry.withdrawal),
  answer(agentRegistryAbi, 'WITHDRAWAL_DELAY', (_args, state) => state.registry.withdrawalDelay),
  answer(agentRegistryAbi, 'paused', (_args, state) => state.registry.paused),
]);

const REPUTATION_ANSWERS = new Map<Hex, Answer>([
  answer(reputationAbi, 'payeeStats', (_args, state) => state.reputation.stats),
  answer(reputationAbi, 'score', (_args, state) => state.reputation.score),
  answer(reputationAbi, 'capOf', (_args, state) => state.reputation.cap),
  answer(reputationAbi, 'curve', (_args, state) => state.reputation.curve),
]);

const STAKING_ANSWERS = new Map<Hex, Answer>([
  answer(STAKING_ABI as unknown as Abi, 'minBondOf', (_args, state) => state.oracle.minBond),
  answer(STAKING_ABI as unknown as Abi, 'isBondable', (_args, state) => state.oracle.bondable),
]);

function emptyDispute(): Dispute {
  return {
    escrowId: 0n,
    openedAt: 0n,
    commitEndsAt: 0n,
    revealEndsAt: 0n,
    commitCount: 0,
    revealCount: 0,
    medianScore: 0,
    refundBps: 0,
    rewardShares: 0,
    status: 0,
  };
}

function headroom(w: { cap: bigint; spent: bigint }): bigint {
  return w.cap > w.spent ? w.cap - w.spent : 0n;
}

/** A refusal from a contract, carrying the selector the node returns with it. */
class Reverted extends Error {
  constructor(readonly data: Hex) {
    super('execution reverted');
  }
}

/**
 * A method this node does not implement.
 *
 * Answered the way a real node answers it, as a JSON-RPC error rather than a dead connection.
 * viem probes for optional methods such as `eth_fillTransaction` and falls back when they are
 * refused, and a transport failure instead would look to the pool like a sick endpoint.
 */
class MethodNotFound extends Error {}

/** Every write goes through here, so one field on the state can refuse all three. */
function write<T>(state: NodeState, result: T): T {
  if (state.writeRevert !== null) throw new Reverted(state.writeRevert);

  return result;
}

/** A transaction this node was handed, as it arrived: signed, serialised and broadcast. */
export type SentTransaction = {
  raw: Hex;
  hash: Hex;
  to: Address;
  data: Hex;
  chainId: number;
  maxFeePerGas: bigint | undefined;
};

export type FakeNode = {
  state: NodeState;
  fetchFn: typeof fetch;
  calls: { method: string; params: readonly unknown[] }[];
  transactions: SentTransaction[];
};

export function createFakeNode(state: NodeState = defaultState()): FakeNode {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const transactions: SentTransaction[] = [];

  const fetchFn = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { id: number; method: string; params?: unknown[] };
    calls.push({ method: body.method, params: body.params ?? [] });

    const reply = (payload: Record<string, unknown>): Response =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    try {
      return reply({ result: handle(state, body.method, body.params ?? [], transactions) });
    } catch (error) {
      // The shape a node returns a refusal in: code 3, with the contract's own bytes on `data`.
      if (error instanceof Reverted) {
        return reply({ error: { code: 3, message: 'execution reverted', data: error.data } });
      }

      if (error instanceof MethodNotFound) return reply({ error: { code: -32_601, message: error.message } });

      throw error;
    }
  }) as typeof fetch;

  return { state, fetchFn, calls, transactions };
}

function handle(
  state: NodeState,
  method: string,
  params: readonly unknown[],
  transactions: SentTransaction[],
): unknown {
  switch (method) {
    case 'eth_chainId':
      return toHex(RHC_MAINNET.chainId);
    case 'eth_blockNumber':
      return toHex(state.blockNumber);
    case 'eth_getBlockByNumber':
      return block(state);
    case 'eth_call':
      return call(state, params[0] as { to: Address; data: Hex });
    case 'eth_getLogs':
      return logs(state, params[0] as { fromBlock?: Hex; toBlock?: Hex; address?: Address });
    case 'eth_getTransactionCount':
      return toHex(11n);
    case 'eth_estimateGas':
      return toHex(471_148n);
    case 'eth_maxPriorityFeePerGas':
      return toHex(1_000_000n);
    case 'eth_sendRawTransaction':
      return broadcast(params[0] as Hex, transactions);
    case 'eth_getTransactionReceipt':
      return receipt(state, params[0] as Hex, transactions);
    default:
      throw new MethodNotFound(`the fake node does not implement ${method}`);
  }
}

/** Takes a signed transaction as it came off the wire and keeps it for the test to read back. */
function broadcast(raw: Hex, transactions: SentTransaction[]): Hex {
  const parsed = parseTransaction(raw);
  const hash = keccak256(raw);

  transactions.push({
    raw,
    hash,
    to: (parsed.to ?? '0x') as Address,
    data: (parsed.data ?? '0x') as Hex,
    chainId: parsed.chainId ?? 0,
    maxFeePerGas: 'maxFeePerGas' in parsed ? parsed.maxFeePerGas : undefined,
  });

  return hash;
}

/**
 * The receipt of a broadcast transaction, with the log the account would have emitted.
 *
 * The event is built from the calldata that was actually signed, so a signer that encoded the
 * wrong merchant or the wrong amount reads it back wrong rather than being handed a fixture.
 */
function receipt(state: NodeState, hash: Hex, transactions: SentTransaction[]): unknown {
  const sent = transactions.find((transaction) => transaction.hash === hash);

  if (sent === undefined) return null;

  const decoded = decodeFunctionData({ abi: mandateAccountAbi, data: sent.data });
  const spends = decoded.functionName === 'spend' || decoded.functionName === 'spendApproved';
  const request = spends
    ? (decoded.args[0] as { merchant: Address; capabilityId: Hex; amount: bigint })
    : undefined;

  return {
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash: `0x${'ab'.repeat(32)}`,
    blockNumber: toHex(state.blockNumber),
    from: AGENT,
    to: sent.to,
    cumulativeGasUsed: toHex(471_148n),
    gasUsed: toHex(471_148n),
    effectiveGasPrice: toHex(20_000_000n),
    contractAddress: null,
    logsBloom: `0x${'00'.repeat(256)}`,
    status: state.receiptStatus,
    type: '0x2',
    logs:
      request === undefined
        ? []
        : [
            {
              address: ACCOUNT,
              topics: encodeEventTopics({
                abi: mandateAccountAbi,
                eventName: 'Spent',
                args: {
                  escrowId: state.nextEscrowId,
                  merchant: request.merchant,
                  capabilityId: request.capabilityId,
                },
              }),
              data: encodeAbiParameters(
                [{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }],
                [request.amount, state.daily.spent + request.amount, state.monthly.spent + request.amount],
              ),
              blockNumber: toHex(state.blockNumber),
              blockHash: `0x${'ab'.repeat(32)}`,
              transactionHash: hash,
              transactionIndex: '0x0',
              logIndex: '0x0',
              removed: false,
            },
          ],
  };
}

function block(state: NodeState): Record<string, unknown> {
  return {
    number: toHex(state.blockNumber),
    hash: `0x${'ab'.repeat(32)}`,
    parentHash: `0x${'cd'.repeat(32)}`,
    timestamp: toHex(state.timestamp),
    nonce: '0x0000000000000000',
    sha3Uncles: `0x${'00'.repeat(32)}`,
    logsBloom: `0x${'00'.repeat(256)}`,
    transactionsRoot: `0x${'00'.repeat(32)}`,
    stateRoot: `0x${'00'.repeat(32)}`,
    receiptsRoot: `0x${'00'.repeat(32)}`,
    miner: '0x0000000000000000000000000000000000000000',
    difficulty: '0x0',
    totalDifficulty: '0x0',
    extraData: '0x',
    size: '0x0',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    baseFeePerGas: toHex(state.baseFeePerGas),
    transactions: [],
    uncles: [],
  };
}

function call(state: NodeState, request: { to: Address; data: Hex }): Hex {
  if (request.to.toLowerCase() === RHC_MAINNET.multicall3.toLowerCase()) {
    const { args } = decodeFunctionData({ abi: multicall3Abi, data: request.data });
    const batch = (args?.[0] ?? []) as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
    const results = batch.map((entry) => ({
      success: true,
      returnData: call(state, { to: entry.target, data: entry.callData }),
    }));

    return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results });
  }

  const table = tableFor(request.to);
  const selector = request.data.slice(0, 10) as Hex;
  const entry = table.get(selector);

  if (entry === undefined) throw new Error(`the fake node has no answer for ${selector} at ${request.to}`);

  const decoded = decodeFunctionData({ abi: entry.abi, data: request.data });

  return encodeFunctionResult({
    abi: entry.abi,
    functionName: entry.functionName,
    result: entry.resolve((decoded.args ?? []) as readonly unknown[], state),
  });
}

function tableFor(to: Address): Map<Hex, Answer> {
  const target = to.toLowerCase();

  if (target === ACCOUNT.toLowerCase()) return ACCOUNT_ANSWERS;
  if (target === ESCROW.toLowerCase()) return ESCROW_ANSWERS;
  if (target === ASSET.toLowerCase()) return ASSET_ANSWERS;
  if (target === ORACLE_REGISTRY.toLowerCase()) return ORACLE_ANSWERS;
  if (target === AGENT_REGISTRY.toLowerCase()) return REGISTRY_ANSWERS;
  if (target === REPUTATION.toLowerCase()) return REPUTATION_ANSWERS;
  if (target === STAKING.toLowerCase()) return STAKING_ANSWERS;

  throw new Error(`the fake node holds no contract at ${to}`);
}

function logs(state: NodeState, filter: { fromBlock?: Hex; toBlock?: Hex; address?: Address }): unknown[] {
  const from = filter.fromBlock === undefined ? 0n : BigInt(filter.fromBlock);
  const to = filter.toBlock === undefined ? state.blockNumber : BigInt(filter.toBlock);

  return state.spent
    .filter((entry) => entry.blockNumber >= from && entry.blockNumber <= to)
    .sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber < b.blockNumber ? -1 : 1))
    .map((entry, index) => ({
      address: filter.address ?? ACCOUNT,
      topics: encodeEventTopics({
        abi: mandateAccountAbi,
        eventName: 'Spent',
        args: { escrowId: entry.escrowId, merchant: entry.merchant, capabilityId: entry.capabilityId },
      }),
      data: encodeAbiParameters(
        [{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }],
        [entry.amount, entry.dailySpent, entry.monthlySpent],
      ),
      blockNumber: toHex(entry.blockNumber),
      blockHash: `0x${'ab'.repeat(32)}`,
      transactionHash: entry.txHash,
      transactionIndex: toHex(index),
      logIndex: toHex(index),
      removed: false,
    }));
}
