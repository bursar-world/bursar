import { describe, expect, it } from 'vitest';

import { createAlerter } from '../src/alert.js';
import { silentLogger } from './support/keys.js';

describe('alerts', () => {
  it('posts one body that Slack, Discord and Telegram all read', async () => {
    let body: unknown;
    const alerter = createAlerter({
      webhook: 'https://hooks.example.com/x',
      logger: silentLogger(),
      fetch: (async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response('ok');
      }) as typeof fetch,
    });

    await alerter.send('CRITICAL', 'quorum_at_risk', 'Dispute 3 is short of quorum.', { disputeId: 3n });
    expect(body).toEqual({ text: '[CRITICAL] Dispute 3 is short of quorum.\ndisputeId: 3', content: '[CRITICAL] Dispute 3 is short of quorum.\ndisputeId: 3' });
  });

  it('logs every alert at its level, webhook or not', async () => {
    const logger = silentLogger();
    const alerter = createAlerter({ webhook: undefined, logger });
    await alerter.send('CRITICAL', 'reveal_owed', 'x');
    await alerter.send('INFO', 'heartbeat', 'y');
    expect(logger.lines.map((line) => [line.level, line.event, line.fields['alert']])).toEqual([
      ['error', 'reveal_owed', 'CRITICAL'],
      ['info', 'heartbeat', 'INFO'],
    ]);
  });

  it('never throws when the webhook is down, and says so in the log', async () => {
    const logger = silentLogger();
    const alerter = createAlerter({
      webhook: 'https://hooks.example.com/x',
      logger,
      fetch: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as typeof fetch,
    });

    await expect(alerter.send('WARN', 'key_check', 'low gas')).resolves.toBeUndefined();
    expect(logger.lines.at(-1)).toMatchObject({ level: 'error', event: 'alert_undelivered' });
  });
});
