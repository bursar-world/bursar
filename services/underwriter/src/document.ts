import { type Micro, toMicro } from '@bursar/core';
import { getAddress } from 'viem';

import { type CanonicalValue, canonicalJson, sha256Bytes32 } from './canonical.js';
import { DocumentError } from './errors.js';
import { type Rule, parseRule, ruleToPattern } from './rules.js';

/** uint128, the width MandateAccount types every amount at. Anything wider cannot be spent. */
export const MAX_AMOUNT_MICROS = (1n << 128n) - 1n;

/** uint64, the width the contract types every timestamp and window duration at. */
const MAX_UINT64 = (1n << 64n) - 1n;

export type Address = `0x${string}`;
export type Hex32 = `0x${string}`;

/**
 * Which roster decides whether a merchant can be paid, mirroring `IMandateAccount.MerchantGate`.
 * Exactly one is live at a time on chain, so a document that declares the other one is
 * describing limits nobody is enforcing.
 */
export type MerchantGate =
  | { readonly kind: 'allowlist'; readonly merchants: readonly Address[] }
  | { readonly kind: 'merkleRoot'; readonly root: Hex32 };

/** A rolling spend window: a cap and the period it refills over. */
export type MandateWindow = { readonly limitMicros: Micro; readonly seconds: number };

/**
 * The off-chain mandate. It is the document a principal signs and an auditor reads, and it is
 * not the enforcement point: `MandateAccount` is. Every field here that the contract also
 * holds exists so the two can be compared, and the contract wins every disagreement.
 *
 * `ceilingMicros` is the exception and is labelled as such in every quote. The contract has no
 * lifetime ceiling, so that limit is enforced by this service alone.
 */
export type MandateDocument = {
  readonly subject: string;
  /** The MandateAccount these terms describe. Null means the document is not bound to one. */
  readonly account: Address | null;
  readonly chainId: number | null;
  /** The `MandateAccount.version` these terms were written against. Null means unanchored. */
  readonly version: bigint | null;
  readonly validFrom: string | null;
  readonly expiresAt: string;
  readonly rules: readonly Rule[];
  readonly ceilingMicros: Micro;
  readonly perCallCapMicros: Micro;
  readonly approvalThresholdMicros: Micro | null;
  readonly daily: MandateWindow | null;
  readonly monthly: MandateWindow | null;
  /** Where both rolling windows start counting. Required once a window is declared. */
  readonly windowAnchor: string | null;
  readonly merchantGate: MerchantGate | null;
  readonly capabilities: readonly Hex32[] | null;
};

const KNOWN_KEYS = new Set([
  'subject',
  'account',
  'chain_id',
  'version',
  'valid_from',
  'expires_at',
  'rules',
  'ceiling_micros',
  'per_call_cap_micros',
  'approval_threshold_micros',
  'daily_limit_micros',
  'daily_window_seconds',
  'monthly_limit_micros',
  'monthly_window_seconds',
  'window_anchor',
  'merchant_gate',
  'capabilities',
]);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DocumentError(`${label} must be an object`, { label });
  }
  return value as Record<string, unknown>;
}

