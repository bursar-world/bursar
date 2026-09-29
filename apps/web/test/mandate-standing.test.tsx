import { renderToStaticMarkup } from 'react-dom/server';
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';

import type { MandateRead } from '@/chain/reader';
import { MandateChrome } from '@/app/(app)/console/[mandate]/mandate-chrome';
import { MandateScopeContext, mandateStanding } from '@/app/(app)/console/[mandate]/mandate-scope';
import type { MandateScope, MandateStanding } from '@/app/(app)/console/[mandate]/mandate-scope';
import { holdsCreateForm } from '@/app/(app)/console/new/create-view';

/**
 * A contract can answer every getter a mandate has and still be somebody else's code. The console
 * shows owner controls only for an account the factory lists under its principal, and shows
 * nothing that looks like control while it is still asking.
 */
const ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x9999999999999999999999999999999999999999' as Address;

const account = { address: ADDRESS, principal: '0x2222222222222222222222222222222222222222' } as unknown as MandateRead;

describe('what stands at the address', () => {
  const base = { address: ADDRESS, read: true, account, failed: false };

  it('is a mandate only once the factory lists it', () => {
    expect(mandateStanding({ ...base, listed: true })).toBe('mandate');
    expect(mandateStanding({ ...base, listed: false })).toBe('foreign');
  });

  it('is still being checked while the factory has not answered', () => {
    expect(mandateStanding({ ...base, listed: undefined })).toBe('checking');
  });

  it('is unread when the factory could not be asked, never a mandate', () => {
    expect(mandateStanding({ ...base, listed: undefined, failed: true })).toBe('unread');
  });

  it('ignores a reading held over from another address', () => {
    expect(mandateStanding({ ...base, account: { ...account, address: OTHER }, listed: true })).toBe('checking');
  });

  it('tells an empty address apart from a reading that never landed', () => {
    expect(mandateStanding({ ...base, account: undefined, listed: undefined })).toBe('absent');
    expect(mandateStanding({ address: ADDRESS, read: false, account: undefined, failed: true, listed: undefined })).toBe('unread');
    expect(mandateStanding({ address: ADDRESS, read: false, account: undefined, failed: false, listed: undefined })).toBe('checking');
  });
});

function chrome(standing: MandateStanding): string {
  const scope = {
    address: ADDRESS,
    account: undefined,
    standing,
    standingError: null,
    isOwner: false,
    ownerOffChain: false,
    connected: undefined,
    refresh: () => {},
  } as unknown as MandateScope;

  return renderToStaticMarkup(
    <MandateScopeContext.Provider value={scope}>
      <MandateChrome>
        <button type="button">Pause the mandate</button>
      </MandateChrome>
    </MandateScopeContext.Provider>,
  );
}

describe('a look-alike contract', () => {
  it('gets a screen that says so, and no controls', () => {
    const html = chrome('foreign');

    expect(html).toContain('This address is not a BURSAR mandate.');
    expect(html).not.toContain('Pause the mandate');
    expect(html).not.toContain('Approvals');
    expect(html).not.toContain('Check again');
  });

  it('shows no controls while the check is running', () => {
    const html = chrome('checking');

    expect(html).not.toContain('Pause the mandate');
    expect(html).not.toContain('Approvals');
    expect(html).not.toContain('not a BURSAR mandate');
  });
});

/**
 * Editing the form while a create is out would move the predicted address and drop the button
 * waiting on the receipt, which is how one intent became two deployments.
 */
describe('the create form', () => {
  it('holds still from the wallet opening until the account exists', () => {
    expect(holdsCreateForm('signing', false)).toBe(true);
    expect(holdsCreateForm('pending', false)).toBe(true);
    expect(holdsCreateForm('confirmed', false)).toBe(true);
    expect(holdsCreateForm('idle', true)).toBe(true);
  });

  it('opens again when nothing is in flight', () => {
    expect(holdsCreateForm('idle', false)).toBe(false);
    expect(holdsCreateForm('failed', false)).toBe(false);
    expect(holdsCreateForm('replaced', false)).toBe(false);
  });
});

describe('an address with no mandate account at all', () => {
  it('says it is not a mandate and offers the way back', () => {
    const html = chrome('absent');

    expect(html).toContain('This address is not a BURSAR mandate.');
    expect(html).toContain('nothing at this address behaves like a mandate account');
    expect(html).not.toContain('Pause the mandate');
  });
});
