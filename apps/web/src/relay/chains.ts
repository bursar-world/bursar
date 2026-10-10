import { defineChain } from 'viem';
import type { Address, Chain } from 'viem';
import { base } from 'viem/chains';

/**
 * Where a mandate can be funded from, other than Robinhood Chain itself.
 *
 * Relay carries the transfer: it quotes USDC on one of these chains against USDG on 4663, takes
 * the deposit on the source chain and pays the mandate from its own liquidity on this one. The
 * three listed here are the ones Relay lists with USDC and the ones the roadmap names. Adding a
 * fourth is a row in this table, provided Relay lists it.
 *
 * Solana carries Relay's own number for the chain, since Solana has no EVM chain id. It is the
 * value Relay expects in `originChainId` and nothing else reads it.
 */
export type SourceKey = 'base' | 'arc' | 'solana';

export type SourceCurrency = {
  /** The token's address on its chain, in that chain's own notation. */
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
};

export type SourceChain = {
  readonly key: SourceKey;
  /** The id Relay knows the chain by. */
  readonly chainId: number;
  readonly name: string;
  readonly vm: 'evm' | 'svm';
  readonly usdc: SourceCurrency;
  readonly explorerTx: (hash: string) => string;
  /** The chain as a wallet needs it to sign the deposit. Solana has no EVM wallet to hand it to. */
  readonly wagmi: Chain | undefined;
};

export const RELAY_SOLANA_CHAIN_ID = 792703809;

/**
 * Arc, as viem does not ship an endpoint for it. The gas token is USDC with eighteen decimals; the
 * USDC a wallet holds and sends is the six-decimal ERC-20 at the address below.
 */
export const arc: Chain = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc explorer', url: 'https://explorer.arc.io' } },
});

export const SOURCE_CHAINS: readonly SourceChain[] = [
  {
    key: 'base',
    chainId: base.id,
    name: 'Base',
    vm: 'evm',
    usdc: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
    explorerTx: (hash) => `https://basescan.org/tx/${hash}`,
    wagmi: base,
  },
  {
    key: 'arc',
    chainId: arc.id,
    name: 'Arc',
    vm: 'evm',
    usdc: { address: '0x3600000000000000000000000000000000000000', symbol: 'USDC', decimals: 6 },
    explorerTx: (hash) => `https://explorer.arc.io/tx/${hash}`,
    wagmi: arc,
  },
  {
    key: 'solana',
    chainId: RELAY_SOLANA_CHAIN_ID,
    name: 'Solana',
    vm: 'svm',
    usdc: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
    explorerTx: (signature) => `https://solscan.io/tx/${signature}`,
    wagmi: undefined,
  },
];

export function sourceChain(key: string): SourceChain | undefined {
  return SOURCE_CHAINS.find((chain) => chain.key === key);
}

export function sourceChainById(chainId: number): SourceChain | undefined {
  return SOURCE_CHAINS.find((chain) => chain.chainId === chainId);
}

/** The EVM chains a wallet in this console may be asked to switch to, for the wagmi config. */
export const SOURCE_WALLET_CHAINS: readonly Chain[] = SOURCE_CHAINS.flatMap((chain) => (chain.wagmi === undefined ? [] : [chain.wagmi]));

/**
 * Relay's own bridge page, opened with the route filled in, for a chain this console has no
 * wallet for. The reader signs there, in their own Solana wallet, and the USDG still lands in the
 * mandate: the recipient is the only address Relay pays.
 */
export function relayBridgeLink(input: {
  readonly source: SourceChain;
  readonly recipient: Address;
  readonly destinationCurrency: Address;
  /** Decimal, as typed: "0.50". Left off when nothing was typed. */
  readonly amount?: string;
}): string {
  const query = new URLSearchParams({
    fromChainId: String(input.source.chainId),
    fromCurrency: input.source.usdc.address,
    toCurrency: input.destinationCurrency,
    toAddress: input.recipient,
    tradeType: 'EXACT_INPUT',
  });
  if (input.amount !== undefined && input.amount !== '') query.set('amount', input.amount);
  return `https://relay.link/bridge/robinhood?${query.toString()}`;
}
