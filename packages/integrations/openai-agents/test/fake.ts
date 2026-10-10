import type { ToolArgs, ToolSpec } from '@bursar/toolset';

export type Call = { readonly name: string; readonly args: ToolArgs };

/** Four tools shaped like the real ones, recording every call and answering with a fixed line. */
export function fakeSpecs(calls: Call[]): ToolSpec[] {
  const spec = (name: string, parameters: ToolSpec['parameters'], writes = false): ToolSpec => ({
    name: `bursar_${name}`,
    description: `Fake ${name}.`,
    parameters,
    writes,
    call: async (args) => {
      calls.push({ name, args });
      return `${name} answered`;
    },
  });
  const provider = { name: 'provider', description: 'The provider.', required: true, pattern: '^0x[0-9a-fA-F]{40}$' };
  const capability = { name: 'capability', description: 'The capability.', required: true };
  const amount = { name: 'amount', description: 'Micro-USD digits.', required: true, pattern: '^(?:0|[1-9][0-9]*)$' };
  return [
    spec('inspect', []),
    spec('quote', [provider, capability, amount]),
    spec('pay', [provider, capability, amount, { name: 'input', description: 'The brief.', required: false }], true),
    spec('settlements', [{ name: 'settlementId', description: 'One id.', required: false, pattern: '^[1-9][0-9]*$' }]),
  ];
}

export const PAY = {
  provider: '0x5210D8df060A9D5ce4c1305045ED5c9548fca374',
  capability: 'gpu.render:1',
  amount: '250000',
};
