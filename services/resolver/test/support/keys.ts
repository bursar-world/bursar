import { privateKeyToAccount } from 'viem/accounts';

import type { Alerter, AlertLevel } from '../../src/alert.js';
import type { ResolverKey } from '../../src/keys.js';
import type { LogFields, Logger } from '../../src/log.js';

export function testKeys(count = 3): ResolverKey[] {
  return Array.from({ length: count }, (_, index) => {
    const account = privateKeyToAccount(`0x${(index + 1).toString(16).padStart(2, '0').repeat(32)}`);
    return { name: `resolver-${index + 1}`, address: account.address, account };
  });
}

export type Captured = { readonly level: AlertLevel; readonly event: string; readonly message: string; readonly fields: LogFields };

export function captureAlerts(): Alerter & { readonly sent: Captured[] } {
  const sent: Captured[] = [];
  return {
    sent,
    send: async (level, event, message, fields = {}) => {
      sent.push({ level, event, message, fields });
    },
  };
}

export function silentLogger(): Logger & { readonly lines: { level: string; event: string; fields: LogFields }[] } {
  const lines: { level: string; event: string; fields: LogFields }[] = [];
  return {
    lines,
    info: (event, fields = {}) => lines.push({ level: 'info', event, fields }),
    warn: (event, fields = {}) => lines.push({ level: 'warn', event, fields }),
    error: (event, fields = {}) => lines.push({ level: 'error', event, fields }),
  };
}
