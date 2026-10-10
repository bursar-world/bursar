import { RunContext } from '@openai/agents';
import { describe, expect, it } from 'vitest';

import { bursarTools } from '../src/index.js';
import { PAY, fakeSpecs } from './fake.js';
import type { Call } from './fake.js';

describe('bursarTools', () => {
  it('wraps each spec as a strict function tool, optional arguments carried as nullable', () => {
    const tools = bursarTools(fakeSpecs([]));
    expect(tools.map((t) => t.name)).toEqual(['bursar_inspect', 'bursar_quote', 'bursar_pay', 'bursar_settlements']);
    expect(tools[2]?.type).toBe('function');
    expect(tools[2]?.strict).toBe(true);
    expect(tools[2]?.parameters).toEqual({
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'The provider.', pattern: '^0x[0-9a-fA-F]{40}$' },
        capability: { type: 'string', description: 'The capability.' },
        amount: { type: 'string', description: 'Micro-USD digits.', pattern: '^(?:0|[1-9][0-9]*)$' },
        input: { type: ['string', 'null'], description: 'The brief.' },
      },
      required: ['provider', 'capability', 'amount', 'input'],
      additionalProperties: false,
    });
  });

  it('runs the tool the way the agent loop does, with the model arguments as JSON', async () => {
    const calls: Call[] = [];
    const [inspect, quote, pay] = bursarTools(fakeSpecs(calls));
    const context = new RunContext();
    expect(await inspect!.invoke(context, '{}')).toBe('inspect answered');
    expect(await quote!.invoke(context, JSON.stringify(PAY))).toBe('quote answered');
    expect(await pay!.invoke(context, JSON.stringify({ ...PAY, input: null }))).toBe('pay answered');
    expect(calls).toEqual([
      { name: 'inspect', args: {} },
      { name: 'quote', args: PAY },
      { name: 'pay', args: PAY },
    ]);
  });
});
