import { escrowAbi } from '@bursar/core';
import { createPublicClient, createWalletClient, http, keccak256 } from 'viem';
import type { Address, Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

import { CHAIN_ID } from './config.js';

/**
 * Collecting an escrow payment: `release` on the lock, with a commitment to the bytes that were
 * served. That is the transaction that pays the provider. The lock's own escrow address is used,
 * not a configured one, because the lock is where the money is.
 */
export type Signer = { readonly account: PrivateKeyAccount; readonly rpcUrl: string };

export type LockRef = { readonly escrow: Address; readonly id: bigint };

export function outputCommit(served: ArrayBuffer | Uint8Array): Hex {
  return keccak256(served instanceof Uint8Array ? served : new Uint8Array(served));
}

export async function releaseLock(signer: Signer, lock: LockRef, commit: Hex): Promise<Hex> {
  const chain = {
    id: CHAIN_ID,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [signer.rpcUrl] } },
  } as const;
  const transport = http(signer.rpcUrl);
  const wallet = createWalletClient({ account: signer.account, chain, transport });
  const hash = await wallet.writeContract({
    address: lock.escrow,
    abi: escrowAbi,
    functionName: 'release',
    args: [lock.id, commit, ''],
  });
  const receipt = await createPublicClient({ chain, transport }).waitForTransactionReceipt({ hash, timeout: 25_000 });
  if (receipt.status !== 'success') throw new Error(`release ${hash} reverted`);
  return hash;
}
