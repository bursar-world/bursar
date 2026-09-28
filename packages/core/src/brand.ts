import { BursarError } from './errors.js';
import type { EnvSource } from './env.js';

/**
 * The contracts, facilitator and operator surface are shared. A brand is the only thing
 * that varies between deployments: what the product is called, what it settles in, which
 * lane it leads with, and the nouns its customers see. Nothing here is specific to any one
 * deployment, and nothing in the core reads a brand name directly.
 */

/** How a payment is funded before it reaches a provider. */
export type Lane = 'prefund' | 'collateral' | 'direct';

/** Which surface a deployment leads with. Determines default routing, not availability. */
export type HeroLane = 'facilitator' | 'escrow' | 'vault';

export type SettlementAsset = {
  readonly symbol: string;
  /** Decimals of the ERC-20 view used for accounting. Every ledger amount is in these units. */
  readonly decimals: number;
};

/**
 * Customer-facing nouns, plural and lowercase. Surfaces title-case them where they need to.
 * A deployment that calls a mandate a "budget" changes it here and nowhere else.
 */
export type BrandVocabulary = {
  /** The spending authority a principal writes. */
  readonly mandate: string;
  /** The caps inside it. */
  readonly limit: string;
  /** The funding routes a payment can take. */
  readonly lane: string;
  /** The party that sets a mandate. */
  readonly principal: string;
  /** The party that spends inside one. */
  readonly agent: string;
  /** The party that gets paid. */
  readonly merchant: string;
};

export type BrandConfig = {
  /** Stable slug. Used for config lookup and table prefixes, never shown to a customer. */
  readonly id: string;
  readonly name: string;
  /** Governance and fee token, once one exists. Null until then. */
  readonly ticker: string | null;
  readonly settlementAsset: SettlementAsset;
  readonly heroLane: HeroLane;
  readonly lanes: readonly Lane[];
  readonly vocab: BrandVocabulary;
};

/** The settlement asset on Robinhood Chain. Gas is ETH and is not accounted here. */
export const USDG: SettlementAsset = Object.freeze({ symbol: 'USDG', decimals: 6 });

export const BURSAR: BrandConfig = Object.freeze({
  id: 'bursar',
  name: 'BURSAR',
  ticker: 'BRSR',
  settlementAsset: USDG,
  heroLane: 'facilitator',
  lanes: ['prefund', 'collateral', 'direct'] as const,
  vocab: Object.freeze({
    mandate: 'mandates',
    limit: 'limits',
    lane: 'lanes',
    principal: 'principal',
    agent: 'agent',
    merchant: 'merchant',
  }),
});

const BRANDS: Readonly<Record<string, BrandConfig>> = Object.freeze({
  [BURSAR.id]: BURSAR,
});

export function brand(id: string): BrandConfig {
  // Own keys only: a lookup by an external name must not find `constructor` or `toString` on the
  // prototype and hand it back as a brand.
  const found = Object.hasOwn(BRANDS, id) ? BRANDS[id] : undefined;
  if (!found) {
    throw new BursarError(
      'brand_unknown',
      `Unknown brand "${id}". Known brands: ${Object.keys(BRANDS).join(', ')}.`,
      { id, known: Object.keys(BRANDS) },
    );
  }
  return found;
}

/** Defaults to BURSAR so a local process runs without a brand variable set. */
export function activeBrand(source: EnvSource = process.env): BrandConfig {
  return brand(source['BRAND_ID']?.trim() || BURSAR.id);
}
