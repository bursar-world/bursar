import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { NEEDS, TREASURY_WARNING, answerWord, canSweep, needFor, opsAccess, seizedLine, sweepLine } from '@/app/(app)/ops/gate';
import type { OpsRoles } from '@/app/(app)/ops/gate';

const SIGNER = '0xb51c63568324848DfC88A09f91F06fA86771aB69' as Address;
const GUARDIAN = '0x7cfF32B8B4DB47E2Cde5907c8F5c93EC6a095E2A' as Address;
const TREASURY = '0x7f2D3be9597fb538BDBA3Dbcb9BEcECCD9056d21' as Address;
const SUCCESSOR = '0x00000000000000000000000000000000000005Afe' as Address;
const STRANGER = '0x000000000000000000000000000000000000BEEF' as Address;

function roles(over: Partial<OpsRoles> = {}): OpsRoles {
  return { address: undefined, signer: 'no', guardian: 'no', treasury: 'no', incomingTreasury: 'no', ...over };
}

/**
 * The operator surface is gated on three keys that are not interchangeable.
 *
 * Fees accrue in the escrow, which has no admin role, so sweeping them and rotating the address
 * they land on are direct calls. The staking table and the buyback ceiling belong to contracts the
 * timelock administers, so both are proposals. A page that offers all four to everyone sends an
 * operator to a wallet prompt that ends in a revert.
 */
describe('the gate', () => {
  it('asks a disconnected reader for one of the keys and says the readings need none', () => {
    const access = opsAccess(roles());

    expect(access.admitted).toBe(false);
    expect(access.accepting).toBe(false);
    expect(access.headline).toContain('signer, the guardian, the escrow treasury key or the address it has named');
    expect(access.detail).toContain('needs no wallet');
  });

  it('refuses a wallet that holds none of them, and names what each key is for', () => {
    const access = opsAccess(roles({ address: STRANGER }));

    expect(access.admitted).toBe(false);
    expect(access.accepting).toBe(false);
    expect(access.headline).toContain('none of the roles');
    expect(access.detail).toContain('treasury key itself');
    expect(access.detail).toContain('the address it named');
    expect(access.detail).toContain('three signer keys');
    expect(access.detail).toContain('Connect one of those');
  });

  it('admits a signer, the guardian and the treasury, and names which it read', () => {
    expect(opsAccess(roles({ address: SIGNER, signer: 'yes' })).headline).toContain('a timelock signer');
    expect(opsAccess(roles({ address: GUARDIAN, guardian: 'yes' })).headline).toContain('the guardian');
    expect(opsAccess(roles({ address: TREASURY, treasury: 'yes' })).headline).toContain('the escrow treasury');
    expect(opsAccess(roles({ address: SIGNER, signer: 'yes' })).admitted).toBe(true);
  });

  it('names both roles where a wallet holds two of them', () => {
    const access = opsAccess(roles({ address: TREASURY, signer: 'yes', treasury: 'yes' }));

    expect(access.headline).toContain('a timelock signer and the escrow treasury');
  });

  it('never refuses a wallet on a reading that failed', () => {
    const access = opsAccess(roles({ address: STRANGER, signer: 'unread', guardian: 'unread', treasury: 'unread' }));

    expect(access.admitted).toBe(true);
    expect(access.accepting).toBe(true);
    expect(access.headline).toContain('Could not read this wallet’s roles');
    expect(access.headline).not.toContain('holds none');
  });
});

/**
 * The second half of a treasury rotation can only come from the address the first half named, and
 * that address holds nothing else here. A fresh multisig with no signer seat and no guardian key
 * was being shown a page with the one control it needs missing, so a live rotation could be
 * started from this surface and not finished from it.
 */
describe('the address a rotation has been named to', () => {
  it('is admitted to step two and to nothing else', () => {
    const access = opsAccess(roles({ address: SUCCESSOR, incomingTreasury: 'yes' }));

    expect(access.accepting).toBe(true);
    expect(access.admitted).toBe(false);
    expect(access.headline).toContain('successor the escrow treasury has named');
    expect(access.detail).toContain('one thing it can do here');
  });

  it('leaves the sweep, step one and the proposal builder where they were', () => {
    expect(opsAccess(roles({ address: SUCCESSOR, incomingTreasury: 'yes' })).admitted).toBe(false);
    expect(opsAccess(roles({ address: STRANGER })).accepting).toBe(false);
  });

  it('is named in the role line where one wallet holds the seat and the handover', () => {
    const access = opsAccess(roles({ address: SIGNER, signer: 'yes', incomingTreasury: 'yes' }));

    expect(access.headline).toContain('a timelock signer');
    expect(access.headline).toContain('successor the escrow treasury has named');
  });

  it('keeps step two offered where the pending slot did not come back', () => {
    expect(opsAccess(roles({ address: STRANGER, incomingTreasury: 'unread' })).accepting).toBe(true);
  });

  it('does not tell a stranger it was named when the pending slot did not come back', () => {
    const access = opsAccess(roles({ address: STRANGER, incomingTreasury: 'unread' }));

    expect(access.headline).toContain('none of the roles');
  });
});

