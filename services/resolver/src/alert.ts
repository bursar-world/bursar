import { describeError } from './log.js';
import type { LogFields, Logger } from './log.js';

export type AlertLevel = 'INFO' | 'WARN' | 'CRITICAL';

export type Alerter = {
  send(level: AlertLevel, event: string, message: string, fields?: LogFields): Promise<void>;
};

export type AlerterOptions = {
  /** Unset means the structured log is the only channel, which is said once at startup. */
  readonly webhook: string | undefined;
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
};

/** Discord refuses a message over 2,000 characters, and Slack truncates well before a pager does. */
const MAX_TEXT = 1_900;

/**
 * Every alert goes to the log and, when one is configured, to a chat webhook.
 *
 * The body carries the message as `text`, which Slack and Telegram's `sendMessage` read, and as
 * `content`, which Discord reads, so one URL of any of the three works without a setting to say
 * which. A Telegram URL carries its `chat_id` in the query string.
 *
 * Delivery failures are logged and never thrown. An alert is sent from inside the path that votes,
 * and a chat service being down must not be the reason a reveal did not go out.
 */
export function createAlerter(options: AlerterOptions): Alerter {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    send: async (level, event, message, fields = {}) => {
      const line = { alert: level, message, ...fields };
      if (level === 'CRITICAL') options.logger.error(event, line);
      else if (level === 'WARN') options.logger.warn(event, line);
      else options.logger.info(event, line);

      if (options.webhook === undefined) return;

      const detail = Object.entries(fields)
        .map(([name, value]) => `${name}: ${String(value)}`)
        .join('\n');
      const text = clip(`[${level}] ${message}${detail === '' ? '' : `\n${detail}`}`);

      try {
        const response = await doFetch(options.webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, content: text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) options.logger.error('alert_undelivered', { event, status: response.status });
      } catch (error) {
        options.logger.error('alert_undelivered', { event, reason: describeError(error) });
      }
    },
  };
}

function clip(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}…`;
}
