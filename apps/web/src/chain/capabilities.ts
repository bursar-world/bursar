import { SPEND_CLASSES, SPEND_CLASS_INFO, classCapabilityId, classLabel, classOfLabel, bareLabel, toCapabilityId } from '@bursar/core';
import type { SpendClass, SpendClassInfo } from '@bursar/core';
import type { Hex } from 'viem';

/**
 * The capability names this product publishes, the spend-class namespaces they are spent under,
 * and the reverse lookup both make possible.
 *
 * Spend classes. The live MandateAccount allows capabilities one id at a time and has no class
 * field, so a class is a namespace on the label: `service:` for inference and x402 services,
 * `hire:` for agent hires, `rwa:` for eligible stock purchases. The SDK's `pay` only ever spends
 * `service:` ids and `hire` only `hire:` ids, so a mandate whose capabilities are all `service:`
 * refuses every hire on chain. The namespaces are defined once, in `@bursar/core`, and published
 * here for the console; this is the module the console reads them from.
 *
 * Names. A capability reaches the chain as the hash of its label and a hash does not come back. It
 * can still be answered: hashing a candidate name and comparing the id is the same equality the
 * contract makes on the way to a payment, so a name matched this way is the preimage itself. A
 * name that does not match is never shown.
 */
export { SPEND_CLASSES, SPEND_CLASS_INFO, bareLabel, classCapabilityId, classLabel, classOfLabel };
export type { SpendClass, SpendClassInfo };

export const PUBLISHED_CAPABILITIES = {
  summarize: 'doc.summarize:1',
  render: 'gpu.render:1',
  x402Demo: 'demo.x402:1',
  researchSummarize: 'research.summarize:1',
  review: 'review:1',
  searchWeb: 'search.web:1',
  quote: 'quote.get:1',
} as const;

/** Every published name, bare and under each class it can be spent in. */
const CANDIDATES: readonly string[] = Object.values(PUBLISHED_CAPABILITIES).flatMap((name) => [
  name,
  ...SPEND_CLASSES.map((spendClass) => `${SPEND_CLASS_INFO[spendClass].prefix}${name}`),
]);

const BY_ID: ReadonlyMap<string, string> = new Map(CANDIDATES.map((name) => [toCapabilityId(name).toLowerCase(), name]));

export function publishedCapability(id: Hex): string | undefined {
  return BY_ID.get(id.toLowerCase());
}

/** The class a label is spent under, named for a reader, or undefined for a bare label. */
export function classNameOf(label: string): string | undefined {
  const spendClass = classOfLabel(label);
  return spendClass === undefined ? undefined : SPEND_CLASS_INFO[spendClass].name;
}
