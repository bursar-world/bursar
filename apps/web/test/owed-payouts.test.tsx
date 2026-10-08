import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';

import { MandateScopeContext } from '@/app/(app)/console/[mandate]/mandate-scope';
import type { MandateScope } from '@/app/(app)/console/[mandate]/mandate-scope';
import { OwedPanel } from '@/app/(app)/console/[mandate]/owed-panel';
import type { ProviderDesk } from '@/app/(app)/providers/desk';
import { HeldForPayee } from '@/app/(app)/providers/desk-view';

/**
 * A v3 escrow pays every party to a settlement at once, and books a leg the token refuses as owed
 * instead of reverting the rest. Nothing moves it on its own, so each party's page has to say it is
 * there and how it comes out.
 */
const MANDATE = '0x1111111111111111111111111111111111111111' as Address;
const ESCROW = '0x3333333333333333333333333333333333333333' as Address;
const PAYEE = '0x2222222222222222222222222222222222222222' as Address;

function mandatePage(owed: Micro | undefined): string {
  const scope = {
    address: MANDATE,
    account: { address: MANDATE, escrow: ESCROW },
    system: { snapshot: { escrow: { owed } } },
    connected: undefined,
    writeContext: {},
    refresh: () => {},
  } as unknown as MandateScope;

  return renderToStaticMarkup(
    <MandateScopeContext.Provider value={scope}>
      <OwedPanel />
    </MandateScopeContext.Provider>,
  );
}

function payeeDesk(owed: Micro | undefined, owned: boolean): string {
  const desk = { payee: PAYEE, owed } as unknown as ProviderDesk;
  return renderToStaticMarkup(<HeldForPayee desk={desk} owned={owned} blockedBy={[]} onClaimed={() => {}} />);
}

describe('a payout held for a mandate', () => {
  it('shows what is held, why, and that any wallet can claim it for the mandate', () => {
    const html = mandatePage(micro(1_250_000n));

    expect(html).toContain('Held for this mandate');
    expect(html).toContain('$1.25');
    expect(html).toContain('token issuer had frozen the address');
    expect(html).toContain('Anyone can claim it for this mandate');
    expect(html).toContain('Connect a wallet to claim it. Any wallet can.');
  });

  it('says nothing when nothing is held, or the escrow is one that never holds a payout', () => {
    expect(mandatePage(micro(0n))).toBe('');
    expect(mandatePage(undefined)).toBe('');
  });
});

describe('a payout held for a payee', () => {
  it('reads in the third person on the public desk and offers no control there', () => {
    const html = payeeDesk(micro(2_500_000n), false);

    expect(html).toContain('Held for this address');
    expect(html).toContain('$2.50');
    expect(html).not.toMatch(/\byou\b|\byour\b/i);
    expect(html).not.toContain('Claim it');
  });

  it('says nothing when nothing is held', () => {
    expect(payeeDesk(micro(0n), true)).toBe('');
    expect(payeeDesk(undefined, true)).toBe('');
  });
});
