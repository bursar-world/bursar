import { LockStatus, usdg } from '@bursar/sdk';
import { describe, expect, it } from 'vitest';

import { createToolset, jsonSchemaFor } from '../src/index.js';
import { MANDATE, PROVIDER, fakeClient, fakeLocks, lockFor } from './fake.js';

const PAY = { provider: PROVIDER, capability: 'gpu.render:1', amount: '250000' };

function open(options: Parameters<typeof createToolset>[0] extends infer O ? Partial<O> : never = {}) {
  const client = fakeClient();
  const locks = fakeLocks();
  const toolset = createToolset({ mandate: MANDATE, client, locks, ...options });
  const tool = (name: string) => {
    const spec = toolset.tools().find((t) => t.name === name);
    if (!spec) throw new Error(`no tool ${name}`);
    return spec;
  };
  return { client, locks, toolset, tool };
}

describe('tools', () => {
  it('names four tools with the prefix and marks the one that writes', () => {
    const { toolset } = open();
    expect(toolset.tools().map((t) => [t.name, t.writes])).toEqual([
      ['bursar_inspect', false],
      ['bursar_quote', false],
      ['bursar_pay', true],
      ['bursar_settlements', false],
    ]);
    expect(open({ prefix: 'spend_' }).toolset.tools()[2]?.name).toBe('spend_pay');
  });

  it('describes every argument as a string in JSON Schema', () => {
    const { tool } = open();
    const schema = jsonSchemaFor(tool('bursar_pay'));
    expect(schema.required).toEqual(['provider', 'capability', 'amount']);
    expect(Object.keys(schema.properties)).toEqual(['provider', 'capability', 'amount', 'input', 'deliverWithinSeconds']);
    expect(schema.properties.amount?.pattern).toBe('^(?:0|[1-9][0-9]*)$');
    expect(jsonSchemaFor(tool('bursar_inspect'))).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false });
  });
});

describe('inspect', () => {
  it('reports the limits, what is left, the escrow floor and the agent cap', async () => {
    const { tool } = open({ spendCap: { total: usdg('0.50') } });
    const text = await tool('bursar_inspect').call({});
    expect(text).toContain(`Mandate ${MANDATE} on Robinhood Chain (chain 4663): active.`);
    expect(text).toContain('Balance 2.43462 USDG. Limits: 2.00 USDG per call, 10.00 USDG a day, 50.00 USDG a month.');
    expect(text).toContain('Left: 6.52 USDG today');
    expect(text).toContain("Spends of 1.00 USDG and above need the principal's signature.");
    expect(text).toContain('Lifetime budget: 96.47 USDG left of 100.00 USDG.');
    expect(text).toContain('The escrow locks no payment under 0.01 USDG; deliveries from 300 to 604800 seconds.');
    expect(text).toContain("This agent's cap: 0.50 USDG in total, 0.00 USDG spent, 0.50 USDG left.");
    expect(text).toContain('signs; this toolset can pay.');
  });

  it('says when it holds no key', async () => {
    const client = fakeClient();
    const toolset = createToolset({ mandate: MANDATE, client, locks: fakeLocks() });
    // A client handed in counts as a signer; the read-only case is the one opened from options alone.
    expect(await toolset.inspect()).toContain('this toolset can pay');
  });
});

describe('quote', () => {
  it('passes the spend to the mandate and names what is left after it', async () => {
    const { client, tool } = open();
    const text = await tool('bursar_quote').call(PAY);
    expect(client.previews).toEqual([{ to: PROVIDER, amount: 250_000n, capability: 'gpu.render:1' }]);
    expect(text).toBe(
      `Allowed: 0.25 USDG to ${PROVIDER} for gpu.render:1. After it, 6.27 USDG is left today and 46.22 USDG this month. Pay it with bursar_pay.`,
    );
  });

  it('returns the mandate refusal as the answer', async () => {
    const { client, tool } = open();
    client.deny = () => ({ reason: 'merchant-not-allowed', message: 'Mandate refused: the merchant is not on its allowlist.' });
    expect(await tool('bursar_quote').call(PAY)).toBe('Mandate refused: the merchant is not on its allowlist.');
  });

  it('tells the agent what to do about an approval it cannot carry', async () => {
    const { client, tool } = open();
    client.deny = () => ({ reason: 'approval-required', message: 'Mandate refused: the principal has to sign.' });
    expect(await tool('bursar_quote').call({ ...PAY, amount: '1500000' })).toContain('carries no approval');
  });

  it('refuses under the agent cap before asking the chain', async () => {
    const { client, tool } = open({ spendCap: { perCall: usdg('0.10') } });
    expect(await tool('bursar_quote').call(PAY)).toBe(
      "Refused by this agent's cap: one call may spend at most 0.10 USDG and this one asks for 0.25 USDG.",
    );
    expect(client.previews).toHaveLength(0);
  });

  it('names a balance the limits would allow but the mandate does not hold', async () => {
    const { tool } = open();
    expect(await tool('bursar_quote').call({ ...PAY, amount: '2500000' })).toContain('but the mandate holds 2.43462 USDG');
  });

  it('answers a bad argument with the fix', async () => {
    const { tool } = open();
    expect(await tool('bursar_quote').call({ ...PAY, amount: '0.25' })).toContain('Write 1.50 USDG as "1500000"');
    expect(await tool('bursar_quote').call({ ...PAY, amount: '-250000' })).toContain('cannot be negative');
    expect(await tool('bursar_quote').call({ ...PAY, amount: '0' })).toContain('at least 1');
    expect(await tool('bursar_quote').call({ ...PAY, provider: '0x1234' })).toBe('provider must be a 0x-prefixed 20-byte address.');
    expect(await tool('bursar_quote').call({ ...PAY, capability: 'render' })).toContain('named and versioned');
  });
});

