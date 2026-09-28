/**
 * A gas budget with a rolling day and a rolling hour per payer.
 *
 * Settling for someone else means broadcasting a transaction and paying its gas, which is both the
 * cost of the service and its whole abuse surface. Verify is read-only and free; settle is
 * metered, checked before the broadcast and never after, so a refusal costs nothing.
 *
 * The budget is process-local. It caps what one relayer key can be made to spend, which
 * is the thing that has to hold even when the database is unreachable.
 */

export type BudgetOptions = {
  readonly dailySettlements?: number;
  readonly perPayerPerHour?: number;
  readonly now?: () => number;
};

export type BudgetState = {
  readonly settlementsToday: number;
  readonly dailyLimit: number;
  readonly perPayerHourlyLimit: number;
  readonly windowStartedAt: number;
};

export type BudgetDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'daily_budget_exhausted' | 'payer_rate_limited' };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export class SettlementBudget {
  private readonly dailyLimit: number;
  private readonly perPayerHourlyLimit: number;
  private readonly clock: () => number;
  private windowStartedAt: number;
  private spentToday = 0;
  private readonly perPayer = new Map<string, number[]>();

  constructor(options: BudgetOptions = {}) {
    this.dailyLimit = Math.max(0, options.dailySettlements ?? 2_000);
    this.perPayerHourlyLimit = Math.max(0, options.perPayerPerHour ?? 60);
    this.clock = options.now ?? (() => Date.now());
    this.windowStartedAt = this.clock();
  }

  private roll(): void {
    const now = this.clock();
    if (now - this.windowStartedAt < DAY_MS) return;
    this.windowStartedAt = now;
    this.spentToday = 0;
    this.perPayer.clear();
  }

  /** Reserves one settlement. Call before broadcasting, never after. */
  take(payer: string | null | undefined): BudgetDecision {
    this.roll();
    if (this.spentToday >= this.dailyLimit) return { ok: false, reason: 'daily_budget_exhausted' };

    const now = this.clock();
    const key = String(payer ?? '').toLowerCase();
    const recent = (this.perPayer.get(key) ?? []).filter((at) => at > now - HOUR_MS);
    if (recent.length >= this.perPayerHourlyLimit) return { ok: false, reason: 'payer_rate_limited' };

    recent.push(now);
    this.perPayer.set(key, recent);
    this.spentToday += 1;
    return { ok: true };
  }

  /**
   * Returns an allowance that bought nothing.
   *
   * Only for a settle that provably did not broadcast. A broadcast whose receipt could not be read
   * did cost gas, so its allowance stays spent.
   */
  refund(payer: string | null | undefined): void {
    this.spentToday = Math.max(0, this.spentToday - 1);
    const key = String(payer ?? '').toLowerCase();
    const recent = this.perPayer.get(key);
    if (recent && recent.length > 0) recent.pop();
  }

  state(): BudgetState {
    this.roll();
    return {
      settlementsToday: this.spentToday,
      dailyLimit: this.dailyLimit,
      perPayerHourlyLimit: this.perPayerHourlyLimit,
      windowStartedAt: this.windowStartedAt,
    };
  }
}
