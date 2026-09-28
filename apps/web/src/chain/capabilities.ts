import { toCapabilityId } from '@bursar/core';
import type { Hex } from 'viem';

/**
 * The capability names this product publishes, and the reverse lookup they make possible.
 *
 * A capability reaches the chain as the hash of its label and a hash does not come back. It can
 * still be answered: hashing a candidate name and comparing the id is the same equality the
 * contract makes on the way to a payment, so a name matched this way is the preimage itself. A
 * name that does not match is never shown.
 *
 * These are the names the landing page and the developer docs put in front of a reader, which is
 * why they are the ones a console opened for the first time can already answer. Names typed into
 * the console join the same index as they are typed.
 */
export const PUBLISHED_CAPABILITIES = {
  summarize: 'doc.summarize:1',
  render: 'gpu.render:1',
} as const;

const BY_ID: ReadonlyMap<string, string> = new Map(
  Object.values(PUBLISHED_CAPABILITIES).map((name) => [toCapabilityId(name).toLowerCase(), name]),
);

export function publishedCapability(id: Hex): string | undefined {
  return BY_ID.get(id.toLowerCase());
}
