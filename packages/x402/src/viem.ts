import { settlementAssetAbi, tokenVersionAbi } from '@bursar/core';
import type { RhcPublicClient } from '@bursar/core';
import type { Account, Chain, Transport, WalletClient } from 'viem';
import { SettlementNotSentError } from './errors.js';
import { isRevert, readControl } from './issuer.js';
import { permit2Abi } from './permit2.js';
import type {
  ControlReading,
  IssuerControls,
  PaymentChain,
  SettlementCall,
  SettlementSigner,
  TokenIdentity,
  TransactionReceipt,
  TypedDataCheck,
} from './ports.js';

/**
 * The adapters that put a real chain behind the ports.
 *
 * Everything above this file is decision logic and is tested without a network. This is the only
 * place viem appears, and it contains no decisions: it reads what it is asked to read and submits
 * what it is handed.
 *
 * The client comes from `createRhcClient` in `@bursar/core`, which carries the two-provider pool
 * and the provider breaker. Building a transport here would route settlement around them.
 */
export function createPaymentChain(client: RhcPublicClient): PaymentChain {
  const chainId = client.chain.id;

  return {
    chainId,

    async verifyTypedData(check: TypedDataCheck): Promise<boolean> {
      // An agent's wallet is often a contract, and only the client action can ask a contract
      // wallet through EIP-1271. The offline recovery helper cannot.
      return client.verifyTypedData({
        address: check.address,
        domain: check.domain,
        types: check.types,
        primaryType: check.primaryType,
        message: check.message,
        signature: check.signature,
      });
    },

    async tokenIdentity(token: `0x${string}`): Promise<TokenIdentity> {
      // `version()` is optional in practice and reverting on it must not cost the three reads that
      // did answer. USDG is a diamond proxy: every call it has no facet for reverts with
      // `FacetNotFound`, and that is the answer for `version()` on Robinhood Chain. The version
      // that ends up in the domain is proved against `DOMAIN_SEPARATOR` by `resolveAsset`, so a
      // token that stays silent here costs a check, not a guess.
      const [name, version, decimals, domainSeparator] = await Promise.all([
        client.readContract({ address: token, abi: settlementAssetAbi, functionName: 'name' }),
        // Only a revert means the token publishes no version. A transport failure rethrows, rather
        // than letting a supplied version stand in and fail later as a confusing domain mismatch.
        client
          .readContract({ address: token, abi: tokenVersionAbi, functionName: 'version' })
          .catch((error: unknown) => {
            if (isRevert(error)) return undefined;
            throw error;
          }),
        client.readContract({ address: token, abi: settlementAssetAbi, functionName: 'decimals' }),
        client.readContract({ address: token, abi: settlementAssetAbi, functionName: 'DOMAIN_SEPARATOR' }),
      ]);
      return version === undefined
        ? { name, decimals, domainSeparator }
        : { name, version, decimals, domainSeparator };
    },

    async balanceOf(token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
      return client.readContract({
        address: token,
        abi: settlementAssetAbi,
        functionName: 'balanceOf',
        args: [owner],
      });
    },

    async allowance(
      token: `0x${string}`,
      owner: `0x${string}`,
      spender: `0x${string}`,
    ): Promise<bigint> {
      return client.readContract({
        address: token,
        abi: settlementAssetAbi,
        functionName: 'allowance',
        args: [owner, spender],
      });
    },

    async authorizationState(
      token: `0x${string}`,
      authorizer: `0x${string}`,
      nonce: `0x${string}`,
    ): Promise<boolean> {
      return client.readContract({
        address: token,
        abi: settlementAssetAbi,
        functionName: 'authorizationState',
        args: [authorizer, nonce],
      });
    },

    async issuerControls(
      token: `0x${string}`,
      parties: readonly `0x${string}`[],
    ): Promise<IssuerControls> {
      // One wave, so the issuer's view of a payment costs the same round trip as the balance read
      // it travels with. The pool paces these; three calls that wait on each other would not.
      const [paused, ...frozen] = await Promise.all([
        readControl(() =>
          client.readContract({ address: token, abi: settlementAssetAbi, functionName: 'paused' }),
        ),
        ...parties.map((address) =>
          readControl(() =>
            client.readContract({
              address: token,
              abi: settlementAssetAbi,
              functionName: 'isFrozen',
              args: [address],
            }),
          ),
        ),
      ]);

      const missing: ControlReading = {
        state: 'unreadable',
        detail: 'the batched read came back short one answer',
      };
      return {
        asset: token,
        paused: paused ?? missing,
        parties: parties.map((address, index) => ({ address, frozen: frozen[index] ?? missing })),
      };
    },

    async permitNonce(token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
      return client.readContract({
        address: token,
        abi: settlementAssetAbi,
        functionName: 'nonces',
        args: [owner],
      });
    },

    async nonceBitmap(permit2: `0x${string}`, owner: `0x${string}`, word: bigint): Promise<bigint> {
      return client.readContract({
        address: permit2,
        abi: permit2Abi,
        functionName: 'nonceBitmap',
        args: [owner, word],
      });
    },

    async hasCode(address: `0x${string}`): Promise<boolean> {
      const code = await client.getCode({ address });
      return code !== undefined && code !== '0x';
    },

    async simulate(call: SettlementCall, from: `0x${string}`): Promise<void> {
      // eth_call from the relayer, because it is the relayer whose gas a revert would burn.
      await client.call({ account: from, to: call.to, data: call.data });
    },

    async waitForReceipt(hash: `0x${string}`, timeoutMs: number): Promise<TransactionReceipt> {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
      return { status: receipt.status, gasUsed: receipt.gasUsed };
    },
  };
}

