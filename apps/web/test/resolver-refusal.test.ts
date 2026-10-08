import { toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';

import { ResolverRefusedError, resolverFailure } from '@/app/(app)/resolvers/refusal';

/**
 * A refusal has to name three things: the condition, whoever owns it, and what changes it.
 *
 * Every selector below was produced by simulating the real call against the live registry at
 * `0xCb7c…49FF` on chain 4663 on 2026-09-23, so these are the exact bytes a resolver's wallet
 * gets back. "BondTooSmall" is a true sentence and a useless one: it says nothing about who moved
 * the floor or what clears it, and a resolver benched by a governance change would go looking for
 * a bug in their own wallet.
 */
function reverted(data: string): unknown {
  // viem hangs the payload off the cause chain; the SDK's decoder walks it wherever it lands.
  return Object.assign(new Error('execution reverted'), { cause: { data } });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe('resolverFailure', () => {
  it('reads a bond below the floor as governance’s floor, not a wallet fault', () => {
    const failure = resolverFailure(reverted('0x3388f4fc'), { action: 'Seal a score' });
    expect(failure).toBeInstanceOf(ResolverRefusedError);
    expect(messageOf(failure)).toContain('under the floor');
    expect(messageOf(failure)).toContain('the floor governance sets');
    expect(messageOf(failure)).toContain('Top the bond back up');
  });

  /**
   * The registry reports both figures on `BondNotAccepted` for exactly this reading: an amount at
   * or above the floor that was still refused is a bar on the address, not a shortfall. The two
   * have different owners and different fixes, and one sentence for both would send a barred
   * resolver to buy more BRSR.
   */
  it('separates a short bond from a barred address', () => {
    const short = resolverFailure(
      reverted(
        '0x57a015dc0000000000000000000000000000000000000000000005150ae84a8cdf00000000000000000000000000000000000000000000000000054b40b1f852bda00000',
      ),
      { action: 'Post the bond' },
    );
    expect(messageOf(short)).toContain('at least 25,000.00 BRSR');
    expect(messageOf(short)).toContain('offered 24,000.00 BRSR');
    expect(messageOf(short)).not.toContain('barred');

    const barred = resolverFailure(
      reverted(
        '0x57a015dc00000000000000000000000000000000000000000000065a4da25d3016c0000000000000000000000000000000000000000000000000054b40b1f852bda00000',
      ),
      { action: 'Post the bond' },
    );
    expect(messageOf(barred)).toContain('barred this address');
    expect(messageOf(barred)).toContain('Only governance can lift the bar');
  });

  it('tells a resolver whose exit is held by a live vote what releases it', () => {
    const failure = resolverFailure(reverted('0x1caa378c'), { action: 'Complete the exit' });
    expect(messageOf(failure)).toContain('is still open');
    expect(messageOf(failure)).toContain('Reveal any score you sealed');
  });

  /**
   * The costliest revert on the desk. A resolver holding the wrong salt has one reveal window and
   * no second chance, so the sentence says the bond is untouched and the clock is not.
   */
  it('says what a failed reveal costs and what it does not', () => {
    const failure = resolverFailure(reverted('0x8ff14e0d'), { action: 'Reveal your score' });
    expect(messageOf(failure)).toContain('do not match what this address sealed');
    expect(messageOf(failure)).toContain('does not touch the bond');
    expect(messageOf(failure)).toContain('reveal window keeps running');
  });

  it('sends a panel that never reached quorum to the other exit by name', () => {
    const failure = resolverFailure(reverted('0xd79e824a'), { action: 'Finalise the ruling' });
    expect(messageOf(failure)).toContain('Too few resolvers revealed');
    expect(messageOf(failure)).toContain('Close it without a ruling instead');
    expect(messageOf(failure)).toContain('back on hold for the payee');
  });

  // The registry reads the paying account's principal once, when the dispute opens, and bars it
  // with the two parties.
  it('tells a party to the payment, or the principal behind it, that it cannot vote on it', () => {
    const failure = resolverFailure(reverted(toFunctionSelector('PartyCannotVote()')), { action: 'Seal a score' });
    expect(messageOf(failure)).toContain('the principal the paying account named when the dispute opened');
    expect(messageOf(failure)).toContain('cannot vote on this dispute');
  });

  it('says a full roster frees a seat on an exit or an eviction, not on a panel settling', () => {
    const failure = resolverFailure(reverted(toFunctionSelector('RosterFull()')), { action: 'Bond' });
    expect(messageOf(failure)).toContain('All 64 resolver seats are taken');
    expect(messageOf(failure)).toContain('governance removes one');
  });

  it('explains the approval step behind a bond rather than quoting the token', () => {
    const failure = resolverFailure(
      reverted(
        '0xfb8f41b2000000000000000000000000cb7c60037ec43b9692a5ddca42a500181cf549ff000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000054b40b1f852bda00000',
      ),
      { action: 'Post the bond' },
    );
    expect(messageOf(failure)).toContain('Allow the amount first');
    expect(messageOf(failure)).toContain('then post the bond');
  });

  it('covers every refusal the live registry answered these calls with', () => {
    const live = [
      { selector: '0xaba47339', name: 'NotRegistered' },
      { selector: '0xd279f289', name: 'UnbondNotRequested' },
      { selector: '0x4250af08', name: 'DisputeNotFound' },
      { selector: '0x969bf728', name: 'NothingToClaim' },
      { selector: '0x80cb55e2', name: 'NotActive' },
      { selector: '0xbfec5558', name: 'AlreadyCommitted' },
      { selector: '0xf06b2576', name: 'RosterFull' },
      { selector: '0xcbe6d1c6', name: 'RevealWindowOpen' },
    ];

    for (const entry of live) {
      const failure = resolverFailure(reverted(entry.selector), { action: 'Do the thing' });
      expect(failure, entry.name).toBeInstanceOf(ResolverRefusedError);
      expect((failure as ResolverRefusedError).errorName).toBe(entry.name);
      expect(messageOf(failure).length).toBeGreaterThan(60);
    }
  });

  /**
   * Anything without a reading of its own goes back to the classifier the rest of the app uses,
   * which names the contract's own error and says the condition holds.
   */
  it('falls through to the app’s classifier for a refusal it has no reading for', () => {
    const failure = resolverFailure(reverted('0x3ee5aeb5'), { action: 'Finalise the ruling' });
    expect(failure).not.toBeInstanceOf(ResolverRefusedError);
    expect(messageOf(failure)).toContain('ReentrancyGuardReentrantCall');
  });

  it('leaves a cancelled signature alone, because that is not a refusal', () => {
    const rejected = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    expect(resolverFailure(rejected, { action: 'Seal a score' })).toBe(rejected);
  });
});
