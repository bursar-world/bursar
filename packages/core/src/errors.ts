/**
 * Every failure this package raises carries a stable `code` so a caller can branch on the cause
 * without matching on message text. Messages are written for a human reading a log line.
 */
export class BursarError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function isBursarError(value: unknown): value is BursarError {
  return value instanceof BursarError;
}

/**
 * The settlement asset's own controls, as the five words a refusal is allowed to use for them.
 *
 * These are the only refusals in the system that neither the payer, the payee nor any service can
 * clear, so a caller that reads one knows to stop retrying and take it to the token issuer. The
 * underwriter refuses with them, the x402 facilitator refuses with them, the SDK reads them back
 * and the console names the same five conditions on screen. One copy of the words is what keeps
 * those four agreeing: a sixth control would otherwise be a string typed out four times.
 *
 * `asset_paused` and the two freezes are the issuer saying no. The last two mean the issuer's
 * answer could not be established, which is never the same as a clear one, and they are apart
 * because different people fix them: a control the token routes to no facet is a shape change
 * somebody has to look at, a read that did not come back is worth retrying.
 */
export const ISSUER_REFUSAL = {
  assetPaused: 'asset_paused',
  payerFrozen: 'payer_frozen',
  payeeFrozen: 'payee_frozen',
  assetControlAbsent: 'asset_control_absent',
  assetControlUnreadable: 'asset_control_unreadable',
} as const;

export type IssuerRefusal = (typeof ISSUER_REFUSAL)[keyof typeof ISSUER_REFUSAL];
