/**
 * Stand-ins for the two viem clients. They record every call so a suite can assert on encoded
 * intent. Reads come from a table the test supplies: an unexpected read fails loudly and never
 * returns a plausible zero.
 */
import type {
  Account,
  Address,
  Chain,
  Hex,
  Log,
  PublicClient,
  Transport,
  WalletClient,
} from 'viem';
import { RHC_MAINNET, viemChain } from '@bursar/core';
import type { Deployment } from '@bursar/core';
import { privateKeyToAccount } from 'viem/accounts';

import type { Connection, MandateAddresses } from '../../src/connection.js';

export type ReadCall = {
  address: Address;
  functionName: string;
  args: readonly unknown[];
};

export type SentTransaction = {
  to: Address;
  data: Hex;
  account: unknown;
  chain?: Chain;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

export type FakeOptions = {
  /** Answers `readContract`. Return `undefined` to fail the read with the function name. */
  read?: (call: ReadCall) => unknown;
  /** Answers `call`, which is what a preflight uses. Throw from here to simulate a revert. */
  simulate?: (call: { to: Address; data: Hex }) => Hex;
  blockTimestamp?: bigint;
  receiptStatus?: 'success' | 'reverted';
  logs?: readonly Log[];
  receiptError?: unknown;
  blockNumber?: bigint;
  hash?: Hex;
  /** What the node reports for fees. The chain floor is applied on top of it. */
  maxFeePerGas?: bigint;
  /** The key the fake signer is built from. Defaults to a fixed test key. */
  key?: Hex;
};

export type FakeConnection = {
  connection: Connection;
  reads: ReadCall[];
  simulated: { to: Address; data: Hex }[];
  sent: SentTransaction[];
  signed: unknown[];
  account: Account;
};

export const FAKE_HASH: Hex = `0x${'ab'.repeat(32)}`;
export const TEST_KEY: Hex = `0x${'11'.repeat(32)}`;

export const ADDRESSES: MandateAddresses = {
  mandateAccountFactory: '0xE8F7a9a841F58E0d3847b7Eb6D7583fc37e881e9',
  escrow: '0x8E298457cDFc1Cb9ef6253D36d3BD5cFEf10F915',
  reputation: '0xbC4f89F964f5d8ff20a423B5261Aa3c75552d2a4',
  agentRegistry: '0x6Cc07e0B50a3591c5F00c3a15Ea2880f637DA5D6',
  oracleRegistry: '0xB19D930309eAfb22287A960102cCFf2429C72514',
  adminTimelock: '0x684a6f1495DceFFbc953fd1529DFDbda88Bd44b2',
  settlementAsset: RHC_MAINNET.usdg,
};

/**
 * A deployment record for chain 4663, supplied rather than looked up.
 *
 * Supplying it keeps these suites off the committed record, which changes with every deploy. The
 * addresses are stand-ins; the settlement asset and the chain id are not, because `connect()`
 * checks both against the chain config and a test that faked either would not exercise the check.
 */
export const RHC_DEPLOYMENT: Deployment = {
  network: 'rhc-mainnet',
  chainId: RHC_MAINNET.chainId,
  status: 'live',
  rpc: RHC_MAINNET.rpcUrl,
  explorer: RHC_MAINNET.explorer,
  settlementAsset: RHC_MAINNET.usdg,
  settlementDecimals: 6,
  deployer: '0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4',
  contracts: {
    AdminTimelock: ADDRESSES.adminTimelock,
    Reputation: ADDRESSES.reputation,
    Escrow: ADDRESSES.escrow,
    OracleRegistry: ADDRESSES.oracleRegistry,
    AgentRegistry: ADDRESSES.agentRegistry,
    MandateAccountFactory: ADDRESSES.mandateAccountFactory,
  },
  roles: {
    timelockSigners: ['0xC53769488DdE6f92b8e5149a6b5A64128564da0d'],
    guardian: '0xCB16Fb037C55a4b256C743a8DEf9f7F4d288F70f',
    treasury: '0x7F97980568AD3bFe77B2150b5cdD98eB5f271718',
    slashSink: '0xd2C622cFF4FE816453Ffe6F8B17Edc2a66923775',
  },
  verifiedOnChain: {},
  examples: {},
};

export function fakeConnection(options: FakeOptions = {}): FakeConnection {
  const reads: ReadCall[] = [];
  const simulated: { to: Address; data: Hex }[] = [];
  const sent: SentTransaction[] = [];
  const signed: unknown[] = [];
  const hash = options.hash ?? FAKE_HASH;
  const account = privateKeyToAccount(options.key ?? TEST_KEY);

  const publicClient = {
    readContract: async (call: ReadCall): Promise<unknown> => {
      const recorded = { address: call.address, functionName: call.functionName, args: call.args ?? [] };
      reads.push(recorded);

      const answer = options.read?.(recorded);
      if (answer === undefined) {
        throw new Error(`Unexpected read: ${call.functionName} on ${call.address}`);
      }

      return answer;
    },
    call: async (call: { to: Address; data: Hex }): Promise<{ data: Hex }> => {
      simulated.push({ to: call.to, data: call.data });
      return { data: options.simulate?.(call) ?? '0x' };
    },
    estimateFeesPerGas: async (): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> => ({
      maxFeePerGas: options.maxFeePerGas ?? 22_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
    getBlock: async (): Promise<{ timestamp: bigint; number: bigint }> => ({
      timestamp: options.blockTimestamp ?? 1_800_000_000n,
      number: options.blockNumber ?? 100n,
    }),
    waitForTransactionReceipt: async (): Promise<unknown> => {
      if (options.receiptError !== undefined) throw options.receiptError;

      return {
        transactionHash: hash,
        status: options.receiptStatus ?? 'success',
        logs: options.logs ?? [],
        blockNumber: options.blockNumber ?? 100n,
      };
    },
  };

  const walletClient = {
    account,
    chain: viemChain(RHC_MAINNET),
    sendTransaction: async (transaction: SentTransaction): Promise<Hex> => {
      sent.push(transaction);
      return hash;
    },
    signTypedData: async (parameters: Record<string, unknown>): Promise<Hex> => {
      signed.push(parameters);
      const { account: _ignored, ...typedData } = parameters;
      return account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0]);
    },
  };

  const connection: Connection = {
    chain: RHC_MAINNET,
    deployment: RHC_DEPLOYMENT,
    addresses: ADDRESSES,
    publicClient: publicClient as unknown as PublicClient<Transport, Chain>,
    walletClient: walletClient as unknown as WalletClient<Transport, Chain, Account>,
    account,
    pool: undefined,
    receiptTimeoutMs: 60_000,
  };

  return { connection, reads, simulated, sent, signed, account };
}