function amount(raw: unknown, field: string): Micro {
  let value: Micro;
  try {
    value = toMicro(raw as bigint | number | string);
  } catch (cause) {
    throw new DocumentError(`${field} must be an integer count of micro-USD`, {
      field,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (value < 0n) throw new DocumentError(`${field} must not be negative`, { field });
  if (value > MAX_AMOUNT_MICROS) {
    throw new DocumentError(`${field} exceeds the uint128 the contract stores it in`, { field });
  }
  return value;
}

/** RFC 3339 to epoch milliseconds. A timestamp the runtime cannot parse is not a deadline. */
export function parseTimestamp(raw: unknown, field: string): number {
  if (typeof raw !== 'string' || raw === '') {
    throw new DocumentError(`${field} must be an RFC 3339 timestamp`, { field });
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new DocumentError(`${field} must be an RFC 3339 timestamp`, { field, value: raw });
  }
  return ms;
}

function address(raw: unknown, field: string): Address {
  if (typeof raw !== 'string') throw new DocumentError(`${field} must be a 20-byte address`, { field });
  try {
    return getAddress(raw);
  } catch {
    throw new DocumentError(`${field} must be a 20-byte address`, { field, value: raw });
  }
}

function hex32(raw: unknown, field: string): Hex32 {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new DocumentError(`${field} must be a 0x-prefixed 32-byte value`, { field, value: String(raw) });
  }
  return raw.toLowerCase() as Hex32;
}

function seconds(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new DocumentError(`${field} must be a positive whole number of seconds`, { field, value: String(raw) });
  }
  if (BigInt(raw) > MAX_UINT64) {
    throw new DocumentError(`${field} exceeds the uint64 the contract stores it in`, { field });
  }
  return raw;
}

function optionalWindow(
  raw: Record<string, unknown>,
  limitKey: 'daily_limit_micros' | 'monthly_limit_micros',
  windowKey: 'daily_window_seconds' | 'monthly_window_seconds',
): MandateWindow | null {
  const limit = raw[limitKey];
  const period = raw[windowKey];
  if (limit == null && period == null) return null;
  // Half a window is not a limit. A cap with no period never refills and a period with no cap
  // caps nothing, and either one read as "enforced" would overstate what the document says.
  if (limit == null || period == null) {
    throw new DocumentError(`${limitKey} and ${windowKey} must be declared together`, { limitKey, windowKey });
  }
  return { limitMicros: amount(limit, limitKey), seconds: seconds(period, windowKey) };
}

function parseMerchantGate(raw: unknown): MerchantGate | null {
  if (raw == null) return null;
  const gate = requireRecord(raw, 'merchant_gate');
  const kind = gate['kind'];
  if (kind === 'allowlist') {
    const merchants = gate['merchants'];
    if (!Array.isArray(merchants)) {
      throw new DocumentError('merchant_gate.merchants must be an array of addresses');
    }
    return {
      kind: 'allowlist',
      merchants: merchants.map((m, i) => address(m, `merchant_gate.merchants[${i}]`)),
    };
  }
  if (kind === 'merkleRoot') {
    const root = hex32(gate['root'], 'merchant_gate.root');
    // An all-zero root under a Merkle gate admits nobody, which reads as an outage, not a
    // policy. The contract refuses to set one, so the document may not declare one either.
    if (/^0x0{64}$/.test(root)) {
      throw new DocumentError('merchant_gate.root must not be zero under a Merkle gate');
    }
    return { kind: 'merkleRoot', root };
  }
  throw new DocumentError('merchant_gate.kind must be "allowlist" or "merkleRoot"', { kind: String(kind) });
}

/**
 * Normalises an operator-written mandate into the shape the evaluator reads.
 *
 * An unrecognised top-level key is rejected. A key this build does not understand is most likely
 * a restriction someone meant to apply, and quietly dropping it would turn a tightening into a
 * loosening.
 */
export function parseDocument(raw: unknown, label = 'mandate document'): MandateDocument {
  const doc = requireRecord(raw, label);

  for (const key of Object.keys(doc)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new DocumentError(`${label} has an unrecognised field "${key}"`, { field: key });
    }
  }

  const subject = doc['subject'];
  if (typeof subject !== 'string' || subject === '') {
    throw new DocumentError('mandate subject is required');
  }

  const expiresAt = doc['expires_at'];
  const expiresMs = parseTimestamp(expiresAt, 'expires_at');

  const validFromRaw = doc['valid_from'];
  const validFrom = validFromRaw == null ? null : (validFromRaw as string);
  if (validFrom !== null) {
    const fromMs = parseTimestamp(validFrom, 'valid_from');
    if (fromMs >= expiresMs) {
      throw new DocumentError('valid_from must fall before expires_at', { validFrom, expiresAt: String(expiresAt) });
    }
  }

  const rulesRaw = doc['rules'] ?? [];
  if (!Array.isArray(rulesRaw)) throw new DocumentError('rules must be an array');
  const rules = rulesRaw.map((entry, index) => {
    const rule = requireRecord(entry, `rules[${index}]`);
    return parseRule(rule['pattern'], rule['effect']);
  });

  const ceilingMicros = amount(doc['ceiling_micros'], 'ceiling_micros');
  const perCallCapMicros = amount(doc['per_call_cap_micros'], 'per_call_cap_micros');

  const thresholdRaw = doc['approval_threshold_micros'];
  const approvalThresholdMicros = thresholdRaw == null ? null : amount(thresholdRaw, 'approval_threshold_micros');

  const daily = optionalWindow(doc, 'daily_limit_micros', 'daily_window_seconds');
  const monthly = optionalWindow(doc, 'monthly_limit_micros', 'monthly_window_seconds');

  const anchorRaw = doc['window_anchor'];
  let windowAnchor = anchorRaw == null ? null : (anchorRaw as string);
  if (windowAnchor !== null) parseTimestamp(windowAnchor, 'window_anchor');
  if (windowAnchor === null && (daily !== null || monthly !== null)) {
    // The contract anchors both windows at the block that last wrote the limits. The document
    // cannot know that timestamp, so it has to state the one it was written against; without
    // it, a rolling window here would refill on a schedule nothing on chain shares.
    windowAnchor = validFrom;
    if (windowAnchor === null) {
      throw new DocumentError('window_anchor or valid_from is required once a rolling window is declared');
    }
  }

  const versionRaw = doc['version'];
  let version: bigint | null = null;
  if (versionRaw != null) {
    const parsed =
      typeof versionRaw === 'bigint'
        ? versionRaw
        : typeof versionRaw === 'number' && Number.isSafeInteger(versionRaw)
          ? BigInt(versionRaw)
          : typeof versionRaw === 'string' && /^\d+$/.test(versionRaw)
            ? BigInt(versionRaw)
            : null;
    if (parsed === null || parsed < 0n || parsed > MAX_UINT64) {
      throw new DocumentError('version must be a non-negative integer inside uint64', {
        value: String(versionRaw),
      });
    }
    version = parsed;
  }

  const chainIdRaw = doc['chain_id'];
  if (chainIdRaw != null && (typeof chainIdRaw !== 'number' || !Number.isSafeInteger(chainIdRaw) || chainIdRaw <= 0)) {
    throw new DocumentError('chain_id must be a positive integer', { value: String(chainIdRaw) });
  }

  const capabilitiesRaw = doc['capabilities'];
  let capabilities: readonly Hex32[] | null = null;
  if (capabilitiesRaw != null) {
    if (!Array.isArray(capabilitiesRaw)) throw new DocumentError('capabilities must be an array of bytes32 ids');
    capabilities = capabilitiesRaw.map((id, i) => hex32(id, `capabilities[${i}]`));
  }

  return {
    subject,
    account: doc['account'] == null ? null : address(doc['account'], 'account'),
    chainId: chainIdRaw == null ? null : (chainIdRaw as number),
    version,
    validFrom,
    expiresAt: expiresAt as string,
    rules,
    ceilingMicros,
    perCallCapMicros,
    approvalThresholdMicros,
    daily,
    monthly,
    windowAnchor,
    merchantGate: parseMerchantGate(doc['merchant_gate']),
    capabilities,
  };
}

