import { describe, expect, it } from 'vitest';
import { getAddress, recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ASSISTANT_LABEL_MAX_CHARS, assistantConnectMessage, assistantDisconnectMessage, checkLabel as checkAssistantLabel } from '../src/assistant.js';

const fields = {
  mandate: '0x00000000000000000000000000000000000acc01',
  owner: '0x1111111111111111111111111111111111111111',
  chainId: 4663,
  nonce: `0x${'0f'.repeat(16)}`,
  issuedAt: '2026-10-10T11:59:00.000Z',
} as const;

describe('the message an owner signs to connect an assistant', () => {
  it('names the mandate, the owner, the chain, the nonce and the time, checksummed, and says it moves nothing', () => {
    const message = assistantConnectMessage(fields);
    expect(message).toContain('Bursar: connect an assistant');
    expect(message).toContain(`Mandate: ${getAddress(fields.mandate)}`);
    expect(message).toContain('Owner: 0x1111111111111111111111111111111111111111');
    expect(message).toContain('Chain: 4663');
    expect(message).toContain(`Nonce: ${fields.nonce}`);
    expect(message).toContain('Issued: 2026-10-10T11:59:00.000Z');
    expect(message).toContain('sends no\ntransaction');
    expect(message).not.toContain('Label:');
    expect(assistantConnectMessage({ ...fields, label: ' Claude ' })).toContain('Label: Claude');
  });

  it('is the same text for the same fields, so the host can rebuild it', async () => {
    const owner = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
    const signature = await owner.signMessage({ message: assistantConnectMessage({ ...fields, owner: owner.address }) });
    expect(await recoverMessageAddress({ message: assistantConnectMessage({ ...fields, owner: owner.address }), signature })).toBe(owner.address);
  });

  it('names the connection it cuts', () => {
    expect(assistantDisconnectMessage({ ...fields, connection: 'c0ffee' })).toContain('Connection: c0ffee');
  });

  it('refuses a nonce, a time or a label it cannot carry', () => {
    expect(() => assistantConnectMessage({ ...fields, nonce: '0x12' })).toThrow(/sixteen bytes/u);
    expect(() => assistantConnectMessage({ ...fields, issuedAt: '2026-10-10 11:59' })).toThrow(/ISO 8601/u);
    expect(() => checkAssistantLabel('x'.repeat(ASSISTANT_LABEL_MAX_CHARS + 1))).toThrow(/at most/u);
    expect(() => checkAssistantLabel('two\nlines')).toThrow(/one line/u);
    expect(checkAssistantLabel('  ChatGPT  ')).toBe('ChatGPT');
  });
});
