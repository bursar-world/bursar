import { BursarError } from './errors.js';
import { toMicro } from './money.js';
import type { Micro } from './money.js';

export type EnvSource = Readonly<Record<string, string | undefined>>;

export type VarSpec<T> = {
  readonly kind: string;
  /**
   * True when the variable bounds, prices or routes money. Such a variable is never allowed a
   * default: a fee rate or a spending ceiling that appears out of nowhere when an operator forgets
   * to set it is the kind of bug that only shows up on the ledger.
   */
  readonly money: boolean;
  /** Never echo the value of a secret back in an error message. */
  readonly secret: boolean;
  readonly describe: string;
  parse(raw: string): T;
};

export type DeclMode = 'required' | 'optional' | 'default';

export type Declared<T, M extends DeclMode = DeclMode> = {
  readonly spec: VarSpec<T>;
  readonly mode: M;
  readonly fallback?: T;
};

export type EnvSchema = Readonly<Record<string, Declared<unknown, DeclMode>>>;

type ValueOf<D> = D extends { readonly spec: VarSpec<infer T> } ? T : never;

export type EnvValues<S extends EnvSchema> = {
  readonly [K in keyof S]: S[K]['mode'] extends 'optional' ? ValueOf<S[K]> | undefined : ValueOf<S[K]>;
};

export type EnvProblem = {
  readonly name: string;
  readonly reason: string;
  readonly expected: string;
};

export class EnvError extends BursarError {
  readonly problems: readonly EnvProblem[];

  constructor(problems: readonly EnvProblem[]) {
    super(
      'env_invalid',
      `Configuration is not usable:\n${problems.map(line).join('\n')}`,
      { problems },
    );
    this.problems = problems;
  }
}

/** A reason that already names the expected shape, as an address's does, is not followed by it again. */
function line(problem: EnvProblem): string {
  const expected = problem.reason.includes(problem.expected) ? '' : ` (expected ${problem.expected})`;
  return `  ${problem.name}: ${problem.reason}${expected}`;
}

function spec<T>(
  kind: string,
  describe: string,
  parse: (raw: string) => T,
  flags: { money?: boolean; secret?: boolean } = {},
): Declared<T, 'required'> {
  return {
    spec: { kind, describe, parse, money: flags.money ?? false, secret: flags.secret ?? false },
    mode: 'required',
  };
}

export function optional<T, M extends DeclMode>(declared: Declared<T, M>): Declared<T, 'optional'> {
  return { spec: declared.spec, mode: 'optional' };
}

/**
 * Rejected at declaration time for anything flagged as money, so a reviewer reading the schema can
 * see that no amount, rate or payee address can be conjured from a default.
 */
