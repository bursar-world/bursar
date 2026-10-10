import { defineChain } from 'viem';
import type { Chain } from 'viem';

import { caip2 } from './chain.js';
import type { Caip2 } from './chain.js';

/**
 * Base, as the Base lane sees it: the one chain the x402 ecosystem settles the `exact` scheme on
 * for real money, and the one asset it does it in.
 *
 * Read from the token on 2026-10-10: USDC on Base is six decimals, and its EIP-712 domain is
 * `name "USD Coin", version "2"`. The published x402 example carries the testnet token's `"USDC"`,
 * which signs a well-formed authorization against nothing. Nothing here signs against a pinned
 * domain; the facilitator reads the token and proves the domain against `DOMAIN_SEPARATOR` first,
 * the way it does for USDG. The constants exist so the client and the facilitator cannot disagree
 * about which chain and which token the lane means.
 */
export type BaseChain = {
  readonly name: string;
  readonly chainId: 8453;
  readonly network: Caip2;
  readonly rpcUrl: string;
  readonly explorer: string;
  readonly usdc: `0x${string}`;
  readonly usdcDecimals: 6;
};

export const BASE_MAINNET: BaseChain = Object.freeze({
  name: 'Base',
  chainId: 8453,
  network: caip2(8453),
  // The keyless endpoint that verifies and settles without rate-limiting a burst of four reads.
  rpcUrl: 'https://base.drpc.org',
  explorer: 'https://basescan.org',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  usdcDecimals: 6,
});

export function baseViemChain(rpcUrl: string = BASE_MAINNET.rpcUrl): Chain {
  return defineChain({
    id: BASE_MAINNET.chainId,
    name: BASE_MAINNET.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'Basescan', url: BASE_MAINNET.explorer } },
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  });
}