describe('every action names the key it needs and whether it waits', () => {
  it('covers what the surface offers, the second half of the rotation included', () => {
    expect(NEEDS.map((entry) => entry.id)).toEqual([
      'sweep-fees',
      'transfer-treasury',
      'accept-treasury',
      'claim-seized',
      'staking-tiers',
      'staking-slasher',
      'buyback-ceiling',
      'buyback-keeper',
    ]);
  });

  it('names the contract call behind each one', () => {
    expect(needFor('sweep-fees').call).toBe('Escrow.sweepFees');
    expect(needFor('transfer-treasury').call).toBe('Escrow.transferTreasury');
    expect(needFor('accept-treasury').call).toBe('Escrow.acceptTreasury');
    expect(needFor('claim-seized').call).toBe('CollateralVault.claimSeized');
    expect(needFor('staking-tiers').call).toBe('Staking.setTiers');
    expect(needFor('staking-slasher').call).toBe('Staking.setSlasher');
    expect(needFor('buyback-ceiling').call).toBe('Buyback.setParams');
    expect(needFor('buyback-keeper').call).toBe('Buyback.setKeeper');
  });

  it('says the sweep is permissionless and still pays the treasury', () => {
    expect(needFor('sweep-fees').needs).toContain('Anyone can call it');
    expect(needFor('sweep-fees').route).toBe('direct');
  });

  it('says the claim is permissionless and pays the lender whoever sends it', () => {
    expect(needFor('claim-seized').needs).toContain('pays the pool’s lender whoever sends it');
    expect(needFor('claim-seized').route).toBe('direct');
  });

  it('says the timelock cannot make the treasury call', () => {
    expect(needFor('transfer-treasury').needs).toContain('Governance cannot make this call');
  });

  it('routes every administered setting through governance rather than a direct call', () => {
    for (const id of ['staking-tiers', 'staking-slasher', 'buyback-ceiling', 'buyback-keeper'] as const) {
      expect(needFor(id).route).toBe('proposal');
    }
  });
});

/**
 * Seized collateral has four readings and none of them is a zero: a reading in flight, a lane whose
 * vault seizes nothing, a reading that failed part way, and nothing waiting.
 */
describe('what has been seized', () => {
  it('renders a different sentence for each condition', () => {
    const shown = [
      seizedLine(undefined, false),
      seizedLine(undefined, true),
      seizedLine({ assets: [], complete: false }, true),
      seizedLine({ assets: [], complete: true }, true),
      seizedLine({ assets: [{}], complete: true }, true),
    ];

    expect(new Set(shown).size).toBe(5);
  });

  it('says a lane whose vault does not seize has nothing here, rather than nothing waiting', () => {
    expect(seizedLine(undefined, true)).toContain('leaves a written-off line holding what could not be sold');
    expect(seizedLine(undefined, true)).not.toContain('Nothing is waiting');
  });

  it('does not report a partial reading as nothing', () => {
    expect(seizedLine({ assets: [], complete: false }, true)).toContain('unknown, not zero');
  });

  it('names where a claim pays when something waits', () => {
    expect(seizedLine({ assets: [{}], complete: true }, true)).toContain('to the lender below, and nowhere else');
  });
});

describe('the treasury warning', () => {
  it('says the key names its own successor and that no proposal can move it', () => {
    expect(TREASURY_WARNING).toContain('Only the escrow treasury can name its successor');
    expect(TREASURY_WARNING).toContain('no proposal, delay or quorum');
  });

  it('says what the two steps mean while one is pending', () => {
    expect(TREASURY_WARNING).toContain('keeps receiving every swept fee until the new address accepts');
  });

  it('says what losing the key costs', () => {
    expect(TREASURY_WARNING).toContain('nowhere to go, permanently');
  });
});

describe('what has accrued', () => {
  it('renders three different things for a reading in flight, one that failed and a balance of zero', () => {
    const shown = [sweepLine(undefined, TREASURY, false), sweepLine(undefined, TREASURY, true), sweepLine(0n, TREASURY, true)];

    expect(new Set(shown).size).toBe(3);
  });

  it('does not report a reading still in flight as a reading that failed', () => {
    expect(sweepLine(undefined, TREASURY, false)).toContain('Reading');
    expect(sweepLine(undefined, TREASURY, false)).not.toContain('Could not read');
  });

  it('does not report an unread balance as nothing to sweep', () => {
    const line = sweepLine(undefined, TREASURY, true);

    expect(line).toContain('Could not read what has accrued');
    expect(line).toContain('may not be zero');
    expect(line).not.toContain('Nothing has accrued');
  });

  it('says nothing has accrued only when the chain said zero', () => {
    expect(sweepLine(0n, TREASURY, true)).toContain('Nothing is waiting to be swept');
    expect(sweepLine(undefined, TREASURY, true)).not.toContain('Nothing is waiting');
  });

  it('names the destination when there is something to sweep', () => {
    expect(sweepLine(1_000_000n, TREASURY, true)).toContain('to the treasury below, and nowhere else');
  });

  it('says the destination is unknown when the treasury slot did not come back', () => {
    expect(sweepLine(1_000_000n, undefined, true)).toContain('Could not read the treasury they go to');
  });

  it('keeps the control offered on an unread balance and withholds it on a read zero', () => {
    expect(canSweep(undefined)).toBe(true);
    expect(canSweep(0n)).toBe(false);
    expect(canSweep(1n)).toBe(true);
  });
});

describe('the three role answers on screen', () => {
  it('has a word for each, and none of them is blank', () => {
    expect(answerWord('yes')).toBe('Yes');
    expect(answerWord('no')).toBe('No');
    expect(answerWord('unread')).toBe('Not read');
  });
});