export function withDefault<T, M extends DeclMode>(declared: Declared<T, M>, fallback: T): Declared<T, 'default'> {
  if (declared.spec.money) {
    throw new BursarError(
      'env_default_forbidden',
      `A ${declared.spec.kind} variable controls money and cannot have a default. Declare it required and set it explicitly.`,
      { kind: declared.spec.kind },
    );
  }
  return { spec: declared.spec, mode: 'default', fallback };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const envVar = {
  string(options: { minLength?: number; pattern?: RegExp; secret?: boolean; money?: boolean } = {}) {
    const { minLength = 1, pattern, secret, money } = options;
    const describe = pattern ? `a string matching ${pattern}` : `a string of at least ${minLength} characters`;
    return spec(
      'string',
      describe,
      (raw) => {
        if (raw.length < minLength) throw new Error(`shorter than ${minLength} characters`);
        if (pattern && !pattern.test(raw)) throw new Error('does not match the required shape');
        return raw;
      },
      { secret: secret ?? false, money: money ?? false },
    );
  },

  int(options: { min?: number; max?: number; money?: boolean } = {}) {
    const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, money } = options;
    return spec(
      'int',
      `an integer between ${min} and ${max}`,
      (raw) => {
        if (!/^-?\d+$/.test(raw)) throw new Error('is not an integer');
        const value = Number(raw);
        if (!Number.isSafeInteger(value)) throw new Error('is outside the safe integer range');
        if (value < min || value > max) throw new Error(`is outside ${min}..${max}`);
        return value;
      },
      { money: money ?? false },
    );
  },

  bigint(options: { min?: bigint; max?: bigint; money?: boolean } = {}) {
    const { min, max, money } = options;
    return spec(
      'bigint',
      'an integer',
      (raw) => {
        if (!/^-?\d+$/.test(raw)) throw new Error('is not an integer');
        const value = BigInt(raw);
        if (min !== undefined && value < min) throw new Error(`is below ${min}`);
        if (max !== undefined && value > max) throw new Error(`is above ${max}`);
        return value;
      },
      { money: money ?? false },
    );
  },

  boolean() {
    return spec('boolean', 'true or false', (raw) => {
      const value = raw.toLowerCase();
      if (value === 'true' || value === '1') return true;
      if (value === 'false' || value === '0') return false;
      throw new Error('is not true or false');
    });
  },

  url(options: { protocols?: readonly string[]; secret?: boolean } = {}) {
    const { protocols = ['http:', 'https:'], secret } = options;
    return spec(
      'url',
      `a ${protocols.map((p) => p.replace(':', '')).join(' or ')} URL`,
      (raw) => {
        let parsed: URL;
        try {
          parsed = new URL(raw);
        } catch {
          throw new Error('is not a URL');
        }
        if (!protocols.includes(parsed.protocol)) throw new Error(`is not ${protocols.join(' or ')}`);
        return parsed.toString();
      },
      { secret: secret ?? true },
    );
  },

  /** An address decides where funds land, so it never gets a default. */
  address() {
    return spec(
      'address',
      'a 20-byte hex address',
      (raw) => {
        if (!ADDRESS.test(raw)) throw new Error('is not a 20-byte hex address');
        return raw as `0x${string}`;
      },
      { money: true },
    );
  },

  /** Six-decimal micro-USD in atomic units, matching the ledger and the contracts. */
  micro(options: { min?: Micro; max?: Micro } = {}) {
    const { min, max } = options;
    return spec(
      'micro',
      'an amount in micro-USD atomic units (1000000 = 1 USDG)',
      (raw) => {
        const value = toMicro(raw);
        if (min !== undefined && value < min) throw new Error(`is below ${min}`);
        if (max !== undefined && value > max) throw new Error(`is above ${max}`);
        return value;
      },
      { money: true },
    );
  },

  bps() {
    return spec(
      'bps',
      'basis points, 0 to 10000',
      (raw) => {
        if (!/^\d+$/.test(raw)) throw new Error('is not a whole number of basis points');
        const value = Number(raw);
        if (value > 10_000) throw new Error('is above 10000 basis points');
        return value;
      },
      { money: true },
    );
  },

  oneOf<const T extends readonly string[]>(allowed: T) {
    return spec('oneOf', allowed.join(' or '), (raw) => {
      if (!allowed.includes(raw)) throw new Error(`is not one of ${allowed.join(', ')}`);
      return raw as T[number];
    });
  },

  list(options: { separator?: string; minLength?: number } = {}) {
    const { separator = ',', minLength = 1 } = options;
    return spec('list', `at least ${minLength} value(s) separated by "${separator}"`, (raw) => {
      const parts = raw
        .split(separator)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      if (parts.length < minLength) throw new Error(`has fewer than ${minLength} entries`);
      return parts as readonly string[];
    });
  },

  /** Whole seconds. Windows and timeouts, not amounts. */
  seconds(options: { min?: number; max?: number } = {}) {
    return envVar.int({ min: options.min ?? 0, max: options.max ?? 31_536_000 });
  },
} as const;

/**
 * Reads and validates every declared variable, then reports every problem at once. A service that
 * dies on the first missing variable makes an operator restart it once per mistake.
 *
 * An empty string counts as unset. Container tooling writes one for a variable nobody supplied,
 * and treating it as a value is how a payee address ends up empty.
 */
export function loadEnv<S extends EnvSchema>(schema: S, source: EnvSource = process.env): EnvValues<S> {
  const problems: EnvProblem[] = [];
  const values: Record<string, unknown> = {};

  for (const [name, declared] of Object.entries(schema) as [string, Declared<unknown, DeclMode>][]) {
    const raw = source[name];
    const present = raw !== undefined && raw.trim() !== '';

    if (!present) {
      if (declared.mode === 'required') {
        problems.push({ name, reason: 'is not set', expected: declared.spec.describe });
      } else if (declared.mode === 'default') {
        values[name] = declared.fallback;
      } else {
        values[name] = undefined;
      }
      continue;
    }

    try {
      values[name] = declared.spec.parse(raw.trim());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      problems.push({
        name,
        reason: declared.spec.secret ? reason : `${reason} (value: ${raw.trim()})`,
        expected: declared.spec.describe,
      });
    }
  }

  if (problems.length > 0) throw new EnvError(problems);
  return values as EnvValues<S>;
}
