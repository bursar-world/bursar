import { BASE_MAINNET, baseViemChain, escrowAbi, settlementAssetAbi, tokenVersionAbi, viemChain } from '@bursar/core';
import type { RhcChain } from '@bursar/core';
import { createPublicClient, createWalletClient, domainSeparator, http, parseAbiItem } from 'viem';
import type { Address, Hex, TypedDataDomain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { BaseFloat, LockWriter, TransferAuthorization } from './ports.js';

/**
 * The two chains behind the lane's ports. No decisions here: this file reads what it is asked to
 * read, signs what it is handed and sends what it is given. The key arrives as an account and the
 * lane never sees it.
 */

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const AUTHORIZATION_USED = parseAbiItem('event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)');

/** How far back one log read may reach. Base makes a block every two seconds. */
const LOG_WINDOW_BLOCKS = 5_000n;

export type BaseFloatOptions = {
  readonly key: Hex;
  readonly rpcUrl?: string;
  readonly asset?: Address;
};

export function createBaseFloat(options: BaseFloatOptions): BaseFloat {
  const account = privateKeyToAccount(options.key);
  const asset = options.asset ?? BASE_MAINNET.usdc;
  const client = createPublicClient({ chain: baseViemChain(options.rpcUrl), transport: http(options.rpcUrl ?? BASE_MAINNET.rpcUrl) });
  let domain: Promise<TypedDataDomain> | null = null;

  /**
   * The token's EIP-712 domain, read from the token and proved against its separator. USDC on Base
   * reports name "USD Coin" and version "2"; the published x402 example carries the testnet token's
   * name, and a domain one character off signs a well-formed authorization against nothing.
   */
  const readDomain = async (): Promise<TypedDataDomain> => {
    const [name, version, separator] = await Promise.all([
      client.readContract({ address: asset, abi: settlementAssetAbi, functionName: 'name' }),
      client.readContract({ address: asset, abi: tokenVersionAbi, functionName: 'version' }),
      client.readContract({ address: asset, abi: settlementAssetAbi, functionName: 'DOMAIN_SEPARATOR' }),
    ]);
    const candidate: TypedDataDomain = { name, version, chainId: BASE_MAINNET.chainId, verifyingContract: asset };
    if (domainSeparator({ domain: candidate }).toLowerCase() !== separator.toLowerCase()) {
      throw new Error(`USDC at ${asset} reports name ${JSON.stringify(name)} and version ${JSON.stringify(version)}, and its DOMAIN_SEPARATOR is not the one those produce`);
    }
    return candidate;
  };

  return {
    network: BASE_MAINNET.network,
    asset,
    address: account.address,
    balance: () => client.readContract({ address: asset, abi: settlementAssetAbi, functionName: 'balanceOf', args: [account.address] }),
    blockNumber: () => client.getBlockNumber(),
    authorizationUsed: (nonce) =>
      client.readContract({ address: asset, abi: settlementAssetAbi, functionName: 'authorizationState', args: [account.address, nonce] }),
    async authorizationTransaction(nonce, fromBlock) {
      const head = await client.getBlockNumber();
      const start = head - fromBlock > LOG_WINDOW_BLOCKS ? head - LOG_WINDOW_BLOCKS : fromBlock;
      const logs = await client.getLogs({ address: asset, event: AUTHORIZATION_USED, args: { authorizer: account.address, nonce }, fromBlock: start, toBlock: head });
      return logs[0]?.transactionHash ?? null;
    },
    async signAuthorization(authorization: TransferAuthorization) {
      domain ??= readDomain().catch((error: unknown) => {
        domain = null;
        throw error;
      });
      return account.signTypedData({
        domain: await domain,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: { ...authorization },
      });
    },
  };
}

export type LockWriterOptions = {
  readonly key: Hex;
  readonly chain: RhcChain;
  readonly rpcUrl: string;
  readonly receiptTimeoutMs?: number;
};

/** The float's address as a payee on Robinhood Chain: it releases and cancels its own locks. */
export function createLockWriter(options: LockWriterOptions): LockWriter {
  const account = privateKeyToAccount(options.key);
  const chain = viemChain(options.chain);
  const transport = http(options.rpcUrl);
  const client = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });

  const send = async (functionName: 'release' | 'cancel', escrow: Address, args: readonly unknown[]): Promise<Hex> => {
    const fees = await client.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas > options.chain.minFeeCap ? fees.maxFeePerGas : options.chain.minFeeCap;
    const hash = await wallet.writeContract({
      address: escrow,
      abi: escrowAbi,
      functionName,
      args: args as never,
      maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: options.receiptTimeoutMs ?? 60_000 });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted in ${hash}`);
    return hash;
  };

  return {
    release: (escrow, id, outputCommit, outputURI) => send('release', escrow, [id, outputCommit, outputURI]),
    cancel: (escrow, id) => send('cancel', escrow, [id]),
  };
}

export function floatAddress(key: Hex): Address {
  return privateKeyToAccount(key).address;
}
