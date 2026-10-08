import type { Hex } from 'viem';

import { capabilityId } from './commit.js';
import { BursarError } from './errors.js';

/**
 * The three spend classes a mandate chooses from, and the capability namespaces that carry them.
 *
 * The live MandateAccount has no class field. It allows capabilities one 32-byte id at a time, so a
 * class is expressed as a namespace on the capability label: `service:gpu.render:1` is a service,
 * `hire:research.summarize:1` is an agent hire. The contract then enforces the class the same way it
 * enforces any capability, by refusing an id the principal never allowed. A mandate that allows only
 * `service:` ids refuses every `hire`, on chain.
 *
 * That holds only as long as everybody hashes the same prefix, which is why this is the one module
 * that defines them. The SDK, the MCP server, the sidecar and the console all read it.
 *
 * `rwa` covers eligible stock purchases. They settle through the mandate's `buy`, which checks the
 * asset registry and price guard, never through an escrow lock, so no capability id is hashed under
 * the `rwa:` prefix.
 */
export const SPEND_CLASSES = ['service', 'hire', 'rwa'] as const;

export type SpendClass = (typeof SPEND_CLASSES)[number];

export type SpendClassInfo = {
  readonly id: SpendClass;
  /** The namespace every capability id in this class is hashed under. */
  readonly prefix: `${SpendClass}:`;
  readonly name: string;
  readonly summary: string;
  /** False until the contracts that settle this class are live. */
  readonly available: boolean;
};

export const SPEND_CLASS_INFO: Readonly<Record<SpendClass, SpendClassInfo>> = {
  service: {
    id: 'service',
    prefix: 'service:',
    name: 'Services',
    summary: 'Paid services such as inference and compute, through escrow or over x402.',
    available: true,
  },
  hire: {
    id: 'hire',
    prefix: 'hire:',
    name: 'Agent hires',
    summary: 'Hiring another agent for a job, with the brief committed to the escrow lock.',
    available: true,
  },
  rwa: {
    id: 'rwa',
    prefix: 'rwa:',
    name: 'Eligible stocks',
    summary: 'Tokenized stock purchases, checked against a reference price.',
    available: true,
  },
};

export class SpendClassError extends BursarError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('spend_class_invalid', message, details);
  }
}

export function isSpendClass(value: unknown): value is SpendClass {
  return typeof value === 'string' && (SPEND_CLASSES as readonly string[]).includes(value);
}

/** The class a label is namespaced under, or undefined for a bare label. */
export function classOfLabel(label: string): SpendClass | undefined {
  const head = label.slice(0, label.indexOf(':'));
  return label.includes(':') && isSpendClass(head) ? head : undefined;
}

/** The label without its class namespace. A bare label comes back unchanged. */
export function bareLabel(label: string): string {
  const spendClass = classOfLabel(label);
  return spendClass === undefined ? label : label.slice(SPEND_CLASS_INFO[spendClass].prefix.length);
}

/**
 * The capability label a spend in `spendClass` is made under.
 *
 * A bare label (`gpu.render:1`) is placed in the class. A label already in the class passes
 * through. A label in another class is refused, because hashing it would put a hire through a
 * mandate's service allowance or the other way round. A 32-byte id is refused too: an id cannot be
 * read back, so nobody can say which class it belongs to.
 */
export function classLabel(spendClass: SpendClass, label: string): string {
  const trimmed = label.trim();
  if (trimmed === '') {
    throw new SpendClassError('A capability label is required, such as "gpu.render:1".');
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new SpendClassError(
      `A ${SPEND_CLASS_INFO[spendClass].name.toLowerCase()} spend needs a capability label, not a 32-byte id. ` +
        `An id cannot be read back, so its class cannot be checked. Pass the label, such as "gpu.render:1".`,
      { spendClass, capability: trimmed },
    );
  }
  const current = classOfLabel(trimmed);
  if (current === undefined) return `${SPEND_CLASS_INFO[spendClass].prefix}${trimmed}`;
  if (current === spendClass) return trimmed;
  throw new SpendClassError(
    `"${trimmed}" is in the ${current} class, and this call makes a ${spendClass} spend. ` +
      `Use the ${SPEND_CLASS_INFO[spendClass].prefix} namespace or a bare label.`,
    { spendClass, capability: trimmed, labelClass: current },
  );
}

/** The capability id a spend in `spendClass` carries on chain. */
export function classCapabilityId(spendClass: SpendClass, label: string): Hex {
  return capabilityId(classLabel(spendClass, label));
}

/**
 * A class's bit in a v2 mandate's `classMask`, and its value in `SpendRequest.spendClass`. The
 * order is the contract's: 0 services, 1 agent hires, 2 eligible stocks.
 */
export const SPEND_CLASS_BIT: Readonly<Record<SpendClass, number>> = { service: 0, hire: 1, rwa: 2 };

/** Every bit a v2 mandate accepts. Anything above is refused on chain with `BadClassMask`. */
export const CLASS_MASK_ALL = 0b111;

/** What a v2 mandate allows when its creator names no classes: the two that settle today. */
export const DEFAULT_CLASS_MASK = 0b011;

export function classMaskOf(classes: readonly SpendClass[]): number {
  return classes.reduce((mask, spendClass) => mask | (1 << SPEND_CLASS_BIT[spendClass]), 0);
}

export function classesInMask(mask: number): SpendClass[] {
  return SPEND_CLASSES.filter((spendClass) => (mask & (1 << SPEND_CLASS_BIT[spendClass])) !== 0);
}
