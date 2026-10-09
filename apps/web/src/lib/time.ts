/**
 * Times on screen are rendered in the reader's own zone, which means the server and the browser
 * disagree during hydration. Every helper here is called from a client component after mount, or
 * through `<Instant>`, which renders the ISO form on the server and the local form once mounted.
 */
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

export function formatInstant(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatClock(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

/** "4h 12m". Two units, because a refusal that says 15132 seconds has told the reader nothing. */
export function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  if (value < MINUTE) return `${value}s`;
  if (value < HOUR) {
    const minutes = Math.floor(value / MINUTE);
    const rest = value % MINUTE;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  if (value < DAY) {
    const hours = Math.floor(value / HOUR);
    const rest = Math.floor((value % HOUR) / MINUTE);
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  const days = Math.floor(value / DAY);
  const rest = Math.floor((value % DAY) / HOUR);
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/**
 * "2 days", "1 hour 30 minutes": the same two units as `formatDuration`, written out, for a setting
 * or a sentence. "Wait 2d before a change" reads as code; a table cell counting down can stay short.
 */
export function spellDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (value < MINUTE) return unit(value, 'second');
  if (value < HOUR) {
    const rest = value % MINUTE;
    return `${unit(Math.floor(value / MINUTE), 'minute')}${rest === 0 ? '' : ` ${unit(rest, 'second')}`}`;
  }
  if (value < DAY) {
    const rest = Math.floor((value % HOUR) / MINUTE);
    return `${unit(Math.floor(value / HOUR), 'hour')}${rest === 0 ? '' : ` ${unit(rest, 'minute')}`}`;
  }
  const rest = Math.floor((value % DAY) / HOUR);
  return `${unit(Math.floor(value / DAY), 'day')}${rest === 0 ? '' : ` ${unit(rest, 'hour')}`}`;
}

/**
 * How far the chain's clock runs from this browser's, as the last read that carried a block time
 * found it. Windows on chain open and close by block time, so a countdown to one counts on the
 * chain's clock. A gap under a minute is a block still on its way, not a clock that is wrong, and
 * is left out so countdowns do not jump with every read.
 */
let chainSkewMs = 0;
const SKEW_FLOOR_MS = 60_000;

export function noteChainTime(chainSeconds: bigint, readAtMs: number = Date.now()): void {
  const skew = Number(chainSeconds) * 1000 - readAtMs;
  chainSkewMs = Math.abs(skew) < SKEW_FLOOR_MS ? 0 : skew;
}

/** The chain's time now, as this browser can best tell it. */
export function chainNow(): Date {
  return new Date(Date.now() + chainSkewMs);
}

/** "in 4h 12m" or "12m ago", counted on the chain's clock unless told otherwise. */
export function formatRelative(date: Date, now: Date = chainNow()): string {
  const delta = Math.round((date.getTime() - now.getTime()) / 1000);
  if (Math.abs(delta) < 5) return 'just now';
  return delta > 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`;
}

export function secondsUntil(date: Date, now: Date = chainNow()): number {
  return Math.floor((date.getTime() - now.getTime()) / 1000);
}

export function isPast(date: Date, now: Date = chainNow()): boolean {
  return date.getTime() <= now.getTime();
}

/** A date picked as the day something ends is good for the whole of that day, in the reader's own zone. */
export function endOfDay(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return Number.NaN;
  return new Date(year, month - 1, day, 23, 59, 59).getTime();
}

/** The reader's own calendar date for an instant, in the form a date input holds. */
export function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Unix seconds as the chain holds them. Zero means "no deadline", which is not 1970. */
export function fromUnix(seconds: bigint): Date | null {
  return seconds === 0n ? null : new Date(Number(seconds) * 1000);
}
