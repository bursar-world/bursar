import { RHC_MAINNET, createRhcClient } from '@bursar/core';
import type { Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';

import { createProviderGateway } from '../src/provider.js';
import type { ProviderRequest, RoleRelay } from '../src/relay.js';
import type { ProviderGateway } from '../src/types.js';
import { AGENT_REGISTRY, PROVIDER, REPUTATION, createFakeNode, defaultState } from './node.js';
import type { FakeNode, NodeState } from './node.js';

const TX: Hex = `0x${'cd'.repeat(32)}`;

function relayDouble(): RoleRelay & { sent: ProviderRequest[] } {
  const sent: ProviderRequest[] = [];

  return {
    sent,
    async providerCall(request) {
      sent.push(request);

      return { txHash: TX };
    },
    async resolverCall() {
      throw new Error('the provider gateway must not reach the resolver route');
    },
  };
}

function gatewayFor(
  node: FakeNode,
  relay: (RoleRelay & { sent: ProviderRequest[] }) | null = relayDouble(),
): ProviderGateway {
  const { client } = createRhcClient({
    chain: RHC_MAINNET,
    providers: [
      { name: 'primary', url: 'http://primary.test' },
      { name: 'fallback', url: 'http://fallback.test' },
    ],
    fetchFn: node.fetchFn,
  });

  return createProviderGateway({
    client,
    provider: PROVIDER,
    registry: AGENT_REGISTRY,
    reputation: REPUTATION,
    relay,
  });
}

describe('where a provider stands in the registry', () => {
  let state: NodeState;

  beforeEach(() => {
    state = defaultState();
  });

  it('reports the collateral posted and what one ruling could take from it', async () => {
    const view = await gatewayFor(createFakeNode(state)).status();

    expect(view.registered).toBe(true);
    expect(view.active).toBe(true);
    expect(view.name).toBe('render_farm');
    expect(view.stake).toEqual({ micro: '25000000', usdg: '25.00' });
    expect(view.minStake).toEqual({ micro: '5000000', usdg: '5.00' });
    expect(view.maxSlash).toEqual({ micro: '2500000', usdg: '2.50' });
    expect(view.withdrawal).toBeNull();
    expect(view.withdrawalDelaySeconds).toBe(604_800);
    expect(view.next).toContain('25.00 USDG of collateral posted');
    expect(view.next).toContain('2.50 USDG of it at risk');
  });

  it('tells an unlisted address what listing costs and that the collateral is at risk', async () => {
    state.registry.registered = false;
    state.registry.active = false;
    state.registry.agent = { name: '', stake: 0n, registeredAt: 0n, active: false };

    const view = await gatewayFor(createFakeNode(state)).status();

    expect(view.next).toContain('provider_register');
    expect(view.next).toContain('at least 5.00 USDG of collateral');
    expect(view.next).toContain('at risk');
    expect(view.next).not.toMatch(/yield|interest|earns/iu);
  });

  it('says a deactivated provider still has its collateral posted and slashable', async () => {
    state.registry.agent.active = false;
    state.registry.active = false;

    expect((await gatewayFor(createFakeNode(state)).status()).next).toContain(
      'still posted and still slashable',
    );
  });

  it('names when a withdrawal matures and that it stays slashable until it leaves', async () => {
    state.registry.withdrawal = [10_000_000n, 1_800_000_000n];

    const view = await gatewayFor(createFakeNode(state)).status();

    expect(view.withdrawal).toEqual({
      amount: { micro: '10000000', usdg: '10.00' },
      requestedAt: '2027-01-15T08:00:00Z',
      maturesAt: '2027-01-22T08:00:00Z',
      matured: false,
    });
    expect(view.next).toContain('stays slashable until it leaves');
  });

  it('says a matured withdrawal is ready, and what calls it off', async () => {
    state.registry.withdrawal = [10_000_000n, 1_799_000_000n];

    const view = await gatewayFor(createFakeNode(state)).status();

    expect(view.withdrawal?.matured).toBe(true);
    expect(view.next).toContain('provider_execute_withdrawal');
    expect(view.next).toContain('provider_cancel_withdrawal');
  });

  it('says a barred address is barred and who lifts it', async () => {
    state.registry.blacklisted = true;

    const view = await gatewayFor(createFakeNode(state)).status();

    expect(view.next).toContain('barred from the registry');
    expect(view.next).toContain("registry's admin");
  });
});

describe('the history a provider earns and the ceiling it buys', () => {
  let state: NodeState;

  beforeEach(() => {
    state = defaultState();
  });

  it('reports the score, the counts behind it and the ceiling on one payment', async () => {
    const view = await gatewayFor(createFakeNode(state)).reputation();

    expect(view.score).toBe(90);
    expect(view.released).toBe('9');
    expect(view.disputed).toBe('1');
    expect(view.settled).toBe('10');
    expect(view.cap).toEqual({ micro: '115000000', usdg: '115.00' });
    expect(view.maxCap).toEqual({ micro: '250000000', usdg: '250.00' });
    expect(view.next).toContain('90 of every 100 settled jobs');
    expect(view.next).toContain('115.00 USDG');
    expect(view.next).toContain('only counts once it is finalised');
  });

  it('says a new provider starts at the floor of the curve rather than at nothing', async () => {
    state.reputation.stats = [0n, 0n, 0n];
    state.reputation.score = 0;
    state.reputation.cap = 25_000_000n;

    const view = await gatewayFor(createFakeNode(state)).reputation();

    expect(view.settled).toBe('0');
    expect(view.next).toContain('No jobs have settled');
    expect(view.next).toContain('25.00 USDG');
  });
});

describe('the lifecycle a provider runs through', () => {
  it('sends each step to the signer as a named action, and says what it changed', async () => {
    const relay = relayDouble();
    const desk = gatewayFor(createFakeNode(), relay);

    await desk.register({ name: 'render_farm', stake: 25_000_000n as never });
    await desk.addStake(5_000_000n as never);
    await desk.requestWithdrawal(10_000_000n as never);
    await desk.cancelWithdrawal();
    await desk.executeWithdrawal();
    await desk.deactivate();
    await desk.reactivate();

    expect(relay.sent.map((entry) => entry.action)).toEqual([
      'register',
      'add-stake',
      'request-withdrawal',
      'cancel-withdrawal',
      'execute-withdrawal',
      'deactivate',
      'reactivate',
    ]);
    expect(relay.sent.every((entry) => entry.provider === PROVIDER)).toBe(true);
  });

  /** The registry refuses a handle carrying invisible characters, and so does this, for free. */
  it('refuses a name the registry would reject, before it costs a transaction', async () => {
    const relay = relayDouble();
    const desk = gatewayFor(createFakeNode(), relay);

    await expect(desk.register({ name: 'ok', stake: 25_000_000n as never })).rejects.toThrow(
      /letters, digits and underscore/u,
    );
    await expect(desk.register({ name: 'rend\u202Eer', stake: 25_000_000n as never })).rejects.toThrow(
      /invisible characters/u,
    );
    expect(relay.sent).toHaveLength(0);
  });

  it('says adding collateral also calls off a withdrawal that was waiting', async () => {
    const view = await gatewayFor(createFakeNode()).addStake(5_000_000n as never);

    expect(view.next).toContain('called off');
    expect(view.next).toContain('contradictory');
  });

  it('says deactivating is a closed sign rather than an exit', async () => {
    const view = await gatewayFor(createFakeNode()).deactivate();

    expect(view.next).toContain('Work already paid for is unaffected');
    expect(view.next).toContain('closed sign, not an exit');
  });

  it('refuses to send anything when this server has no signer', async () => {
    await expect(gatewayFor(createFakeNode(), null).deactivate()).rejects.toThrow(
      /reading the registry only/u,
    );
  });

  it('still answers the reads when this server has no signer', async () => {
    expect((await gatewayFor(createFakeNode(), null).status()).active).toBe(true);
  });
});
