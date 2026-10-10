import type { EvmWalletProvider } from '@coinbase/agentkit';
import { describe, expect, it } from 'vitest';

import { bursarActionProvider } from '../src/index.js';
import { PAY, fakeSpecs } from './fake.js';
import type { Call } from './fake.js';

const wallet = {
  getAddress: () => '0x877c349EFb5926082C413833E8055F0991185c61',
  sendTransaction: async () => `0x${'b'.repeat(64)}`,
  waitForTransactionReceipt: async () => ({ transactionHash: `0x${'b'.repeat(64)}` }),
} as unknown as EvmWalletProvider;

describe('BursarActionProvider', () => {
  it('serves Robinhood Chain and nothing else', () => {
    const provider = bursarActionProvider({ toolset: fakeSpecs([]) });
    expect(provider.name).toBe('bursar');
    expect(provider.supportsNetwork({ protocolFamily: 'evm', chainId: '4663', networkId: 'robinhood-mainnet' })).toBe(true);
    expect(provider.supportsNetwork({ protocolFamily: 'evm', chainId: '8453' })).toBe(false);
    expect(provider.supportsNetwork({ protocolFamily: 'svm' })).toBe(false);
  });

  it('needs a mandate or a toolset', () => {
    expect(() => bursarActionProvider()).toThrow('needs a mandate address');
  });

  it('turns each spec into an action with a zod schema and the same name', () => {
    const actions = bursarActionProvider({ toolset: fakeSpecs([]) }).getActions(wallet);
    expect(actions.map((a) => a.name)).toEqual(['bursar_inspect', 'bursar_quote', 'bursar_pay', 'bursar_settlements']);
    const pay = actions[2]!;
    expect(pay.description).toBe('Fake pay.');
    expect(pay.schema.safeParse(PAY).success).toBe(true);
    expect(pay.schema.safeParse({ ...PAY, input: 'a koi' }).success).toBe(true);
    expect(pay.schema.safeParse({ ...PAY, amount: '0.25' }).success).toBe(false);
    expect(pay.schema.safeParse({ capability: 'gpu.render:1', amount: '250000' }).success).toBe(false);
  });

  it('invokes the tool with the model arguments and returns its answer', async () => {
    const calls: Call[] = [];
    const [inspect, , pay] = bursarActionProvider({ toolset: fakeSpecs(calls) }).getActions(wallet);
    expect(await inspect!.invoke({})).toBe('inspect answered');
    expect(await pay!.invoke({ ...PAY, input: 'a koi' })).toBe('pay answered');
    expect(calls).toEqual([
      { name: 'inspect', args: {} },
      { name: 'pay', args: { ...PAY, input: 'a koi' } },
    ]);
  });

  it('opens a toolset on the wallet signer when given a mandate', () => {
    const actions = bursarActionProvider({ mandate: '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c' }).getActions(wallet);
    expect(actions.map((a) => a.name)).toEqual(['bursar_inspect', 'bursar_quote', 'bursar_pay', 'bursar_settlements']);
  });
});
