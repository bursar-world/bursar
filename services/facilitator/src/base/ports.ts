import type { Micro } from '@bursar/core';
import type { Address, Hex } from 'viem';

/**
 * What the Base lane needs from the two chains and the key, and nothing more.
 *
 * The float's key signs authorizations on Base and releases or cancels locks on Robinhood Chain,
 * and it is held by whatever implements these two ports. The lane itself never sees it, which is
 * what keeps every decision here testable with a double.
 */

export type TransferAuthorization = {
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hex;
};

export type BaseFloat = {
  readonly network: string;
  readonly asset: Address;
  readonly address: Address;
  /** The float's USDC balance, in the token's own atomic units. */
  balance(): Promise<bigint>;
  blockNumber(): Promise<bigint>;
  /** Whether USDC reports the authorization spent. The one fact that decides a settlement. */
  authorizationUsed(nonce: Hex): Promise<boolean>;
  /** The transaction that spent it, when the logs from `fromBlock` can be read. Null is not "unused". */
  authorizationTransaction(nonce: Hex, fromBlock: bigint): Promise<Hex | null>;
  /** Signs on the token's EIP-712 domain, read from the token and proved against its separator. */
  signAuthorization(authorization: TransferAuthorization): Promise<Hex>;
};

/** The payee's two moves on a lock, sent from the float's address on Robinhood Chain. */
export type LockWriter = {
  release(escrow: Address, id: bigint, outputCommit: Hex, outputURI: string): Promise<Hex>;
  cancel(escrow: Address, id: bigint): Promise<Hex>;
};

export type BasePaymentStatus = 'signed' | 'paid' | 'settled' | 'returned';

export type BasePayment = {
  readonly id: string;
  readonly chainId: number;
  readonly escrow: Address;
  readonly lockId: bigint;
  readonly lockTransaction: Hex;
  readonly mandate: Address;
  readonly float: Address;
  readonly network: string;
  readonly asset: Address;
  readonly payTo: Address;
  readonly resource: string;
  /** USDC paid to the service. */
  readonly amountMicro: Micro;
  /** USDG the mandate locked. */
  readonly lockMicro: Micro;
  readonly feeMicro: Micro;
  readonly nonce: Hex;
  readonly validBefore: bigint;
  readonly deadline: bigint;
  readonly signedBlock: bigint;
  readonly status: BasePaymentStatus;
  readonly reportedTransaction: Hex | null;
  readonly baseTransaction: Hex | null;
  readonly rhcTransaction: Hex | null;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
};

export type OpenPaymentInput = Omit<
  BasePayment,
  'id' | 'status' | 'reportedTransaction' | 'baseTransaction' | 'rhcTransaction' | 'createdAt' | 'closedAt'
>;

export type OpenResult =
  | { readonly opened: true; readonly payment: BasePayment }
  | { readonly opened: false; readonly reason: 'replay' | 'float'; readonly availableMicro: Micro };

export type BaseLedger = {
  /**
   * Writes the row for a signed authorization, or refuses without writing.
   *
   * The float check and the insert happen under one lock per float, so two pays racing for the last
   * of the float cannot both be promised it. `balance` is what the chain reported a moment ago.
   */
  open(input: OpenPaymentInput, float: { readonly balance: bigint; readonly minimumMicro: Micro }): Promise<OpenResult>;
  promised(float: Address): Promise<Micro>;
  find(id: string): Promise<BasePayment | null>;
  findLock(chainId: number, escrow: Address, lockId: bigint): Promise<BasePayment | null>;
  listOpen(limit: number): Promise<BasePayment[]>;
  listMandate(mandate: Address, limit: number): Promise<BasePayment[]>;
  report(id: string, transaction: Hex): Promise<void>;
  markPaid(id: string, baseTransaction: Hex | null): Promise<void>;
  close(id: string, status: 'settled' | 'returned', rhcTransaction: Hex): Promise<void>;
  /** Rows still open past their lock's deadline: money the lane can no longer settle on its own. */
  countStuck(nowSeconds: bigint): Promise<number>;
};
