/** A gateway that records what the tools asked it for, so a suite can assert on intent alone. */
import type { Address, Hex } from 'viem';

import type {
  DisputeDetailView,
  DisputeReceiptView,
  BuyStockOrder,
  SellStockOrder,
  HireOrder,
  HireView,
  MandateGateway,
  MandateView,
  MoneyView,
  PayOrder,
  PayView,
  QuoteRequest,
  QuoteView,
  SettlementDetailView,
  SettlementsQuery,
  SettlementsView,
} from '../src/types.js';

export const PROVIDER: Address = '0x3333333333333333333333333333333333333333';
export const TX_HASH: Hex = `0x${'cd'.repeat(32)}`;
const CAPABILITY_ID: Hex = `0x${'11'.repeat(32)}`;

function amount(micro: string, usdg: string): MoneyView {
  return { micro, usdg };
}

export function mandateView(): MandateView {
  const window = {
    cap: amount('100000000', '100.00'),
    spent: amount('30000000', '30.00'),
    remaining: amount('70000000', '70.00'),
    windowSeconds: 86_400,
    startedAt: '2027-01-15T00:00:00Z',
    resetsAt: '2027-01-16T00:00:00Z',
    resetsInSeconds: 57_600,
  };

  return {
    account: '0x00000000000000000000000000000000000acc01',
    chainId: 4663,
    status: 'active',
    summary: '70.00 USDG left today.',
    principal: '0x1111111111111111111111111111111111111111',
    agent: '0x2222222222222222222222222222222222222222',
    version: '3',
    balance: amount('250000000', '250.00'),
    settlementAsset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    perCallCap: amount('25000000', '25.00'),
    approvalThreshold: amount('20000000', '20.00'),
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
      minLock: amount('10000', '0.01'),
      disputeBondBps: 500,
      feeBps: 50,
    },
    observedAt: '2027-01-15T08:00:00Z',
    blockNumber: '61540000',
  };
}

export function quoteView(): QuoteView {
  return {
    provider: PROVIDER,
    capability: 'search.web:1',
    capabilityId: CAPABILITY_ID,
    amount: amount('1000000', '1.00'),
    allowed: true,
    approvalRequired: false,
    funded: true,
    refusal: null,
    remaining: {
      perCall: amount('25000000', '25.00'),
      daily: amount('70000000', '70.00'),
      monthly: amount('600000000', '600.00'),
      balance: amount('250000000', '250.00'),
    },
    next: 'Pay it with mandate_pay_provider.',
    observedAt: '2027-01-15T08:00:00Z',
  };
}

export function payView(): PayView {
  return {
    settlementId: '42',
    txHash: TX_HASH,
    provider: PROVIDER,
    capability: 'search.web:1',
    capabilityId: CAPABILITY_ID,
    amount: amount('1000000', '1.00'),
    inputCommit: `0x${'22'.repeat(32)}`,
    inputURI: 'data:application/json;base64,eyJjaXR5IjoiUGFyaXMifQ==',
    deliverBy: '2027-01-15T08:05:00Z',
    status: 'held',
    next: 'Read settlement 42.',
  };
}

export function settlementsView(): SettlementsView {
  return {
    settlements: [
      {
        settlementId: '42',
        provider: PROVIDER,
        capabilityId: CAPABILITY_ID,
        amount: amount('1000000', '1.00'),
        status: 'held',
        funds: 'Held by the escrow.',
        deliverBy: '2027-01-15T08:05:00Z',
        paidAtBlock: '61539900',
        txHash: TX_HASH,
      },
    ],
    scannedFromBlock: '61539000',
    scannedToBlock: '61540000',
    cursor: null,
    observedAt: '2027-01-15T08:00:00Z',
  };
}

export function settlementView(): SettlementDetailView {
  return {
    settlementId: '42',
    provider: PROVIDER,
    payer: '0x00000000000000000000000000000000000acc01',
    capabilityId: CAPABILITY_ID,
    amount: amount('1000000', '1.00'),
    status: 'held',
    funds: 'Held by the escrow.',
    deliverBy: '2027-01-15T08:05:00Z',
    inputCommit: `0x${'22'.repeat(32)}`,
    inputURI: 'data:application/json;base64,eyJjaXR5IjoiUGFyaXMifQ==',
    outputCommit: null,
    outputURI: null,
    deliveredAt: null,
    disputableUntil: null,
    refundableFrom: '2027-01-15T08:05:00Z',
    refundableToMandate: amount('1000000', '1.00'),
    dispute: null,
    next: 'Waiting on the provider.',
    observedAt: '2027-01-15T08:00:00Z',
  };
}

