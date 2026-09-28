/**
 * Ruling policy v1, as published in docs/RULING-POLICY.md. Pure: the evidence comes in already
 * collected and checked, and nothing here reads a clock, a chain or a network.
 *
 * Every score it emits sits in the middle of one of the registry's refund bands, so no median and
 * no rounding can carry a ruling across a band edge:
 *
 *   below 50   full refund      emitted as 0
 *   50 to 64   75% refund       emitted as 60
 *   65 to 79   35% refund       emitted as 72 (reachable only by an operator override)
 *   80 and up  no refund        emitted as 90
 */

export const POLICY_VERSION = 'v1';

export const RULING_SCORES = [0, 60, 72, 90] as const;

export type RulingScore = (typeof RULING_SCORES)[number];

export type RuleId = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';

/** Whether the job the payer committed to could be read back and matched to its commitment. */
export type InputCheck =
  | { readonly kind: 'verified' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unfetchable'; readonly detail: string }
  | { readonly kind: 'mismatch'; readonly detail: string };

export type OutputCheck =
  | { readonly kind: 'verified'; readonly wellFormed: boolean }
  | { readonly kind: 'unfetchable'; readonly detail: string }
  | { readonly kind: 'not-public'; readonly detail: string }
  | { readonly kind: 'mismatch'; readonly detail: string };

/** What a published validator for the capability said about the output, if one is published. */
export type ValidatorVerdict = 'pass' | 'partial' | 'fail' | 'none';

/** One piece of delivery evidence received before the cutoff, already checked. */
export type DeliveryCheck = {
  /** The EIP-712 digest of the signed statement. Published, so anyone can match it to its source. */
  readonly hash: string;
  readonly signedByPayee: boolean;
  readonly inputMatches: boolean;
  readonly output: OutputCheck;
  readonly validator: ValidatorVerdict;
};

export type Override = {
  readonly score: RulingScore;
  readonly reason: string;
};

export type PolicyEvidence = {
  /** P0: the lock is `Disputed` with `releasedAt == 0` at the snapshot block. */
  readonly heldInDispute: boolean;
  readonly input: InputCheck;
  readonly deliveries: readonly DeliveryCheck[];
  /** Received before the cutoff. A later one never reaches this function. */
  readonly override: Override | null;
  /** The payer or the payee is an address the operator controls. */
  readonly operatorParty: boolean;
};

export type Ruling = {
  readonly policyVersion: string;
  readonly ruleId: RuleId;
  /** Null under P0: this service does not vote on a lock it cannot rule on. */
  readonly score: RulingScore | null;
  readonly reasons: readonly string[];
};

/**
 * The ruling on one dispute.
 *
 * P0 is checked first because nothing else means anything on a lock the registry cannot rule on.
 * An allowed override comes next and takes the place of P1 to P5: an override that only applied
 * when no other rule matched would never apply, since P2 matches whenever nothing was delivered.
 * The rest are first match wins, in the order the published policy lists them.
 */
export function rule(evidence: PolicyEvidence, policyVersion: string = POLICY_VERSION): Ruling {
  // Fail closed. A ruling under a policy nobody published is a ruling nobody can check.
  if (policyVersion !== POLICY_VERSION) throw new Error(`Ruling policy ${policyVersion} is not implemented here.`);

  const ruled = (ruleId: RuleId, score: RulingScore | null, reasons: readonly string[]): Ruling => ({
    policyVersion,
    ruleId,
    score,
    reasons,
  });

  if (!evidence.heldInDispute) {
    return ruled('P0', null, ['The lock is not held in dispute at the snapshot block, so there is nothing for the registry to rule on.']);
  }

  const notes: string[] = [];
  if (evidence.override !== null) {
    if (!evidence.operatorParty) {
      return ruled('P6', evidence.override.score, [`Operator override: ${evidence.override.reason}`]);
    }
    notes.push('An operator override was received and refused, because the operator is a party to this dispute.');
  }

  if (evidence.input.kind !== 'verified') {
    return ruled('P1', 0, [...notes, inputReason(evidence.input), 'No verifiable job existed, so nothing was owed.']);
  }

  if (evidence.deliveries.length === 0) {
    return ruled('P2', 0, [...notes, 'No delivery evidence signed by the payee arrived before the cutoff.']);
  }

  const valid = evidence.deliveries.filter(isValid);
  if (valid.length === 0) {
    return ruled('P3', 0, [...notes, ...evidence.deliveries.map(invalidReason)]);
  }

  const complete = valid.find((delivery) => delivery.validator !== 'partial');
  if (complete !== undefined) {
    return ruled('P5', 90, [
      ...notes,
      complete.validator === 'pass'
        ? 'The payee signed the delivery, the output matches its commitment, and the capability validator passed it.'
        : 'The payee signed the delivery, the output matches its commitment, and it is well-formed, non-empty JSON.',
    ]);
  }

  return ruled('P4', 60, [...notes, 'The delivery is valid and the capability validator reports it as partial.']);
}

function isValid(delivery: DeliveryCheck): boolean {
  if (!delivery.signedByPayee || !delivery.inputMatches) return false;
  if (delivery.output.kind !== 'verified') return false;
  if (delivery.validator === 'fail') return false;
  // With no published validator, well-formed and non-empty is the whole of the check.
  return delivery.validator !== 'none' || delivery.output.wellFormed;
}

function inputReason(input: Exclude<InputCheck, { kind: 'verified' }>): string {
  switch (input.kind) {
    case 'missing':
      return 'The lock names no input URI.';
    case 'unfetchable':
      return `The input URI could not be fetched: ${input.detail}`;
    case 'mismatch':
      return `The input does not hash to the lock's input commitment: ${input.detail}`;
  }
}

function invalidReason(delivery: DeliveryCheck): string {
  const which = `Evidence ${delivery.hash.slice(0, 10)}`;
  if (!delivery.signedByPayee) return `${which} is not signed by the payee.`;
  if (!delivery.inputMatches) return `${which} names a different input commitment from the lock.`;
  if (delivery.output.kind === 'unfetchable') return `${which}: the output could not be fetched: ${delivery.output.detail}`;
  if (delivery.output.kind === 'not-public') return `${which}: the output is not publicly fetchable: ${delivery.output.detail}`;
  if (delivery.output.kind === 'mismatch') return `${which}: the output does not match its commitment: ${delivery.output.detail}`;
  if (delivery.validator === 'fail') return `${which}: the capability validator rejected the output.`;
  return `${which}: the output is empty or not well-formed JSON.`;
}

export function isRulingScore(value: unknown): value is RulingScore {
  return typeof value === 'number' && (RULING_SCORES as readonly number[]).includes(value);
}
