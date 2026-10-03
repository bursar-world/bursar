export const OUTFLOW_ALERT_BPS: bigint;
export const OUTFLOW_ALERT_FLOOR_UNITS: bigint;
export const STATE_VERSION: 1;

export type MonitorBalance = {
  /** Atomic units, as a decimal string. */
  readonly value: string;
  readonly decimals: number;
  readonly symbol: string;
};

export type MonitorState = {
  readonly version: 1;
  /** When the run read the chain, as an ISO instant. */
  readonly at: string;
  readonly block: string;
  readonly balances: Readonly<Record<string, MonitorBalance>>;
};

export function outflow(previous: bigint, current: bigint, decimals: number): bigint | null;
export function readState(path: string): MonitorState | null;
export function writeState(path: string, state: MonitorState): void;
