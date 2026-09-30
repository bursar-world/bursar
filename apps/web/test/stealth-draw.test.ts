import { deriveStealthKeys, planStealthMandate } from '@bursar/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { planFromDraw } from '@/chain/stealth';
import type { SavedDraw } from '@/chain/stealth';

const wallet = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const other = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

describe('planFromDraw', () => {
  it('gives back the same owner and agent, keys included, from the public half of a draw', async () => {
    const keys = deriveStealthKeys(await wallet.signMessage({ message: 'bursar viewing key' }));
    const plan = planStealthMandate(keys);
    const draw: SavedDraw = JSON.parse(JSON.stringify({ principal: plan.principal.announcement, agent: plan.agent.announcement }));

    const again = await planFromDraw(keys, draw);
    expect(again?.principal.address).toBe(plan.principal.address);
    expect(again?.principal.privateKey).toBe(plan.principal.privateKey);
    expect(again?.agent.address).toBe(plan.agent.address);
    expect(again?.agent.privateKey).toBe(plan.agent.privateKey);
  });

  it('refuses a draw another wallet made', async () => {
    const mine = deriveStealthKeys(await wallet.signMessage({ message: 'bursar viewing key' }));
    const theirs = deriveStealthKeys(await other.signMessage({ message: 'bursar viewing key' }));
    const plan = planStealthMandate(theirs);
    const draw: SavedDraw = { principal: plan.principal.announcement, agent: plan.agent.announcement };
    expect(await planFromDraw(mine, draw)).toBeUndefined();
  });
});
