/**
 * What the ruling service has published about one dispute, as this console shows it.
 *
 * The chain says how a dispute settled. The published ruling says why: the rule that applied, the
 * reasons, and which evidence counted. It is read through this app's own route, because the
 * service has no public address, and a reading that fails says so rather than showing nothing.
 */

export const POLICY_PATH = '/docs/ruling-policy';

export type RulingReading =
  | {
      readonly kind: 'published';
      readonly policyVersion: string;
      readonly rule: string | null;
      readonly score: number | null;
      readonly reasons: readonly string[];
      readonly evidence: number;
      readonly counted: number;
      readonly statements: readonly string[];
      readonly operatorParty: boolean;
      readonly note: string | null;
    }
  | { readonly kind: 'sealed'; readonly revealsFrom: Date | null }
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' };

const RULE_LABELS: Readonly<Record<string, string>> = {
  P0: 'No vote: the payment was not held in dispute',
  P1: 'The job could not be verified',
  P2: 'No delivery evidence arrived in time',
  P3: 'The delivery evidence did not check out',
  P4: 'Partly delivered',
  P5: 'Delivered as committed',
  P6: 'Operator override',
};

export function ruleLabel(rule: string | null): string {
  if (rule === null) return 'Recovered from the chain';
  return RULE_LABELS[rule] ?? rule;
}

/** The service's answer, read defensively: a field it did not send is a field this does not show. */
export function readRulingBody(status: number, body: unknown): RulingReading {
  if (status === 404) return { kind: 'none' };
  if (status !== 200 || typeof body !== 'object' || body === null) return { kind: 'unavailable' };

  const record = body as Record<string, unknown>;
  if (record['status'] === 'sealed') {
    const from = typeof record['revealsFrom'] === 'string' ? new Date(record['revealsFrom']) : null;
    return { kind: 'sealed', revealsFrom: from !== null && Number.isFinite(from.getTime()) ? from : null };
  }
  if (record['status'] !== 'published') return { kind: 'unavailable' };

  const evidence = Array.isArray(record['evidence']) ? (record['evidence'] as Record<string, unknown>[]) : [];
  const deliveries = evidence.filter((entry) => entry['kind'] === 'delivery');

  return {
    kind: 'published',
    policyVersion: typeof record['policyVersion'] === 'string' ? record['policyVersion'] : 'unknown',
    rule: typeof record['rule'] === 'string' ? record['rule'] : null,
    score: typeof record['score'] === 'number' ? record['score'] : null,
    reasons: Array.isArray(record['reasons']) ? record['reasons'].filter((reason): reason is string => typeof reason === 'string') : [],
    evidence: deliveries.length,
    counted: deliveries.filter((entry) => entry['counted'] === true).length,
    statements: evidence
      .filter((entry) => entry['kind'] === 'payer-statement' && typeof entry['statement'] === 'string')
      .map((entry) => entry['statement'] as string),
    operatorParty: record['operatorParty'] === true,
    note: typeof record['note'] === 'string' ? record['note'] : null,
  };
}

/** `registry` names an earlier registry; absent, the resolver answers for the current one. */
export async function readRuling(disputeId: bigint, signal?: AbortSignal, registry?: string): Promise<RulingReading> {
  try {
    const query = registry === undefined ? '' : `&registry=${registry}`;
    const response = await fetch(`/api/rulings?dispute=${disputeId.toString()}${query}`, { cache: 'no-store', signal });
    return readRulingBody(response.status, await response.json().catch(() => null));
  } catch {
    return { kind: 'unavailable' };
  }
}
