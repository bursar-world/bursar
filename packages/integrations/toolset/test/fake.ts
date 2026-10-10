import { LockStatus, micro, usdg } from '@bursar/sdk';
import type { Decision, Lock, MandateStatus, PayRequest, PaymentReceipt, PreviewRequest } from '@bursar/sdk';
import type { Address, Hex } from 'viem';

import type { LockReader, MandateClient } from '../src/index.js';

export const MANDATE = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c' as Address;
export const PROVIDER = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374' as Address;
export const AGENT = '0x877c349EFb5926082C413833E8055F0991185c61' as Address;

const HOUR = 3_600_000;

export function fakeStatus(now = new Date('2026-10-10T12:00:00Z')): MandateStatus {
  const remaining = {
    perCall: usdg('2'),
    daily: usdg('6.52'),
    monthly: usdg('46.47'),
    dailyResetsAt: new Date(now.getTime() + 5 * HOUR),
    monthlyResetsAt: new Date(now.getTime() + 300 * HOUR),
  };
  const window = (cap: string, spent: string, kind: 0 | 1, resetsAt: Date) => ({
    kind,
    cap: usdg(cap),
    spent: usdg(spent),
    remaining: micro(usdg(cap) - usdg(spent)),
    duration: 86_400n,
    startsAt: now,
    resetsAt,
    epoch: 1n,
  });
  return {
    address: MANDATE,
    contractSet: 'v4',
    principal: AGENT,
    pendingPrincipal: '0x0000000000000000000000000000000000000000',
    agent: AGENT,
    escrow: '0x11e73B5632837355e250fC236cFC2Be03aD0845A',
    settlementAsset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    balance: usdg('2.43462'),
    paused: false,
    revoked: false,
    version: 1n,
    limits: {
      perCallCap: usdg('2'),
      dailyCap: usdg('10'),
      monthlyCap: usdg('50'),
      dailyWindow: 86_400n,
      monthlyWindow: 2_592_000n,
      approvalThreshold: usdg('1'),
      validFrom: 0n,
      validUntil: 0n,
      classMask: 7,
      totalCap: usdg('100'),
      lane: 0,
    },
    remaining,
    daily: window('10', '3.48', 0, remaining.dailyResetsAt),
    monthly: window('50', '3.53', 1, remaining.monthlyResetsAt),
    merchantGate: 0,
    merchantRoot: `0x${'0'.repeat(64)}`,
    documentHash: `0x${'0'.repeat(64)}`,
    nonce: 0n,
    total: { cap: usdg('100'), spent: usdg('3.53'), remaining: usdg('96.47') },
  };
}

export type FakeClient = MandateClient & {
  readonly previews: PreviewRequest[];
  readonly payments: PayRequest[];
  deny: ((request: PreviewRequest) => Partial<Decision> | undefined) | undefined;
  failPay: Error | undefined;
};

export function fakeClient(): FakeClient {
  const status = fakeStatus();
  let nextId = 41n;
  const client: FakeClient = {
    address: MANDATE,
    previews: [],
    payments: [],
    deny: undefined,
    failPay: undefined,
    status: async () => status,
    balance: async () => status.balance,
    preview: async (request) => {
      client.previews.push(request);
      const base = { reason: undefined, errorName: undefined, message: '', denial: undefined, remaining: status.remaining, daily: status.daily, monthly: status.monthly };
      const denied = client.deny?.(request);
      return denied ? { ...base, allowed: false, ...denied } : { ...base, allowed: true };
    },
    pay: async (request) => {
      client.payments.push(request);
      if (client.failPay) throw client.failPay;
      const escrowId = nextId++;
      const hash = `0x${escrowId.toString(16).padStart(64, 'a')}` as Hex;
      const receipt: PaymentReceipt = {
        escrowId,
        hash,
        explorer: `https://robinhoodchain.blockscout.com/tx/${hash}`,
        blockNumber: 100n,
        merchant: request.to,
        capability: request.capability,
        capabilityId: `0x${'1'.repeat(64)}`,
        amount: request.amount,
        inputCommit: `0x${'2'.repeat(64)}`,
        inputURI: '',
        deadline: new Date('2026-10-10T12:10:00Z'),
        spent: { daily: micro(status.daily.spent + request.amount), monthly: micro(status.monthly.spent + request.amount) },
        remaining: { ...status.remaining, daily: micro(status.remaining.daily - request.amount), monthly: micro(status.remaining.monthly - request.amount) },
      };
      return receipt;
    },
  };
  return client;
}

export function fakeLocks(): LockReader & { readonly locks: Map<bigint, Lock> } {
  const locks = new Map<bigint, Lock>();
  return {
    locks,
    terms: { minLock: usdg('0.01'), minTtl: 300n, maxTtl: 604_800n },
    get: async (id) =>
      locks.get(id) ?? {
        payer: '0x0000000000000000000000000000000000000000',
        payee: '0x0000000000000000000000000000000000000000',
        disputer: '0x0000000000000000000000000000000000000000',
        capabilityId: `0x${'0'.repeat(64)}`,
        inputCommit: `0x${'0'.repeat(64)}`,
        outputCommit: `0x${'0'.repeat(64)}`,
        inputURI: '',
        outputURI: '',
        amount: micro(0n),
        deadline: 0n,
        releasedAt: 0n,
        bond: micro(0n),
        disputedAt: 0n,
        status: LockStatus.None,
        counted: false,
      },
  };
}

export function lockFor(request: PayRequest, status: Lock['status'] = LockStatus.Locked): Lock {
  return {
    payer: MANDATE,
    payee: request.to,
    disputer: '0x0000000000000000000000000000000000000000',
    capabilityId: `0x${'1'.repeat(64)}`,
    inputCommit: `0x${'2'.repeat(64)}`,
    outputCommit: `0x${'0'.repeat(64)}`,
    inputURI: '',
    outputURI: '',
    amount: request.amount,
    deadline: 1_791_288_600n,
    releasedAt: status === LockStatus.Released ? 1_791_288_000n : 0n,
    bond: micro(0n),
    disputedAt: 0n,
    status,
    counted: true,
  };
}