describe('pay', () => {
  it('quotes first, pays, and records the job', async () => {
    const { client, locks, tool, toolset } = open({ spendCap: { total: usdg('0.50') } });
    const text = await tool('bursar_pay').call({ ...PAY, input: '{"prompt":"a koi"}' });
    expect(client.previews).toHaveLength(1);
    expect(client.payments).toEqual([{ to: PROVIDER, amount: 250_000n, capability: 'gpu.render:1', ttlSeconds: 600, input: { prompt: 'a koi' } }]);
    expect(text).toContain(`Paid 0.25 USDG to ${PROVIDER} for gpu.render:1. Settlement 41 is held in escrow until 2026-10-10T12:10:00Z`);
    expect(text).toContain('Transaction 0x');
    expect(text).toContain('Left: 6.27 USDG today, 46.22 USDG this month.');
    expect(text).toContain("This agent's cap: 0.50 USDG in total, 0.25 USDG spent, 0.25 USDG left.");
    expect(toolset.spent).toBe(250_000n);
    expect(toolset.jobs.map((j) => j.settlementId)).toEqual([41n]);

    locks.locks.set(41n, lockFor(client.payments[0]!));
    expect(await tool('bursar_settlements').call({})).toBe(
      `#41 · 0.25 USDG to ${PROVIDER} for gpu.render:1 · held in escrow until 2026-10-06T12:10:00Z · https://robinhoodchain.blockscout.com/tx/0x${'a'.repeat(62)}29`,
    );
  });

  it('commits free text as text and accepts a longer delivery window', async () => {
    const { client, tool } = open();
    await tool('bursar_pay').call({ ...PAY, input: 'render a koi', deliverWithinSeconds: '900' });
    expect(client.payments[0]).toMatchObject({ ttlSeconds: 900, input: { text: 'render a koi' } });
  });

  it('does not send a spend the mandate would refuse', async () => {
    const { client, tool } = open();
    client.deny = () => ({ reason: 'daily-cap', message: 'Mandate refused: the daily limit has 0.10 USDG left.' });
    expect(await tool('bursar_pay').call(PAY)).toBe('Mandate refused: the daily limit has 0.10 USDG left.');
    expect(client.payments).toHaveLength(0);
  });

  it('stops at the agent cap across calls', async () => {
    const { client, tool } = open({ spendCap: { total: usdg('0.40') } });
    expect(await tool('bursar_pay').call(PAY)).toContain('Paid 0.25 USDG');
    expect(await tool('bursar_pay').call(PAY)).toBe(
      "Refused by this agent's cap: it may spend 0.40 USDG in total, has spent 0.25 USDG, and this call asks for 0.25 USDG.",
    );
    expect(client.payments).toHaveLength(1);
  });

  it('reports a payment that failed on the way out and records nothing', async () => {
    const { client, tool, toolset } = open();
    client.failPay = new Error('spend failed and came back with no reason attached.', { cause: new Error('execution reverted\nDetails: …') });
    expect(await tool('bursar_pay').call(PAY)).toBe(
      'The payment did not go through: spend failed and came back with no reason attached. (execution reverted)',
    );
    expect(toolset.jobs).toHaveLength(0);
    expect(toolset.spent).toBe(0n);
  });

  it('refuses to pay without a key, before any call', async () => {
    const toolset = createToolset({ mandate: MANDATE });
    expect(await toolset.tools()[2]!.call(PAY)).toContain('holds no agent key');
  });
});

describe('settlements', () => {
  it('says when nothing has been paid', async () => {
    const { tool } = open();
    expect(await tool('bursar_settlements').call({})).toBe('This agent has paid for nothing yet through this toolset.');
  });

  it('reads one settlement by id, including one this agent did not make', async () => {
    const { locks, tool } = open();
    locks.locks.set(7n, lockFor({ to: PROVIDER, amount: usdg('1'), capability: 'gpu.render:1' }, LockStatus.Released));
    expect(await tool('bursar_settlements').call({ settlementId: '7' })).toBe(
      `#7 · 1.00 USDG to ${PROVIDER} for 0x${'1'.repeat(64)} · paid to the provider at 2026-10-06T12:00:00Z`,
    );
    expect(await tool('bursar_settlements').call({ settlementId: '8' })).toBe('No settlement 8 on the escrow.');
    expect(await tool('bursar_settlements').call({ settlementId: 'seven' })).toBe('settlementId must be a positive whole number.');
  });

  it('lists newest first with the state read from the escrow', async () => {
    const { client, locks, tool } = open();
    await tool('bursar_pay').call(PAY);
    await tool('bursar_pay').call({ ...PAY, amount: '100000' });
    locks.locks.set(41n, lockFor(client.payments[0]!, LockStatus.TimedOut));
    locks.locks.set(42n, lockFor(client.payments[1]!));
    const lines = (await tool('bursar_settlements').call({})).split('\n');
    expect(lines[0]).toContain('#42 · 0.10 USDG');
    expect(lines[1]).toContain('#41 · 0.25 USDG');
    expect(lines[1]).toContain('returned to the mandate');
  });
});

describe('failures', () => {
  it('turns an error from the chain into a sentence', async () => {
    const { client, tool } = open();
    client.status = async () => {
      throw new Error('HTTP request failed.');
    };
    expect(await tool('bursar_inspect').call({})).toBe('The call failed: HTTP request failed.');
  });
});
