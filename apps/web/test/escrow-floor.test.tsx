import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';

import { MandateScopeContext } from '@/app/(app)/console/[mandate]/mandate-scope';
import type { MandateScope } from '@/app/(app)/console/[mandate]/mandate-scope';
import { ProposedPayment } from '@/app/(app)/console/[mandate]/proposed-payment';

/**
 * A v3 escrow opens no payment under its floor, and the account's own preview does not know that:
 * a payment under it clears every limit and is refused inside the lock. The preview on the console
 * has to say so before anybody pays for the attempt.
 */
const MANDATE = '0x1111111111111111111111111111111111111111' as Address;
const PAYEE = '0x2222222222222222222222222222222222222222' as Address;

function preview(amount: Micro, floor: Micro | undefined): string {
  const clear = (key: string, label: string) => ({ key, label, level: 'ok', headline: 'Clear', detail: '', nextAction: null, checks: [] });
  const scope = {
    address: MANDATE,
    account: { address: MANDATE },
    system: {
      permission: clear('permission', 'Permission'),
      mandate: clear('mandate', 'Mandate'),
      funding: { facts: { mandateBalance: micro(10_000_000n) } },
      snapshot: { escrow: { minLock: floor } },
      refresh: () => {},
    },
    proposed: { merchant: PAYEE, capability: 'doc.summarize:1', amount },
    propose: () => {},
  } as unknown as MandateScope;

  return renderToStaticMarkup(
    <MandateScopeContext.Provider value={scope}>
      <ProposedPayment />
    </MandateScopeContext.Provider>,
  );
}

describe('a previewed payment and the escrow floor', () => {
  it('is refused under the floor even when every limit clears it', () => {
    const html = preview(micro(5_000n), micro(10_000n));

    expect(html).toContain('A payment of $0.005 would be refused by the escrow, which opens no payment under $0.01.');
    expect(html).not.toContain('would go through');
  });

  it('goes through at the floor', () => {
    expect(preview(micro(10_000n), micro(10_000n))).toContain('would go through within the limits');
  });

  it('is judged on the limits alone where the escrow has no floor', () => {
    expect(preview(micro(5_000n), undefined)).toContain('would go through within the limits');
  });
});
