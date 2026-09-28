import { createRhcClient, viemChain } from '@bursar/core';
import type { RhcChain, RhcClient, RpcProvider } from '@bursar/core';
import { nonceManager, privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, custom } from 'viem';
import type { PrivateKeyAccount } from 'viem';
import { resolveAsset } from './domain.js';
import type { AssetMeta } from './domain.js';
import { X402ConfigError } from './errors.js';
import { createExactEvm } from './exact-evm.js';
import type { ExactEvm, NetworkSettlement } from './exact-evm.js';
import type { PaymentChain } from './ports.js';
import { createPaymentChain, createWalletSigner } from './viem.js';
import type { TransferMethod } from './types.js';

/**
 * One asynchronous call that turns flat configuration into a running scheme.
 *
 * A service that wants to settle should not have to know that the domain separator is read from
 * the token, that the relayer is also the permit spender, or that USDG publishes no EIP-712
 * version. It has a chain, a list of RPC endpoints, a relayer key and a list of assets. Between
 * those and `createExactEvm` is assembly, and assembly belongs on this side of the boundary so
 * that a caller cannot get it subtly wrong.
 *
 * Late-bound: the facilitator imports this by name at run time so it stays buildable and testable
 * without a chain client. See `loadScheme` there.
 */
export type ExactSchemeConfig = {
  readonly chain: RhcChain;
  readonly providers?: readonly RpcProvider[];
  /**
   * The relayer's own key, and only ever that.
   *
   * It pays gas and broadcasts authorisations that payers signed. It is never a payer's key and
   * never holds settlement or collateral: the facilitator's config fails startup when the
   * relayer address is anything but the gas float (every role has its own address).
   */
  readonly relayerKey?: `0x${string}`;
  /** Token addresses to settle in. Their EIP-712 domains are read from the tokens themselves. */
  readonly assets?: readonly `0x${string}`[];
  readonly methods?: readonly TransferMethod[];
  /**
   * The EIP-712 version for a settlement asset that publishes none. USDG is one: it is a diamond
   * proxy and `version()` reverts. Whatever is used here is checked against the token's own
   * DOMAIN_SEPARATOR before a payment is signed against it.
   */
  readonly assetVersion?: string;
  readonly requireBinding?: boolean;
  /** Supplied by tests so the assembly above can be exercised without a node. */
  readonly client?: PaymentChain;
};

export async function createExactScheme(config: ExactSchemeConfig): Promise<ExactEvm> {
  const chain = config.chain;
  if (!chain || typeof chain.chainId !== 'number') {
    throw new X402ConfigError('x402_config_invalid', 'createExactScheme needs a chain', {});
  }

  const assets = config.assets && config.assets.length > 0 ? config.assets : [chain.usdg];

  let rhc: RhcClient | null = null;
  let payments: PaymentChain;
  if (config.client === undefined) {
    rhc = createRhcClient({ chain, ...(config.providers ? { providers: config.providers } : {}) });
    payments = createPaymentChain(rhc.client);
  } else {
    payments = config.client;
  }

  const resolved: AssetMeta[] = [];
  for (const token of assets) {
    // Sequential rather than concurrent: each asset is four reads, and a fresh deployment hitting
    // a public endpoint with all of them at once is the shape that earns a 429.
    resolved.push(
      await resolveAsset(payments, token, {
        permit2: chain.permit2,
        ...(config.assetVersion === undefined ? {} : { version: config.assetVersion }),
      }),
    );
  }

  const settlement: NetworkSettlement = {
    chain,
    client: payments,
    assets: resolved,
    permit2: chain.permit2,
    ...(config.methods ? { methods: config.methods } : {}),
    ...(signerFor(config, rhc) ?? {}),
  };

  return createExactEvm({
    networks: [settlement],
    ...(config.requireBinding === undefined ? {} : { requireBinding: config.requireBinding }),
  });
}

/**
 * The relayer's account, with a nonce manager attached.
 *
 * This one address broadcasts every settlement, so it is the one place in the repo where two
 * writes are genuinely in flight at once. Without the manager both read the same pending nonce
 * from the node and the second is rejected, after the ledger row and the budget slot it consumed
 * have already been spent on it.
 */
export function relayerAccount(privateKey: `0x${string}`): PrivateKeyAccount {
  return privateKeyToAccount(privateKey, { nonceManager });
}

/**
 * The signer half, absent on a verify-only deployment.
 *
 * `relayer` is set explicitly, not left to default to the signer. Verification may run in a
 * different process from settlement, and a permit naming some other facilitator as its spender
 * has to be refusable there too.
 */
function signerFor(
  config: ExactSchemeConfig,
  rhc: RhcClient | null,
): Pick<NetworkSettlement, 'signer' | 'relayer'> | null {
  if (!config.relayerKey) return null;
  if (!rhc) {
    throw new X402ConfigError(
      'x402_config_invalid',
      'a relayer key needs a real chain client; pass providers rather than a stub',
      {},
    );
  }

  const account = relayerAccount(config.relayerKey);
  const wallet = createWalletClient({
    account,
    chain: viemChain(config.chain),
    // Shares the pool and breaker the reads already go through. A second transport here would
    // route settlement around the redundancy that the provider breaker exists to provide.
    transport: custom({ request: ({ method, params }) => rhc.pool.request(method, (params ?? []) as readonly unknown[]) }, { retryCount: 0 }),
  });

  return {
    signer: createWalletSigner(wallet, { client: rhc.client, minFeePerGas: config.chain.minFeeCap }),
    relayer: account.address,
  };
}
