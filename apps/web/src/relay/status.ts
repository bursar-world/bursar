/**
 * Where a Relay request stands, read from `GET /intents/status/v3`.
 *
 * Relay's eight words cover the deposit landing, the fill going out and the two ways it ends.
 * `unknown` is Relay not recognising the id yet, which a status asked for a second after the
 * quote can answer, and it is treated like waiting.
 */
export type RelayPhase = 'waiting' | 'depositing' | 'pending' | 'submitted' | 'delayed' | 'success' | 'refund' | 'failure' | 'unknown';

export type RelayStatus = {
  readonly phase: RelayPhase;
  /** The deposit on the source chain. */
  readonly inTxHashes: readonly string[];
  /** The fill on Robinhood Chain, or the refund on the source chain. */
  readonly txHashes: readonly string[];
  readonly failReason: string | undefined;
  readonly details: string | undefined;
  readonly updatedAt: number | undefined;
};

const PHASES: ReadonlySet<string> = new Set(['waiting', 'depositing', 'pending', 'submitted', 'delayed', 'success', 'refund', 'failure', 'unknown']);

export function parseStatus(body: unknown): RelayStatus {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const status = record['status'];
  const phase = typeof status === 'string' && PHASES.has(status) ? (status as RelayPhase) : 'unknown';

  return {
    phase,
    inTxHashes: strings(record['inTxHashes']),
    txHashes: strings(record['txHashes']),
    failReason: typeof record['failReason'] === 'string' ? record['failReason'] : undefined,
    details: typeof record['details'] === 'string' ? record['details'] : undefined,
    updatedAt: typeof record['updatedAt'] === 'number' ? record['updatedAt'] : undefined,
  };
}

/** The request has ended, one way or the other. Nothing further comes from polling it. */
export function isSettled(status: RelayStatus): boolean {
  return status.phase === 'success' || status.phase === 'refund' || status.phase === 'failure';
}

/** The deposit has been seen; the fill is Relay's to make. */
export function depositSeen(status: RelayStatus): boolean {
  return status.phase === 'depositing' || status.phase === 'pending' || status.phase === 'submitted' || status.phase === 'delayed';
}

/**
 * How long to wait before asking again, in milliseconds, or `false` to stop.
 *
 * A deposit that has landed fills in seconds, so the fill is watched closely. A deposit address
 * waiting on a transfer from an exchange can wait an hour, and is asked less often.
 */
export function nextPoll(status: RelayStatus | undefined): number | false {
  if (status === undefined) return 2_000;
  if (isSettled(status)) return false;
  return depositSeen(status) ? 2_000 : 4_000;
}

/** Why Relay could not finish, for the person whose funds it was carrying. */
export function failureLine(status: RelayStatus, sourceName: string): string {
  const refunded = status.phase === 'refund';
  const back = refunded ? ` The funds were returned on ${sourceName}.` : '';

  switch (status.failReason) {
    case 'SLIPPAGE':
      return `The price moved past what the quote allowed before Relay could fill it.${back}`;
    case 'DEPOSITED_AMOUNT_TOO_LOW_TO_FILL':
    case 'AMOUNT_TOO_LOW_TO_REFUND':
      return `The amount that arrived at Relay was too small to carry.${back}`;
    case 'SOLVER_CAPACITY_EXCEEDED':
    case 'SOLVER_BALANCE_TOO_LOW':
      return `Relay did not have the USDG on hand to fill this.${back}`;
    case 'INCORRECT_DEPOSIT_CURRENCY':
    case 'DEPOSIT_CHAIN_MISMATCH':
    case 'DEPOSIT_ADDRESS_MISMATCH':
      return `What reached Relay did not match the quote.${back}`;
    default:
      return refunded ? `Relay could not complete the transfer.${back}` : 'Relay could not complete the transfer.';
  }
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
