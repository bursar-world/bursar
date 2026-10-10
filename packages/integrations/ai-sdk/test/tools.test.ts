import { describe, expect, it } from 'vitest';

import { bursarTools } from '../src/index.js';
import { PAY, fakeSpecs } from './fake.js';
import type { Call } from './fake.js';

const options = { toolCallId: 'call_1', messages: [], context: undefined };

describe('bursarTools', () => {
  it('keys each tool by name with its description and JSON schema', async () => {
    const tools = bursarTools(fakeSpecs([]));
    expect(Object.keys(tools)).toEqual(['bursar_inspect', 'bursar_quote', 'bursar_pay', 'bursar_settlements']);
    expect(tools.bursar_pay?.description).toBe('Fake pay.');
    const schema = tools.bursar_pay?.inputSchema as { jsonSchema: unknown };
    expect(await schema.jsonSchema).toMatchObject({
      type: 'object',
      required: ['provider', 'capability', 'amount'],
      properties: { input: { type: 'string', description: 'The brief.' } },
    });
  });

  it('executes with the model arguments and returns the answer', async () => {
    const calls: Call[] = [];
    const tools = bursarTools(fakeSpecs(calls));
    expect(await tools.bursar_inspect!.execute!({}, options)).toBe('inspect answered');
    expect(await tools.bursar_quote!.execute!(PAY, options)).toBe('quote answered');
    expect(await tools.bursar_settlements!.execute!({ settlementId: '41' }, options)).toBe('settlements answered');
    expect(calls).toEqual([
      { name: 'inspect', args: {} },
      { name: 'quote', args: PAY },
      { name: 'settlements', args: { settlementId: '41' } },
    ]);
  });
});
