import type { MandateGateway, MandateView, ToolContext } from '@bursar/mcp';
import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';

import type { ContextFactory } from '../../src/contexts.js';
import type { ChainReads } from '../../src/proof.js';

/** A mandate view that says which account it is for, which is all these tests read off it. */
export function viewOf(mandate: Address, agent: Address): MandateView {
  const window = {
    cap: { micro: '100000000', usdg: '100.00' },
    spent: { micro: '0', usdg: '0.00' },
    remaining: { micro: '100000000', usdg: '100.00' },
    windowSeconds: 86_400,
    startedAt: '2026-10-10T00:00:00Z',
    resetsAt: '2026-10-11T00:00:00Z',
    resetsInSeconds: 3_600,
  };
  return {
    account: getAddress(mandate),
    chainId: 4663,
    status: 'active',
    summary: '100.00 USDG left today.',
    principal: '0x1111111111111111111111111111111111111111',
    agent: getAddress(agent),
    version: '3',
    balance: { micro: '250000000', usdg: '250.00' },
    settlementAsset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    perCallCap: { micro: '25000000', usdg: '25.00' },
    approvalThreshold: { micro: '20000000', usdg: '20.00' },
    daily: window,
    monthly: { ...window, windowSeconds: 2_592_000 },
    validFrom: null,
    validUntil: null,
    providerGate: 'allowlist',
    providerRoster: null,
    documentHash: null,
    contractSet: 'v3',
    classes: ['service', 'hire'],
    totalCap: null,
    escrow: {
      address: '0x4aCAeAdAE9AEf21D23719aa2F3E45A9c7Eda1BD3',
      minTtlSeconds: 30,
      maxTtlSeconds: 604_800,
      disputeWindowSeconds: 3_600,
      minLock: { micro: '10000', usdg: '0.01' },
      disputeBondBps: 500,
      feeBps: 50,
    },
    observedAt: '2026-10-10T08:00:00Z',
    blockNumber: '61540000',
  };
}

const unused = (): never => {
  throw new Error('not exercised by this test');
};

export function fakeGateway(mandate: Address, agent: Address): MandateGateway {
  return {
    inspect: async () => viewOf(mandate, agent),
    quote: unused,
    pay: unused,
    hire: unused,
    buyStock: unused,
    settlements: unused,
    settlement: unused,
    openDispute: unused,
    dispute: unused,
  };
}

export type Built = { readonly mandate: Address; readonly key: Hex; readonly agent: Address };

/**
 * A context factory that records what it was asked to bind, and binds a fake gateway whose view
 * names the mandate and the agent the key signs as.
 */
export function fakeContexts(agentOf: (key: Hex) => Address, mandates: ReadonlySet<string>): ContextFactory & { readonly built: Built[] } {
  const built: Built[] = [];
  return {
    built,
    async check(mandate) {
      if (!mandates.has(mandate.toLowerCase())) throw new Error(`${mandate} is not a mandate in this test`);
    },
    async build(mandate, key) {
      const agent = agentOf(key);
      built.push({ mandate, key, agent });
      const context: ToolContext = {
        gateway: fakeGateway(mandate, agent),
        resolver: null,
        provider: null,
        secrets: [key],
        canSign: { mandate: true, resolver: false, provider: false },
      };
      return context;
    },
  };
}

export function fakeReads(principals: Record<string, Address>): ChainReads {
  return {
    async principalOf(mandate) {
      return principals[mandate.toLowerCase()] ?? null;
    },
  };
}