export function disputeReceiptView(): DisputeReceiptView {
  return { settlementId: '42', txHash: TX_HASH, status: 'disputed', next: 'The resolver rules on the split.' };
}

export function hireView(): HireView {
  return {
    ...payView(),
    jobId: '42',
    task: 'Summarize the filing',
    specCommit: `0x${'33'.repeat(32)}`,
    next: 'The escrow holds 1.00 USDG against this brief.',
  };
}

export function disputeDetailView(): DisputeDetailView {
  return {
    settlementId: '42',
    disputeId: '4',
    phase: 'committing',
    openedAt: '2027-01-15T08:10:00Z',
    openedBy: '0x00000000000000000000000000000000000acc01',
    bond: amount('50000', '0.05'),
    amount: amount('1000000', '1.00'),
    provider: PROVIDER,
    recordOnly: false,
    commitEndsAt: '2027-01-15T14:10:00Z',
    revealEndsAt: '2027-01-15T20:10:00Z',
    commitCount: 1,
    revealCount: 0,
    quorum: 2,
    resolveBy: '2027-01-15T20:10:00Z',
    ruling: null,
    settlementStatus: 'disputed',
    next: 'Resolvers are sealing their scores.',
    observedAt: '2027-01-15T08:00:00Z',
  };
}

export type FakeGateway = {
  gateway: MandateGateway;
  quotes: QuoteRequest[];
  orders: PayOrder[];
  hires: HireOrder[];
  buys: BuyStockOrder[];
  sells: SellStockOrder[];
  queries: SettlementsQuery[];
  reads: bigint[];
  disputes: bigint[];
  rulings: bigint[];
};

export type FakeGatewayOptions = {
  /** Thrown by every call, so a suite can drive the failure and redaction paths. */
  failure?: unknown;
};

export function createFakeGateway(options: FakeGatewayOptions = {}): FakeGateway {
  const quotes: QuoteRequest[] = [];
  const orders: PayOrder[] = [];
  const hires: HireOrder[] = [];
  const buys: BuyStockOrder[] = [];
  const sells: SellStockOrder[] = [];
  const queries: SettlementsQuery[] = [];
  const reads: bigint[] = [];
  const disputes: bigint[] = [];
  const rulings: bigint[] = [];

  const check = (): void => {
    if (options.failure !== undefined) throw options.failure;
  };

  const gateway: MandateGateway = {
    async inspect() {
      check();

      return mandateView();
    },
    async quote(request) {
      quotes.push(request);
      check();

      return quoteView();
    },
    async pay(order) {
      orders.push(order);
      check();

      return payView();
    },
    async hire(order) {
      hires.push(order);
      check();

      return hireView();
    },
    async buyStock(order) {
      buys.push(order);
      check();

      return {
        txHash: `0x${'ab'.repeat(32)}`,
        asset: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
        symbol: 'SPY',
        amount: { micro: order.amount.toString(), usdg: '0.05' },
        received: '64961527959563',
        referencePrice: '771.21',
        valueAtReference: { micro: '50099', usdg: '0.050099' },
        next: 'The mandate now holds SPY.',
      };
    },
    async sellStock(order) {
      sells.push(order);
      check();

      return {
        txHash: `0x${'ab'.repeat(32)}`,
        asset: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
        symbol: 'SPY',
        sold: order.raw === null ? '640554959594479' : order.raw.toString(),
        proceeds: { micro: '499374', usdg: '0.499374' },
        floor: { micro: '494672', usdg: '0.494672' },
        referencePrice: '780.06',
        next: 'The mandate holds the USDG again.',
      };
    },
    async settlements(query) {
      queries.push(query);
      check();

      return settlementsView();
    },
    async settlement(id) {
      reads.push(id);
      check();

      return settlementView();
    },
    async openDispute(id) {
      disputes.push(id);
      check();

      return disputeReceiptView();
    },
    async dispute(id) {
      rulings.push(id);
      check();

      return disputeDetailView();
    },
  };

  return { gateway, quotes, orders, hires, buys, sells, queries, reads, disputes, rulings };
}
