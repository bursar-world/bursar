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

/** "in 4h 12m" or "12m ago". */
export function formatRelative(date: Date, now: Date = new Date()): string {
  const delta = Math.round((date.getTime() - now.getTime()) / 1000);
  if (Math.abs(delta) < 5) return 'just now';
  return delta > 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`;
}

export function secondsUntil(date: Date, now: Date = new Date()): number {
  return Math.floor((date.getTime() - now.getTime()) / 1000);
}

export function isPast(date: Date, now: Date = new Date()): boolean {
  return date.getTime() <= now.getTime();
}

/** Unix seconds as the chain holds them. Zero means "no deadline", which is not 1970. */
export function fromUnix(seconds: bigint): Date | null {
  return seconds === 0n ? null : new Date(Number(seconds) * 1000);
}
