'use client';

import type { Hex } from 'viem';

import { bareLabel, classNameOf } from '@/chain/capabilities';
import { shortAddress } from '@/chain/rhc';
import { useCapabilityLabels } from './capability-labels';

/**
 * A capability, named where the name can be matched back to the hash and shown as the hash where
 * it cannot. A cell that quietly prints 32 bytes is the one place a treasurer has to leave this
 * screen to find out what an agent is allowed to buy.
 */
export function CapabilityName({ id }: { readonly id: Hex }) {
  const { labelFor } = useCapabilityLabels();
  const name = labelFor(id);

  if (name === undefined) {
    return (
      <span className="block">
        <span className="tabular block text-detail" title={id}>
          {shortAddress(id, 12, 8)}
        </span>
        <span className="block text-note text-[color:var(--color-muted)]">
          Allowed under a name the chain does not keep, and this console cannot recover it.
        </span>
      </span>
    );
  }

  const spendClass = classNameOf(name);

  return (
    <span>
      {spendClass !== undefined && (
        <span className="mr-2 font-mono text-label uppercase tracking-wide text-[color:var(--color-muted)]">{spendClass}</span>
      )}
      <span className="font-medium" title={name}>
        {spendClass === undefined ? name : bareLabel(name)}
      </span>
      <span className="tabular ml-2 text-note text-[color:var(--color-muted)]" title={id}>
        {shortAddress(id, 10, 6)}
      </span>
    </span>
  );
}
