import {
  V1_ABIS,
  V2_ABIS,
  V3_ABIS,
  contractSetOf,
  deploymentsForChain,
  settlementAssetAbi,
  type ContractSet,
  type Deployment,
} from '@bursar/core';
import type { Address, PublicClient } from 'viem';

import type { Leaf } from './tree.js';

/** `LockStatus.Locked` and `LockStatus.Disputed`: the only states in which the escrow still holds a lock's money. */
const LOCKED = 1;
const DISPUTED = 4;

export type Reader = Pick<PublicClient, 'readContract'>;

const ABIS: Readonly<Record<ContractSet, typeof V1_ABIS | typeof V2_ABIS | typeof V3_ABIS>> = {
  v1: V1_ABIS,
  v2: V2_ABIS,
  v3: V3_ABIS,
};

const isZero = (address: Address): boolean => /^0x0{40}$/i.test(address);

/**
 * Reads every leaf at one block, from public state only.
 *
 * Per escrow: liabilities are the amount and dispute bond of every open lock (Locked or Disputed),
 * the fees booked and not yet swept, and, from v3, every payout a settlement booked as owed because
 * the token would not deliver it; assets are its USDG balance. Per oracle registry: liabilities are
 * the reward float owed to resolvers; assets are its USDG balance. A released lock has already paid
 * its payee, so it is not owed.
 *
 * Not included: the treasury lane and stock purchases. Those positions sit in per-mandate vaults as
 * SGOV or stock tokens owned by the mandate, not in a pool the protocol owes out of, and valuing
 * them needs a feed price rather than an exact balance. Bonds in BRSR on the staking pool are a
 * different token and are also left out.
 */
export async function snapshot(
  client: Reader,
  blockNumber: bigint,
  deployments: readonly Deployment[] = deploymentsForChain(4663),
): Promise<Leaf[]> {
  const leaves: Leaf[] = [];
  for (const d of deployments) {
    const set = contractSetOf(d);
    const abis = ABIS[set];
    const usdg = (holder: Address) =>
      client.readContract({
        address: d.settlementAsset,
        abi: settlementAssetAbi,
        functionName: 'balanceOf',
        args: [holder],
        blockNumber,
      }) as Promise<bigint>;

    const escrow = d.contracts.Escrow;
    const read = (functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address: escrow, abi: abis.Escrow, functionName, args, blockNumber } as never) as Promise<unknown>;

    const nextId = (await read('nextId')) as bigint;
    let liabilities = (await read('feesAccrued')) as bigint;
    const parties = new Map<string, Address>();
    for (let id = 1n; id < nextId; id++) {
      const lock = (await read('getLock', [id])) as {
        status: number;
        amount: bigint;
        bond: bigint;
        payer: Address;
        payee: Address;
        disputer: Address;
      };
      if (lock.status === LOCKED || lock.status === DISPUTED) liabilities += lock.amount + lock.bond;
      for (const party of [lock.payer, lock.payee, lock.disputer]) if (!isZero(party)) parties.set(party.toLowerCase(), party);
    }
    // The escrow keeps no total of what it owes, only an amount per recipient. Every recipient is a
    // party to some lock, or the registry its resolver fees go to, so reading each of those once
    // covers all of it.
    if (set === 'v3') {
      parties.set(d.contracts.OracleRegistry.toLowerCase(), d.contracts.OracleRegistry);
      for (const party of parties.values()) liabilities += (await read('owed', [party])) as bigint;
    }
    leaves.push({ id: `${d.network}:Escrow`, liabilities, assets: await usdg(escrow) });

    const registry = d.contracts.OracleRegistry;
    const rewardFloat = (await client.readContract({
      address: registry,
      abi: abis.OracleRegistry,
      functionName: 'rewardFloat',
      blockNumber,
    } as never)) as bigint;
    leaves.push({ id: `${d.network}:OracleRegistry`, liabilities: rewardFloat, assets: await usdg(registry) });
  }
  return leaves;
}
