import { toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';

import { settlementComplianceAbi } from '@/chain/abi';

/**
 * The compliance surface this app asks USDG for, held to the one it answers.
 *
 * USDG is a diamond. A selector it does not route reverts `FacetNotFound` rather than answering
 * false, and a compliance read that reverts is a read that did not land: the asset state goes to
 * unknown and stays there, on every screen, for as long as the app asks the wrong question. The
 * previous chain's token carried `isBlacklisted`, `pauser` and `blacklister`; this one carries
 * none of them.
 *
 * Read back from 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 on chain 4663, 2026-09-22. `paused`
 * answered false, `isFrozen` answered false, `owner` answered an address, and every name below
 * reverted with 0x800ab12c.
 */
const ANSWERED = ['isFrozen(address)', 'paused()', 'owner()'] as const;

const REVERTED = [
  'isBlacklisted(address)',
  'blacklister()',
  'pauser()',
  'isBlocked(address)',
  'isAddressFrozen(address)',
  'supplyController()',
] as const;

function selectors(): readonly string[] {
  return settlementComplianceAbi
    .filter((entry) => entry.type === 'function')
    .map((entry) => toFunctionSelector(`${entry.name}(${entry.inputs.map((input) => input.type).join(',')})`));
}

describe('what this app asks the settlement asset', () => {
  it('asks only for functions the token routes', () => {
    expect(new Set(selectors())).toEqual(new Set(ANSWERED.map((signature) => toFunctionSelector(signature))));
  });

  it('asks for the per-address control by the name the token has for it', () => {
    const names = settlementComplianceAbi.map((entry) => entry.name);

    expect(names).toContain('isFrozen');
    expect(names).not.toContain('isBlacklisted');
  });

  it('asks for no function the token reverts on', () => {
    const asked = new Set(selectors());

    for (const signature of REVERTED) {
      expect(asked.has(toFunctionSelector(signature)), `${signature} reverts FacetNotFound on 4663`).toBe(false);
    }
  });

  it('reads the pause, because a paused token settles nothing whatever a mandate allows', () => {
    expect(settlementComplianceAbi.map((entry) => entry.name)).toContain('paused');
  });
});
