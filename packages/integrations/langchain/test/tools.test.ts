import { describe, expect, it } from 'vitest';

import { bursarTools } from '../src/index.js';
import { PAY, fakeSpecs } from './fake.js';
import type { Call } from './fake.js';

describe('bursarTools', () => {
  it('wraps each spec as a LangChain tool with its name, description and JSON schema', () => {
    const tools = bursarTools(fakeSpecs([]));
    expect(tools.map((t) => t.name)).toEqual(['bursar_inspect', 'bursar_quote', 'bursar_pay', 'bursar_settlements']);
    expect(tools[1]?.description).toBe('Fake quote.');
    expect(tools[1]?.schema).toMatchObject({
      type: 'object',
      required: ['provider', 'capability', 'amount'],
      properties: { amount: { type: 'string', pattern: '^(?:0|[1-9][0-9]*)$' } },
    });
  });

  it('passes the model arguments through and returns the answer', async () => {
    const calls: Call[] = [];
    const [inspect, quote, pay] = bursarTools(fakeSpecs(calls));
    expect(await inspect!.invoke({})).toBe('inspect answered');
    expect(await quote!.invoke(PAY)).toBe('quote answered');
    expect(await pay!.invoke({ ...PAY, input: 'a koi' })).toBe('pay answered');
    expect(calls).toEqual([
      { name: 'inspect', args: {} },
      { name: 'quote', args: PAY },
      { name: 'pay', args: { ...PAY, input: 'a koi' } },
    ]);
  });

  it('answers a tool call message the way an agent loop sends one', async () => {
    const calls: Call[] = [];
    const settlements = bursarTools(fakeSpecs(calls))[3]!;
    const message = (await settlements.invoke({
      name: 'bursar_settlements',
      args: { settlementId: '41' },
      id: 'call_1',
      type: 'tool_call',
    })) as unknown as { content: string };
    expect(message.content).toBe('settlements answered');
    expect(calls).toEqual([{ name: 'settlements', args: { settlementId: '41' } }]);
  });

  it('rejects an argument the schema refuses before the tool runs', async () => {
    const calls: Call[] = [];
    const quote = bursarTools(fakeSpecs(calls))[1]!;
    await expect(quote.invoke({ ...PAY, amount: '0.25' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