export type WalletSignerOptions = {
  /**
   * Used together to price the transaction. A chain that enforces a floor on maxFeePerGas exposes
   * it as `minFeeCap` on the chain record, and a transaction priced under such a floor is rejected
   * by the node rather than mined late, so the estimate is raised to it when it falls short.
   * Robinhood Chain has one: `ArbGasInfo.getMinimumGasPrice()` reads 20,000,000 wei, carried as
   * `RHC_MAINNET.minFeeCap`. Pass it. The observed base fee sits above the floor, so a caller
   * that omits it usually gets included anyway and discovers the omission on a quiet chain.
   */
  readonly client?: RhcPublicClient;
  readonly minFeePerGas?: bigint;
};

/**
 * The relayer, backed by a wallet client whose account is already attached.
 *
 * This package never constructs an account and never sees a key. The gas float behind this address
 * is separate from settlement and collateral, and `@bursar/core` fails startup when the three
 * collide.
 */
export function createWalletSigner(
  wallet: WalletClient<Transport, Chain, Account>,
  options: WalletSignerOptions = {},
): SettlementSigner {
  const { client, minFeePerGas } = options;

  return {
    address: wallet.account.address,

    async send(call: SettlementCall): Promise<`0x${string}`> {
      if (client === undefined || minFeePerGas === undefined) {
        return wallet.sendTransaction({
          account: wallet.account,
          chain: wallet.chain,
          to: call.to,
          data: call.data,
        });
      }

      let fees: { readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint };
      try {
        fees = await client.estimateFeesPerGas();
      } catch (error) {
        // Pricing happens before anything is signed, so a failure here has sent nothing. Saying so
        // lets the caller release the payer's nonce claim instead of holding it as a maybe-broadcast.
        throw new SettlementNotSentError(
          `fee estimation failed before the transaction was sent: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const maxFeePerGas = fees.maxFeePerGas > minFeePerGas ? fees.maxFeePerGas : minFeePerGas;
      return wallet.sendTransaction({
        account: wallet.account,
        chain: wallet.chain,
        to: call.to,
        data: call.data,
        maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
    },
  };
}
