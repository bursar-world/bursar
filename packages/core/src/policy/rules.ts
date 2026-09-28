import { DocumentError } from './errors.js';

export type RuleEffect = 'allow' | 'deny';

export type RulePattern =
  | { readonly type: 'exact'; readonly value: string }
  | { readonly type: 'prefix'; readonly value: string };

export type Rule = { readonly pattern: RulePattern; readonly effect: RuleEffect };

/**
 * An exact match outranks every prefix. The rank is a length elsewhere, so the exact rank has
 * to sit above any string length a caller can produce.
 */
const EXACT_SPECIFICITY = 0xffff_ffff;

/**
 * A single trailing `*` makes a prefix rule matching everything under the stem; anything else
 * matches exactly. `"*"` is the prefix rule matching everything.
 */
export function parseRule(pattern: unknown, effect: unknown): Rule {
  if (effect !== 'allow' && effect !== 'deny') {
    throw new DocumentError(`rule effect must be "allow" or "deny", got ${String(effect)}`, { effect });
  }
  if (typeof pattern !== 'string' || pattern === '') {
    throw new DocumentError('rule pattern must be a non-empty string', { pattern });
  }
  const shape: RulePattern = pattern.endsWith('*')
    ? { type: 'prefix', value: pattern.slice(0, -1) }
    : { type: 'exact', value: pattern };
  return { pattern: shape, effect };
}

/** The written form of a rule, for round-tripping a parsed document back to its hash preimage. */
export function ruleToPattern(rule: Rule): string {
  return rule.pattern.type === 'prefix' ? `${rule.pattern.value}*` : rule.pattern.value;
}

function specificity(rule: Rule, action: string): number | null {
  if (rule.pattern.type === 'exact') {
    return rule.pattern.value === action ? EXACT_SPECIFICITY : null;
  }
  return action.startsWith(rule.pattern.value) ? rule.pattern.value.length : null;
}

/**
 * Most-specific rule wins, a deny wins a tie, and nothing matching is a refusal. The last
 * clause is the whole default-deny posture: a mandate that forgets to mention an action has
 * not permitted it.
 */
export function permits(rules: readonly Rule[], action: string): boolean {
  let best: { rank: number; effect: RuleEffect } | null = null;
  for (const rule of rules) {
    const rank = specificity(rule, action);
    if (rank === null) continue;
    if (best === null || rank > best.rank) {
      best = { rank, effect: rule.effect };
    } else if (rank === best.rank && rule.effect === 'deny') {
      best = { rank, effect: 'deny' };
    }
  }
  return best?.effect === 'allow';
}
