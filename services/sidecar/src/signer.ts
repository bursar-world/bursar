import { viemChain } from '@bursar/core';
import type { RhcChain, RpcPool } from '@bursar/core';
import { createNonceManager, createWalletClient, custom } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Chain, PrivateKeyAccount, Transport, WalletClient } from 'viem';

export type Signer = {
  readonly wallet: WalletClient<Transport, Chain, PrivateKeyAccount>;
  /** The payee of record. `release` accepts this address and no other. */
  readonly address: Address;
};

export type SignerOptions = {
  readonly key: `0x${string}`;
  readonly chain: RhcChain;
  /** Shared with the read client so both sides of the service see one set of breaker decisions. */
  readonly pool: RpcPool;
};

/**
 * Builds the payee identity.
 *
 * This is the provider's own key and it signs the provider's own settlement calls. It never
 * touches a payer's funds: `release`, `finalizeRelease` and `dispute` all move money the escrow
 * already holds, and the escrow decides where it goes. Nothing here can sign on behalf of anyone
 * else, and the key itself is read once into viem's local account and never returned, logged or
 * attached to an error, so only the derived address leaves this module.
 *
 * Separating the gas float from settlement does not reach here and cannot: the
 * escrow pays the payee address, and only the payee address may call `release`, so the account
 * that earns is the account that pays the fee by construction. The counterpart control is the gas
 * floor warning, which tells an operator to refill before the sidecar stops being able to settle.
 */
export function createSigner(options: SignerOptions): Signer {
  /**
   * One place that decides this account's next nonce.
   *
   * Without it every write asks the chain for a pending count, through a pool that fails over
   * between independent providers. Two of them do not share a mempool: the one that answers the
   * second question may never have seen the transaction the first one accepted, so it reports the
   * nonce already used and the sidecar signs a replacement for a transaction still in flight. One
   * of the two is dropped, and which one is up to whoever mines first. The manager keeps the count
   * here and hands out consecutive nonces whatever the pool did.
   */
  const nonceManager = createNonceManager({
    source: {
      // Through the pool, like every other call this service makes, so the nonce and the
      // transaction that uses it are read across the same set of providers and the same breaker.
      get: ({ address }) =>
        options.pool
          .request('eth_getTransactionCount', [address, 'pending'])
          .then((count) => Number(BigInt(count as string))),
      set: () => undefined,
    },
  });

  const account = privateKeyToAccount(options.key, { nonceManager });

  const wallet = createWalletClient({
    account,
    chain: viemChain(options.chain),
    transport: custom(
      {
        request: ({ method, params }) => options.pool.request(method, (params ?? []) as readonly unknown[]),
      },
      // The pool already fails over between providers. viem retrying the same dead endpoint on top
      // of that turns a failover into a stall.
      { retryCount: 0 },
    ),
  });

  return { wallet, address: account.address };
}
