import { RHC_MAINNET, createRhcClient, endowmentAbi, endowmentFactoryAbi, rwaDeployment } from '@bursar/core';
import type { EndowmentsDeployment } from '@bursar/core';
import { decodeFunctionData, encodeErrorResult, erc20Abi, getAddress, zeroAddress } from 'viem';
import type { Abi, Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { createEndowmentGateway } from '../src/endowment.js';
import type { EndowmentGateway } from '../src/endowment.js';
import { callTool, toolsFor } from '../src/tools.js';
import type { ToolContext } from '../src/tools.js';
import { ACCOUNT, Reverted, answer, createFakeNode, defaultState } from './node.js';
import type { Contracts, FakeNode } from './node.js';

const KEY: Hex = `0x${'11'.repeat(32)}`;
const FACTORY: Address = '0xb22Ff7d1f434C65feC0a0dcDA13Db65Db347C565';
const PAYING = getAddress('0x00000000000000000000000000000000000e0001');
const ELSEWHERE = getAddress('0x00000000000000000000000000000000000e0002');
const WAITING = getAddress('0x00000000000000000000000000000000000e0003');
const OTHER_MANDATE = getAddress('0x00000000000000000000000000000000000bbbb1');
const SPY: Address = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C';

const DEPLOYMENT: EndowmentsDeployment = {
  EndowmentFactory: FACTORY,
  PatronMark: '0xF269c1E8b1961D55FCBbc8ACC269c3BD21D9d1b9',
  IdentityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  feeBps: 500,
  fromBlock: 95_402_825,
};

function stateOf(mandate: Address, accepted: boolean) {
  return {
    agentId: 8756n,
    successorId: 0n,
    mandate,
    accepted,
    frozen: false,
    nav: 60_120_000n,
    navFresh: true,
    averageNav: 60_000_000n,
    drawPerYear: 2_400_000n,
    accrued: accepted ? 591_780n : 0n,
    cash: 591_000n,
    sleeveTarget: 591_780n,
    given: 60_000_000n,
    unattributed: 0n,
    earned: 0n,
    earnedToPrincipal: 0n,
    drawn: 0n,
    fees: 0n,
    patrons: 3n,
    snapshotsTaken: 1n,
    createdAt: 1_800_000_000n,
    lastDrawAt: accepted ? 1_800_000_000n : 0n,
    lastActive: accepted ? 1_800_000_000n : 0n,
    unacceptedSince: 1_800_000_000n,
    contributed: 60_000_000n,
    pending: 0n,
    everAccepted: accepted,
    underwater: false,
    lastSnapshotAt: 1_800_000_000n,
  };
}

function endowmentAt(mandate: Address, accepted: boolean, draw: () => bigint = () => 591_000n) {
  return new Map([
    answer(endowmentAbi as Abi, 'mandate', () => mandate),
    answer(endowmentAbi as Abi, 'state', () => stateOf(mandate, accepted)),
    answer(endowmentAbi as Abi, 'assets', () => [[SPY], [10_000]]),
    answer(endowmentAbi as Abi, 'draw', draw),
  ]);
}

function chain(draw?: () => bigint): Contracts {
  const all = [ELSEWHERE, PAYING];
  return new Map([
    [
      FACTORY.toLowerCase(),
      new Map([
        answer(endowmentFactoryAbi as Abi, 'count', () => BigInt(all.length)),
        answer(endowmentFactoryAbi as Abi, 'all', (args) => all[Number(args[0])]),
        answer(endowmentFactoryAbi as Abi, 'endowmentsOf', () => [WAITING]),
      ]),
    ],
    [PAYING.toLowerCase(), endowmentAt(ACCOUNT, true, draw)],
    [ELSEWHERE.toLowerCase(), endowmentAt(OTHER_MANDATE, true)],
    [WAITING.toLowerCase(), endowmentAt(zeroAddress, false)],
    [
      SPY.toLowerCase(),
      new Map([
        answer(erc20Abi as Abi, 'balanceOf', () => 640_554_959_594_479n),
        answer(erc20Abi as Abi, 'decimals', () => 18),
      ]),
    ],
  ]);
}

function gateway(node: FakeNode, options: { key?: Hex | null; agentId?: bigint | null } = {}): EndowmentGateway {
  const { client } = createRhcClient({
    chain: RHC_MAINNET,
    providers: [
      { name: 'primary', url: 'http://primary.test' },
      { name: 'fallback', url: 'http://fallback.test' },
    ],
    fetchFn: node.fetchFn,
  });
  const g = createEndowmentGateway({
    client,
    chain: RHC_MAINNET,
    account: ACCOUNT,
    key: options.key === undefined ? KEY : options.key,
    endowments: DEPLOYMENT,
    agentId: options.agentId ?? null,
    rwa: rwaDeployment(4663) ?? null,
  });
  if (g === null) throw new Error('no endowment factory');
  return g;
}

function context(endowment: EndowmentGateway): ToolContext {
  return {
    gateway: null,
    resolver: null,
    provider: null,
    endowment,
    secrets: [],
    canSign: { mandate: false, resolver: false, provider: false },
  };
}

describe('endowment tools', () => {
  it('finds the endowment paying this mandate and reads it in plain units', async () => {
    const node = createFakeNode(defaultState(), chain());

    const status = await gateway(node).status(null);

    expect(status.endowments.map((e) => e.endowment)).toEqual([PAYING]);
    const [paying] = status.endowments;
    expect(paying).toMatchObject({
      agentId: '8756',
      accepted: true,
      drawsIntoThisMandate: true,
      principal: { usdg: '60.12' },
      drawPerYear: { usdg: '2.40' },
      drawPerMonth: { usdg: '0.20' },
      availableNow: { micro: '591780' },
      protocolShareBps: 500,
      patrons: 3,
      quietAfter: '2027-07-14T08:00:00Z',
    });
    expect(paying?.holdings).toEqual([{ asset: SPY, symbol: 'SPY', weightBps: 10_000, shares: '0.000640554959594479' }]);
    expect(status.next).toContain('endowment_draw');
  });

  it('lists an endowment the owner has not accepted yet when the agent is named', async () => {
    const node = createFakeNode(defaultState(), chain());

    const status = await gateway(node, { agentId: 8756n }).status(null);

    expect(status.endowments.map((e) => e.endowment)).toEqual([WAITING, PAYING]);
    expect(status.endowments[0]).toMatchObject({ accepted: false, mandate: null, lastDrawAt: null, quietAfter: null });
  });

  it('reads one endowment when it is named', async () => {
    const node = createFakeNode(defaultState(), chain());

    const status = await gateway(node).status(ELSEWHERE);

    expect(status.endowments).toHaveLength(1);
    expect(status.endowments[0]).toMatchObject({ endowment: ELSEWHERE, drawsIntoThisMandate: false });
  });

  it('draws into this mandate with the agent key and reports what arrived and the fee', async () => {
    const node = createFakeNode(defaultState(), chain());

    const result = await gateway(node).draw(null);

    expect(node.transactions).toHaveLength(1);
    expect(node.transactions[0]?.to.toLowerCase()).toBe(PAYING.toLowerCase());
    expect(decodeFunctionData({ abi: endowmentAbi, data: node.transactions[0]!.data }).functionName).toBe('draw');
    expect(result).toMatchObject({ endowment: PAYING, amount: { micro: '561450' }, fee: { micro: '29550' } });
  });

  it('turns a refusal into a sentence and sends nothing', async () => {
    const nothing = encodeErrorResult({ abi: endowmentAbi, errorName: 'NothingToDraw' });
    const node = createFakeNode(
      defaultState(),
      chain(() => {
        throw new Reverted(nothing);
      }),
    );

    const result = await callTool(context(gateway(node)), 'endowment_draw', {});

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ error: 'endowment_refused' });
    expect(JSON.parse(result.text).message).toContain('Nothing has accrued since the last draw');
    expect(node.transactions).toHaveLength(0);
  });

  it('offers the draw only with a key held here', async () => {
    const node = createFakeNode(defaultState(), chain());

    expect(toolsFor(context(gateway(node))).map((t) => t.name)).toEqual(
      expect.arrayContaining(['endowment_status', 'endowment_draw']),
    );
    const readOnly = toolsFor(context(gateway(node, { key: null }))).map((t) => t.name);
    expect(readOnly).toContain('endowment_status');
    expect(readOnly).not.toContain('endowment_draw');
  });

  it('says plainly when no endowment pays this mandate', async () => {
    const node = createFakeNode(defaultState(), chain());

    const result = await callTool(context(gateway(node)), 'endowment_draw', { endowment: undefined });
    expect(result.isError).toBe(false);

    const empty = createFakeNode(
      defaultState(),
      new Map([[FACTORY.toLowerCase(), new Map([answer(endowmentFactoryAbi as Abi, 'count', () => 0n)])]]),
    );
    const refused = await callTool(context(gateway(empty)), 'endowment_draw', {});
    expect(JSON.parse(refused.text)).toMatchObject({ error: 'endowment_none' });
  });
});
