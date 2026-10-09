import { RHC_MAINNET, micro } from '@bursar/core';
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';

import { callGates, transferGates } from '@/app/(app)/console/lib/write-gates';
import type { AssetRead, ChainSnapshot } from '@/chain/reader';
import type { ProviderHealth } from '@/chain/client';
import {
  evaluateAsset,
  evaluateConnectivity,
  evaluateFunding,
  evaluateMandate,
  evaluatePermission,
} from '@/state/evaluate';
import type { AnyState, SystemState } from '@/state';

/**
 * Which of the five conditions stands in the way of which write.
 *
 * The console used to gate every transaction on the same pair, connectivity and the settlement
 * asset, which reads as thorough and is wrong twice over. A paused token stops a deposit and it
 * does not stop a pause: fees are paid in ETH, the asset state's own copy says the switch still
 * confirms, and disabling it would take the control away from an owner at the exact moment the
 * token being down is why they want it. A blocked address is the same mistake with a different
 * cause.
 *
 * So the split is by what the call moves, and it is one function each, tested here against the
 * real evaluators rather than a hand-written state.
 */
const USDG = RHC_MAINNET.usdg as Address;
const OWNER = '0x2222222222222222222222222222222222222222' as Address;
const NOW = new Date('2026-09-23T12:00:00.000Z');

function asset(over: Partial<AssetRead> = {}): AssetRead {
  return {
    token: USDG,
    symbol: 'USDG',
    decimals: 6,
    tokenPaused: false,
    controller: OWNER,
    blocked: {},
    incomplete: false,
    ...over,
  };
}

function snapshot(assetRead: AssetRead): ChainSnapshot {
  return {
    blockNumber: 69_600_000n,
    chainTime: NOW,
    readAt: NOW,
    calls: 12,
    failures: 0,
    mandate: undefined,
    asset: assetRead,
    permission: undefined,
    funding: { mandateBalance: micro(0n), gasPayer: OWNER, gasBalance: undefined, principalBalance: undefined },
    provider: undefined,
    escrow: {
      address: '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4' as Address,
      feeBps: 100,
      minTtl: 300n,
      maxTtl: 604_800n,
      disputeWindow: 3_600n,
      disputeBondBps: 500,
      resolverFeeBps: 50,
      treasury: OWNER,
      minLock: undefined,
      owed: undefined,
      paused: false,
    },
    governance: { timelock: '0x5a32Eab02454f97a39857E85b536F83EE0f844Bf' as Address, period: 172_800n },
  };
}

function endpoint(name: string, latencyMs: number): ProviderHealth {
  return {
    name,
    url: `https://${name}.example`,
    reachable: true,
    chainId: 4663,
    blockNumber: 69_600_000n,
    latencyMs,
    problem: null,
    breaker: 'closed',
    throttled: 0,
    failures: 0,
  };
}

const HEALTHY: readonly ProviderHealth[] = [endpoint('primary', 40), endpoint('fallback', 90)];

const DOWN: readonly ProviderHealth[] = HEALTHY.map((provider) => ({
  ...provider,
  reachable: false,
  blockNumber: null,
  problem: 'no answer',
}));

function system(assetRead: AssetRead, providers: readonly ProviderHealth[]): SystemState {
  const read = snapshot(assetRead);
  const states = {
    asset: evaluateAsset(read, NOW, false),
    mandate: evaluateMandate(read, NOW, false, undefined),
    permission: evaluatePermission(read, NOW, false),
    funding: evaluateFunding(read, NOW, false),
    connectivity: evaluateConnectivity(providers, 4663, read.blockNumber, NOW, false),
  };
  const all: readonly AnyState[] = [states.connectivity, states.asset, states.mandate, states.permission, states.funding];

  return {
    ...states,
    all,
    blockers: all.filter((state) => state.level === 'blocked'),
    snapshot: read,
    assetRead,
    isLoading: false,
    isFetching: false,
    error: null,
    refresh: () => undefined,
  };
}

const BLOCKED = '0x9999999999999999999999999999999999999999';

const PAUSED_TOKEN = system(asset({ tokenPaused: true }), HEALTHY);
const BLOCKED_ADDRESS = system(asset({ blocked: { [BLOCKED]: true } }), HEALTHY);
const CLEAR = system(asset(), HEALTHY);
const UNREACHABLE = system(asset(), DOWN);

function stopped(gates: readonly AnyState[]): readonly string[] {
  return gates.filter((state) => state.level === 'blocked').map((state) => state.key);
}

describe('a write that moves no USDG', () => {
  it('is not stopped by a paused token, which is when an owner most wants to pause', () => {
    expect(stopped(callGates(PAUSED_TOKEN))).toEqual([]);
  });

  it('is not stopped by an address the issuer blocked', () => {
    expect(stopped(callGates(BLOCKED_ADDRESS))).toEqual([]);
  });

  it('is stopped when no endpoint answers, because nothing can be sent at all', () => {
    expect(stopped(callGates(UNREACHABLE))).toEqual(['connectivity']);
  });

  it('never carries the asset among the conditions it reports', () => {
    expect(callGates(PAUSED_TOKEN).map((state) => state.key)).toEqual(['connectivity']);
  });
});

describe('a write that moves USDG', () => {
  it('is stopped by a paused token, because the transfer inside it reverts', () => {
    expect(stopped(transferGates(PAUSED_TOKEN))).toEqual(['asset']);
  });

  it('is stopped by an address the issuer blocked', () => {
    expect(stopped(transferGates(BLOCKED_ADDRESS))).toEqual(['asset']);
  });

  it('is stopped by both when both are down, and names them separately', () => {
    expect(stopped(transferGates(system(asset({ tokenPaused: true }), DOWN)))).toEqual(['connectivity', 'asset']);
  });
});

describe('neither gate invents a verdict', () => {
  it('reports nothing in the way when nothing is', () => {
    expect(stopped(callGates(CLEAR))).toEqual([]);
    expect(stopped(transferGates(CLEAR))).toEqual([]);
  });

  it('hands back the states themselves, so each keeps its own owner and next action', () => {
    const [assetState] = transferGates(PAUSED_TOKEN).filter((state) => state.key === 'asset');

    expect(assetState?.headline).toBe('USDG is paused.');
    expect(assetState?.nextAction?.owner).toBe('token-issuer');
  });
});
