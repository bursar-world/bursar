import { BursarError } from '@bursar/core';

/**
 * Thrown, not returned.
 *
 * A refusal that a payer can fix travels back as an `InvalidReason` in the verdict, because the
 * caller has to put it in an HTTP response. The errors here are configuration faults: the process
 * is pointed at the wrong chain, the wrong token, or a token whose EIP-712 domain is not what was
 * configured. None of those get better by retrying, and none of them belong in a 402 body.
 */
export class X402ConfigError extends BursarError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = 'X402ConfigError';
  }
}

/**
 * A signer failure that provably happened before anything was handed to a node.
 *
 * A send that throws is normally reported as a possible broadcast, because a node that accepted
 * the transaction and lost the response throws the same way. Some failures cannot have reached a
 * node at all, such as the fee estimate that prices the transaction, and reporting those as
 * possible broadcasts strands the payer's nonce claim until someone reconciles it by hand. A signer
 * throws this, or any error carrying `broadcast: false`, to say nothing was sent.
 */
export class SettlementNotSentError extends Error {
  readonly broadcast = false as const;

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'SettlementNotSentError';
  }
}

/** Whether a thrown value says, in the shape above, that nothing reached a node. */
export function isNotSent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { broadcast?: unknown }).broadcast === false;
}

/** The name and version a mismatching domain was assembled from, and where the version came from. */
export type AttemptedDomain = {
  readonly name: string;
  readonly version: string;
  /** False when the token did not answer `version()` and the version was supplied instead. */
  readonly versionPublished: boolean;
};

/**
 * The configured EIP-712 domain does not hash to the separator the token reports.
 *
 * A wrong domain does not fail loudly. It produces signatures that recover to some address nobody
 * controls, so every payment is refused as a bad signature and the cause looks like a client bug.
 * USDG reports name "Global Dollar" and publishes no version at all, so the version in play is
 * often one this process supplied. The message says which, because the fix differs: a published
 * version that does not reproduce the separator means the wrong token, and a supplied one that
 * does not means the wrong version.
 */
export class DomainMismatchError extends X402ConfigError {
  readonly asset: `0x${string}`;
  readonly computed: `0x${string}`;
  readonly onChain: `0x${string}`;
  readonly attempted: AttemptedDomain | undefined;

  constructor(
    asset: `0x${string}`,
    computed: `0x${string}`,
    onChain: `0x${string}`,
    attempted?: AttemptedDomain,
  ) {
    const from =
      attempted === undefined
        ? ''
        : `. The domain was built from name ${JSON.stringify(attempted.name)} and version ` +
          `${JSON.stringify(attempted.version)}, ` +
          (attempted.versionPublished
            ? 'both read from the token'
            : 'and the token publishes no version, so that one was supplied') +
          '. Nothing has been signed';
    super(
      'x402_domain_mismatch',
      `EIP-712 domain for ${asset} hashes to ${computed}, token reports ${onChain}${from}`,
      { asset, computed, onChain, ...(attempted === undefined ? {} : { attempted }) },
    );
    this.name = 'DomainMismatchError';
    this.asset = asset;
    this.computed = computed;
    this.onChain = onChain;
    this.attempted = attempted;
  }
}
