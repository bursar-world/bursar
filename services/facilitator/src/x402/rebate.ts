import { BaseError, isAddress } from 'viem';
import type { Address } from 'viem';

/**
 * The fee rebate a staked payee earns, read from the staking pool.
 *
 * The pool is the authority. `rebateBpsOf` walks its tier table against one account's earning stake
 * and answers in basis points off this service's fee. Nothing here holds the tiers, so a table
 * governance rewrites reaches the fee within one cache interval, with no restart.
 */

/** `IStaking.rebateBpsOf`, the one function this service calls on the pool. */
export const stakingRebateAbi = [
  {
    type: 'function',
    name: 'rebateBpsOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint16' }],
  },
] as const;

/**
 * `Staking.MAX_REBATE_BPS`. The pool refuses a tier above it, so a larger answer came from some
 * contract other than the pool the deployment record names.
 */
export const MAX_REBATE_BPS = 5_000;

/** How long one payee's rebate is reused. A new stake, or an exit request, reaches the fee within it. */
export const REBATE_CACHE_MS = 60_000;

/**
 * Far more payees than a deployment settles for inside one cache interval. Past it the oldest answer
 * is dropped, so a run of new payees cannot grow the process without bound.
 */
export const REBATE_CACHE_SIZE = 10_000;

/** Basis points off the fee for one payee. Rejects when the pool could not be read. */
export type RebateReader = (payee: Address) => Promise<number>;

type ReadClient = {
  readContract(args: {
    address: Address;
    abi: typeof stakingRebateAbi;
    functionName: 'rebateBpsOf';
    args: readonly [Address];
  }): Promise<number>;
};

/** Reads `pool`. Null where the deployment record names no pool, and every payee pays the full fee. */
export function stakingRebates(client: ReadClient, pool: Address | null): RebateReader | null {
  if (pool === null) return null;
  return (payee) =>
    client.readContract({ address: pool, abi: stakingRebateAbi, functionName: 'rebateBpsOf', args: [payee] });
}

export type RebatesOptions = {
  readonly read: RebateReader | null;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
};

/**
 * Each payee's rebate, reused for a short interval and never guessed.
 *
 * Fails closed. A read that throws, or answers with a figure the pool could not have given, is
 * logged and counted as no rebate: charging the full fee while the pool is out of reach costs a
 * staker a discount for that long, and discounting on a guess gives away fee nobody earned. Only
 * answers are cached, so the next settle asks again.
 */
export class Rebates {
  private readonly read: RebateReader | null;
  private readonly clock: () => number;
  private readonly log: (line: string) => void;
  private readonly answers = new Map<string, { readonly bps: number; readonly until: number }>();

  constructor(options: RebatesOptions) {
    this.read = options.read;
    this.clock = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => undefined);
  }

  /** Never rejects. A rebate that could not be read is zero. */
  async of(payee: string): Promise<number> {
    if (this.read === null) return 0;

    const key = payee.toLowerCase();
    const cached = this.answers.get(key);
    if (cached && cached.until > this.clock()) return cached.bps;
    if (!isAddress(key)) return this.unread(payee, 'not an address');

    let bps: number;
    try {
      bps = await this.read(key);
    } catch (error) {
      return this.unread(payee, describe(error));
    }
    if (!Number.isInteger(bps) || bps < 0 || bps > MAX_REBATE_BPS) {
      return this.unread(payee, `the pool answered ${bps}, outside 0 to ${MAX_REBATE_BPS}`);
    }

    // Deleted first, so a payee read again moves to the back of the order answers are dropped in.
    this.answers.delete(key);
    if (this.answers.size >= REBATE_CACHE_SIZE) {
      const oldest = this.answers.keys().next();
      if (!oldest.done) this.answers.delete(oldest.value);
    }
    this.answers.set(key, { bps, until: this.clock() + REBATE_CACHE_MS });
    return bps;
  }

  private unread(payee: string, reason: string): number {
    this.log(`rebate unread payee=${payee} fee=full reason=${reason}`);
    return 0;
  }
}

/** viem's one-line summary, because its full message carries the call, the docs link and the version. */
function describe(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}
