import { RHC_MAINNET, RHC_MAINNET_USDG_DOMAIN, caip2, parseMicro } from '@bursar/core';
import type { Caip2 } from '@bursar/core';
import { sameNetwork } from './network.js';

/**
 * Robinhood Chain as an x402 network, in the shape the reference SDKs keep per chain.
 *
 * The reference client needs three things to pay on a chain it has never heard of: the CAIP-2
 * name, the asset, and the EIP-712 domain the asset's `transferWithAuthorization` is signed under.
 * The reference server needs one more, a default stablecoin, to turn `"$0.01"` into atomic units.
 * All four are here, read from `@bursar/core` where they are checked against the chain. A resource
 * server built on the reference packages quotes USDG on Robinhood Chain with `usdgPrice` or by
 * registering `robinhoodChainMoneyParser`, and a client built on them signs what the server quotes.
 */
export const ROBINHOOD_CHAIN = Object.freeze({
  network: caip2(RHC_MAINNET.chainId),
  chainId: RHC_MAINNET.chainId,
  name: RHC_MAINNET.name,
  explorer: RHC_MAINNET.explorer,
  /** The keyless facilitator for the standard `exact` scheme in USDG. */
  facilitator: 'https://facilitator.bursar.world/x402',
  asset: Object.freeze({
    asset: RHC_MAINNET.usdg,
    name: RHC_MAINNET_USDG_DOMAIN.name,
    version: RHC_MAINNET_USDG_DOMAIN.version,
    decimals: RHC_MAINNET.usdgDecimals,
    symbol: 'USDG',
  }),
});

/** A price in the reference SDK's `AssetAmount` shape, with the domain a payer signs under. */
export type UsdgPrice = {
  readonly asset: `0x${string}`;
  /** Atomic units of USDG: six decimals. */
  readonly amount: string;
  readonly extra: { readonly name: string; readonly version: string };
};

/**
 * A price in USDG on Robinhood Chain, from a dollar figure such as `"0.01"`, `"$0.01"` or `0.01`.
 *
 * Six decimals is the asset's precision, and a figure finer than that is refused rather than
 * rounded: a server that quotes a price the asset cannot carry would have every payment refused as
 * a value mismatch.
 */
export function usdgPrice(dollars: string | number): UsdgPrice {
  const text = typeof dollars === 'number' ? dollars.toString() : dollars.trim().replace(/^\$/, '');
  const { asset, name, version } = ROBINHOOD_CHAIN.asset;
  return { asset, amount: parseMicro(text).toString(), extra: { name, version } };
}

/**
 * The reference server's `MoneyParser` for Robinhood Chain.
 *
 * `ExactEvmScheme.registerMoneyParser` in `@x402/evm` calls each registered parser with the dollar
 * figure a route quoted; this one answers for Robinhood Chain and defers for every other network,
 * so a server that serves several chains keeps its other defaults.
 */
export async function robinhoodChainMoneyParser(
  amount: string | number,
  network: `${string}:${string}`,
): Promise<UsdgPrice | null> {
  return sameNetwork(network, ROBINHOOD_CHAIN.network) ? usdgPrice(amount) : null;
}

/** What a stock client lists under `spendControls.allowedAssets`. */
export type UsdgSpendControl = {
  readonly network: Caip2;
  readonly asset: `0x${string}`;
  /** Atomic USDG, the unit the reference client caps a listed asset in. Absent means no cap. */
  readonly maxAmountPerPayment?: string;
};

/**
 * USDG on Robinhood Chain as an allowed asset for the reference client.
 *
 * `x402Client` in `@x402/core` refuses any asset outside the upstream default table unless the
 * client lists it. Until that table carries USDG, a client sets
 * `spendControls({ allowedAssets: [usdgSpendControl('$1')] })`; afterwards the line is harmless.
 * The cap is a dollar figure here and atomic units on the wire, because that is the unit the
 * client caps a listed asset in.
 */
export function usdgSpendControl(maxPerPayment?: string | number): UsdgSpendControl {
  const { network, asset } = { network: ROBINHOOD_CHAIN.network, asset: ROBINHOOD_CHAIN.asset.asset };
  return maxPerPayment === undefined ? { network, asset } : { network, asset, maxAmountPerPayment: usdgPrice(maxPerPayment).amount };
}
