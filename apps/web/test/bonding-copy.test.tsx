import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { TOKEN_ADDRESSES } from '@/chain';
import { BondingSection } from '@/app/(app)/token/bonding';
import type { ResolverBonding, TokenExtras } from '@/app/(app)/token/read';
import type { TokenPageData } from '@/app/(app)/token/use-token-page';

/**
 * The bond section says what the contracts say, and stops saying it when they stop.
 *
 * The page rendered a floor of 25,000 BRSR and "Bonding in BRSR: Open" three lines under body copy
 * reading "until it does, an BRSR bond is refused" and "Zero refuses a bond at any amount." The
 * floor had been set at construction; the caption was written when it was zero and never read the
 * chain again. The same page named the settlement asset as the bond asset while the registry holds BRSR.
 */
const STAKING_FLOOR = 25_000n * 10n ** 18n;
const OTHER_TOKEN = '0x9999999999999999999999999999999999999999' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

function bonding(over: Partial<ResolverBonding> = {}): ResolverBonding {
  return {
    bondAsset: TOKEN_ADDRESSES.BRSR,
    bondPool: TOKEN_ADDRESSES.Staking,
    totalBonded: 0n as ResolverBonding['totalBonded'],
    unbondingPeriod: 604_800n,
    quorum: 2,
    maxVoters: 5,
    slashBps: 1_000,
    minBondBrsr: STAKING_FLOOR as ResolverBonding['minBondBrsr'],
    yourBond: undefined,
    yourStatus: undefined,
    yourFinalized: undefined,
    yourSlashes: undefined,
    yourFloorBrsr: undefined,
    bondingDenied: undefined,
    ...over,
  };
}

function page(over: Partial<ResolverBonding> = {}): string {
  const extras = { bonding: bonding(over) } as TokenExtras;
  const data = { account: undefined, extras } as TokenPageData;
  return renderToStaticMarkup(<BondingSection data={data} />);
}

describe('a floor the chain has set', () => {
  const markup = page();

  it('is not described as one governance has yet to name', () => {
    expect(markup).not.toContain('until it does, an BRSR bond is refused');
    expect(markup).not.toContain('Zero refuses a bond at any amount');
    expect(markup).not.toContain('Refused at any amount');
  });

  it('shows the floor and says bonding is open', () => {
    expect(markup).toContain('25,000.00 BRSR');
    expect(markup).toContain('Open');
  });

  it('names BRSR as the bond asset, because that is what the registry holds', () => {
    expect(markup).toContain('BRSR');
    expect(markup).not.toContain('Posted in USDG');
  });
});

describe('a floor of zero', () => {
  const markup = page({ minBondBrsr: 0n as ResolverBonding['minBondBrsr'] });

  it('says a bond is refused at any amount, and does not say it is open', () => {
    expect(markup).toContain('Refused at any amount');
    expect(markup).toContain('None set');
  });
});

describe('a registry with no collateral wired', () => {
  it('says so rather than naming a token it does not hold', () => {
    const markup = page({ bondAsset: ZERO });

    expect(markup).toContain('No bond asset set');
    expect(markup).toContain('None set');
  });

  it('says so when the registry bonds in something other than BRSR', () => {
    expect(page({ bondAsset: OTHER_TOKEN })).toContain('The registry bonds in another token');
  });
});
