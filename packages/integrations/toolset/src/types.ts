import type { Lock, Micro } from '@bursar/sdk';
import type { Address, Hex } from 'viem';

/** One argument of a tool. Every value is a string, so any framework can carry it unchanged. */
export type ToolParameter = {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  /** A regular expression the value has to match, as source text so any schema library can hold it. */
  readonly pattern?: string;
};

export type ToolArgs = Readonly<Record<string, string | null | undefined>>;

/** A tool as a framework sees it: a name, a description, string arguments, a string answer. */
export type ToolSpec = {
  readonly name: string;
  readonly description: string;
  readonly parameters: readonly ToolParameter[];
  /** True for the tool that sends a transaction. A framework that confirms writes can read it. */
  readonly writes: boolean;
  readonly call: (args: ToolArgs) => Promise<string>;
};

/** What one agent may spend through one toolset, on top of what the mandate allows. */
export type SpendCap = {
  /** The most one call may spend. */
  readonly perCall?: Micro;
  /** The most this agent may spend across every call it makes through this toolset. */
  readonly total?: Micro;
};

/** A payment this toolset made, as it was made. The escrow holds where it stands now. */
export type Job = {
  readonly settlementId: bigint;
  readonly provider: Address;
  readonly capability: string;
  readonly amount: Micro;
  readonly hash: Hex;
  readonly explorer: string;
  readonly deadline: Date;
  readonly paidAt: Date;
};

/** The part of `MandateAccountClient` the tools use, so a test can stand one in. */
export type MandateClient = {
  readonly address: Address;
  status(): Promise<import('@bursar/sdk').MandateStatus>;
  balance(): Promise<Micro>;
  preview(request: import('@bursar/sdk').PreviewRequest): Promise<import('@bursar/sdk').Decision>;
  pay(request: import('@bursar/sdk').PayRequest): Promise<import('@bursar/sdk').PaymentReceipt>;
};

/** The part of `EscrowClient` the tools use: the floor and bounds, and one lock by id. */
export type LockReader = {
  readonly terms: { readonly minLock: Micro; readonly minTtl: bigint; readonly maxTtl: bigint };
  get(id: bigint): Promise<Lock>;
};
