import { toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { domainSeparator } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { BaseFloat, BaseLedger, BasePayment, LockWriter, OpenPaymentInput, OpenResult, TransferAuthorization } from '../../src/base/ports.js';
import type { EscrowChain, EscrowLock } from '../../src/x402/escrow-lock.js';

/** Doubles for the Base lane's three collaborators: the float on Base, the lock writer, the ledger. */

export const FLOAT_KEY: Hex = `0x${'42'.repeat(32)}`;
export const FLOAT_ACCOUNT = privateKeyToAccount(FLOAT_KEY);
export const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_DOMAIN = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC } as const;
export const USDC_SEPARATOR = domainSeparator({ domain: USDC_DOMAIN });

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export class FakeFloat implements BaseFloat {
  readonly network = 'eip155:8453';
  readonly asset = USDC;
  readonly address = FLOAT_ACCOUNT.address;
  balanceMicro = 10_000_000n;
  block = 52_000_000n;
  readonly used = new Set<string>();
  readonly transactions = new Map<string, Hex>();
  readonly signed: TransferAuthorization[] = [];
  logsFail = false;

  async balance(): Promise<bigint> {
    return this.balanceMicro;
  }

  async blockNumber(): Promise<bigint> {
    return this.block;
  }

  async authorizationUsed(nonce: Hex): Promise<boolean> {
    return this.used.has(nonce.toLowerCase());
  }

  async authorizationTransaction(nonce: Hex): Promise<Hex | null> {
    if (this.logsFail) throw new Error('eth_getLogs refused');
    return this.transactions.get(nonce.toLowerCase()) ?? null;
  }

  async signAuthorization(authorization: TransferAuthorization): Promise<Hex> {
    this.signed.push(authorization);
    return FLOAT_ACCOUNT.signTypedData({
      domain: USDC_DOMAIN,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { ...authorization },
    });
  }
}

export class FakeLockWriter implements LockWriter {
  readonly released: { escrow: Address; id: bigint; outputCommit: Hex; outputURI: string }[] = [];
  readonly cancelled: { escrow: Address; id: bigint }[] = [];
  failReleases = 0;

  async release(escrow: Address, id: bigint, outputCommit: Hex, outputURI: string): Promise<Hex> {
    if (this.failReleases > 0) {
      this.failReleases -= 1;
      throw new Error('release reverted');
    }
    this.released.push({ escrow, id, outputCommit, outputURI });
    return `0x${'5e'.repeat(31)}${this.released.length.toString(16).padStart(2, '0')}`;
  }

  async cancel(escrow: Address, id: bigint): Promise<Hex> {
    this.cancelled.push({ escrow, id });
    return `0x${'ca'.repeat(31)}${this.cancelled.length.toString(16).padStart(2, '0')}`;
  }
}

/** The ledger in memory, with the same two rules the table enforces: one lock, one row; one float, one nonce. */
export class FakeBaseLedger implements BaseLedger {
  readonly rows: BasePayment[] = [];
  private next = 1;

  async open(input: OpenPaymentInput, float: { balance: bigint; minimumMicro: Micro }): Promise<OpenResult> {
    const promised = await this.promised(input.float);
    const available = toMicro(float.balance - promised);
    if (available - input.amountMicro < float.minimumMicro) return { opened: false, reason: 'float', availableMicro: available };
    if (this.rows.some((row) => row.chainId === input.chainId && same(row.escrow, input.escrow) && row.lockId === input.lockId)) {
      return { opened: false, reason: 'replay', availableMicro: available };
    }
    if (this.rows.some((row) => same(row.float, input.float) && same(row.nonce, input.nonce))) {
      return { opened: false, reason: 'replay', availableMicro: available };
    }
    const payment: BasePayment = {
      ...input,
      id: `00000000-0000-4000-8000-${String(this.next++).padStart(12, '0')}`,
      status: 'signed',
      reportedTransaction: null,
      baseTransaction: null,
      rhcTransaction: null,
      createdAt: new Date(),
      closedAt: null,
    };
    this.rows.push(payment);
    return { opened: true, payment };
  }

  async promised(float: Address): Promise<Micro> {
    return toMicro(this.rows.filter((row) => same(row.float, float) && row.status === 'signed').reduce((sum, row) => sum + row.amountMicro, 0n));
  }

  async find(id: string): Promise<BasePayment | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async findLock(chainId: number, escrow: Address, lockId: bigint): Promise<BasePayment | null> {
    return this.rows.find((row) => row.chainId === chainId && same(row.escrow, escrow) && row.lockId === lockId) ?? null;
  }

  async listOpen(limit: number): Promise<BasePayment[]> {
    return this.rows.filter((row) => row.status === 'signed' || row.status === 'paid').slice(0, limit);
  }

  async listMandate(mandate: Address, limit: number): Promise<BasePayment[]> {
    return this.rows.filter((row) => same(row.mandate, mandate)).slice(0, limit);
  }

  async report(id: string, transaction: Hex): Promise<void> {
    this.update(id, (row) => ({ ...row, reportedTransaction: row.reportedTransaction ?? transaction }));
  }

  async markPaid(id: string, baseTransaction: Hex | null): Promise<void> {
    this.update(id, (row) => (row.status === 'signed' ? { ...row, status: 'paid', baseTransaction: baseTransaction ?? row.baseTransaction } : row));
  }

  async close(id: string, status: 'settled' | 'returned', rhcTransaction: Hex): Promise<void> {
    this.update(id, (row) => (row.status === 'signed' || row.status === 'paid' ? { ...row, status, rhcTransaction, closedAt: new Date() } : row));
  }

  async countStuck(nowSeconds: bigint): Promise<number> {
    return this.rows.filter((row) => (row.status === 'signed' || row.status === 'paid') && row.deadline < nowSeconds).length;
  }

  private update(id: string, change: (row: BasePayment) => BasePayment): void {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows[index] = change(this.rows[index] as BasePayment);
  }
}

export type ScriptedEscrow = EscrowChain & {
  locks: Map<string, EscrowLock>;
  accounts: Map<string, { escrow: Address; principal: Address }>;
  created: Address[];
  openedIn: Map<string, bigint[]>;
  timestamp: bigint;
  fail: boolean;
};

export function scriptedEscrow(): ScriptedEscrow {
  const escrow: ScriptedEscrow = {
    locks: new Map(),
    accounts: new Map(),
    created: [],
    openedIn: new Map(),
    timestamp: 1_800_000_000n,
    fail: false,
    async lock(address, id) {
      if (escrow.fail) throw new Error('rpc down');
      return escrow.locks.get(`${address.toLowerCase()}:${id}`) ?? { payer: '0x0000000000000000000000000000000000000000', payee: '0x0000000000000000000000000000000000000000', capabilityId: `0x${'0'.repeat(64)}`, inputCommit: `0x${'0'.repeat(64)}`, inputURI: '', amount: 0n, deadline: 0n, status: 0 };
    },
    async mandate(account) {
      const found = escrow.accounts.get(account.toLowerCase());
      if (!found) throw new Error('not a mandate');
      return found;
    },
    async accountsOf() {
      return escrow.created;
    },
    async lockedIn(transaction) {
      return escrow.openedIn.get(transaction.toLowerCase()) ?? [];
    },
    async now() {
      return escrow.timestamp;
    },
  };
  return escrow;
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