/**
 * The document as it is hashed: the normalised form, not the file as written. Two files that
 * differ only in whitespace, key order or a `100000` written as `"100000"` describe the same
 * mandate and must produce the same hash, or a principal could be shown one document and an
 * auditor a different-looking one that anchors identically.
 */
export function documentPreimage(document: MandateDocument): CanonicalValue {
  return {
    subject: document.subject,
    account: document.account ?? undefined,
    chain_id: document.chainId ?? undefined,
    version: document.version ?? undefined,
    valid_from: document.validFrom ?? undefined,
    expires_at: document.expiresAt,
    rules: document.rules.map((rule) => ({ effect: rule.effect, pattern: ruleToPattern(rule) })),
    ceiling_micros: document.ceilingMicros,
    per_call_cap_micros: document.perCallCapMicros,
    approval_threshold_micros: document.approvalThresholdMicros ?? undefined,
    daily_limit_micros: document.daily?.limitMicros,
    daily_window_seconds: document.daily?.seconds,
    monthly_limit_micros: document.monthly?.limitMicros,
    monthly_window_seconds: document.monthly?.seconds,
    window_anchor: document.windowAnchor ?? undefined,
    merchant_gate:
      document.merchantGate === null
        ? undefined
        : document.merchantGate.kind === 'allowlist'
          ? { kind: 'allowlist', merchants: [...document.merchantGate.merchants].sort() }
          : { kind: 'merkleRoot', root: document.merchantGate.root },
    capabilities: document.capabilities === null ? undefined : [...document.capabilities].sort(),
  };
}

/** SHA-256 over the canonical form, sized to drop straight into `setDocumentHash`. */
export function documentHash(document: MandateDocument): Hex32 {
  return sha256Bytes32(canonicalJson(documentPreimage(document)));
}
