import { rwaDeployment } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { formatUnits } from 'viem';
import type { Address } from 'viem';

import { TOKEN_ADDRESSES } from '@/chain/generated/token';
import { ADDRESSES, CHAIN_ID, sameAddress, shortAddress } from '@/chain/rhc';
import { usd } from './usd';

export type TokenInfo = { readonly symbol: string; readonly decimals: number; readonly settlement: boolean };

/**
 * What a token address is, for a line that moved it. USDG is the settlement asset and reads in
 * dollars; the stock and treasury tokens and BRSR carry eighteen decimals and read in their own
 * symbol. An address none of the records name is left undefined, and the caller says so.
 */
export function tokenInfo(token: Address): TokenInfo | undefined {
  if (sameAddress(token, ADDRESSES.usdg)) return { symbol: 'USDG', decimals: 6, settlement: true };
  if (sameAddress(token, TOKEN_ADDRESSES.BRSR)) return { symbol: 'BRSR', decimals: 18, settlement: false };
  const asset = rwaDeployment(CHAIN_ID)?.assets.find((a) => sameAddress(a.address, token));
  return asset === undefined ? undefined : { symbol: asset.symbol, decimals: 18, settlement: false };
}

/**
 * A raw amount of any token, in that token's own unit. USDG reads in dollars to the cent; anything
 * else shows `places` significant digits after the point, three unless a line asks for more,
 * rounded, with its symbol: what the holdings tables show.
 */
export function tokenAmountText(raw: bigint, token: Address, places = 3): string {
  const info = tokenInfo(token);
  if (info === undefined) return `${raw.toString()} units of ${shortAddress(token)}`;
  if (info.settlement) return usd(raw as Micro);
  return `${roundedUnits(raw, info.decimals, places)} ${info.symbol}`;
}

/** A decimal string of `raw`, rounded half up to `places` significant fraction digits once leading zeros end. */
export function roundedUnits(raw: bigint, decimals: number, places: number): string {
  if (raw === 0n) return '0';
  const text = formatUnits(raw, decimals);
  const [whole = '0', fraction = ''] = text.split('.');
  if (whole !== '0') return Number(text).toLocaleString('en-US', { maximumFractionDigits: 4 });
  const lead = fraction.length - fraction.replace(/^0+/, '').length;
  const keep = lead + places;
  if (fraction.length <= keep) return `0.${fraction}`.replace(/\.?0+$/, '');
  const scale = 10n ** BigInt(decimals - keep);
  const rounded = (raw + scale / 2n) / scale;
  return formatUnits(rounded, keep).replace(/\.?0+$/, '');
}
