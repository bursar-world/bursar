/**
 * Sliding-window counters, in memory, one per key.
 *
 * A token is allowed a number of requests per window, and an owner a number of new connections.
 * The counts live in this process, so a deployment with several instances multiplies the ceiling
 * by their number; the figure is a ceiling on abuse, not a quota, and the mandate's own limits are
 * what bound what a token can spend.
 */

export type RateLimiter = {
  /** True when the request is within the limit, in which case it has been counted. */
  take(key: string, now?: number): boolean;
  /** Seconds until the oldest counted request leaves the window. */
  retryAfter(key: string, now?: number): number;
};

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const seen = new Map<string, number[]>();
  let sweptAt = 0;

  function prune(key: string, now: number): number[] {
    const stamps = (seen.get(key) ?? []).filter((at) => now - at < windowMs);
    if (stamps.length === 0) seen.delete(key);
    else seen.set(key, stamps);
    return stamps;
  }

  // Keys nobody has used for a window are dropped on the way past, so the map does not grow with
  // every token that was ever presented.
  function sweep(now: number): void {
    if (now - sweptAt < windowMs) return;
    sweptAt = now;
    for (const key of [...seen.keys()]) prune(key, now);
  }

  return {
    take(key, now = Date.now()) {
      sweep(now);
      const stamps = prune(key, now);
      if (stamps.length >= limit) return false;
      stamps.push(now);
      seen.set(key, stamps);
      return true;
    },
    retryAfter(key, now = Date.now()) {
      const oldest = prune(key, now)[0];
      return oldest === undefined ? 0 : Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1_000));
    },
  };
}
