import { encodeEvidence, signDeliveryEvidence } from '@bursar/sdk';
import type { Address, Hex, LocalAccount } from 'viem';

import type { FetchLike } from './executor.js';

/** What this sidecar delivered against a lock, as a resolver needs to see it. */
export type Delivered = {
  readonly id: bigint;
  readonly inputCommit: Hex;
  readonly outputCommit: Hex;
  readonly outputURI: string;
};

/** Sends signed delivery evidence. Throws `EvidenceRejected` for an answer no retry will change. */
export type EvidencePoster = (delivered: Delivered) => Promise<void>;

/**
 * The resolver refused the evidence, or there is nothing it could accept. Retrying sends the same
 * bytes to the same answer, so the watcher lets the lock go instead.
 */
export class EvidenceRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceRejected';
  }
}

export type EvidencePosterOptions = {
  readonly url: string;
  /** The payee's own key. Evidence counts only when the payee on the lock signed it. */
  readonly account: LocalAccount;
  readonly escrow: Address;
  readonly chainId: number;
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  /** Unix seconds, for the payee's own claim of when it delivered. Resolvers record it and do not score it. */
  readonly now?: () => bigint;
};

/**
 * Tells the resolvers what this payee delivered on a lock the payer froze before it could release.
 *
 * Without this the resolvers see a disputed lock with no output on chain, which reads exactly like
 * a job that was never done, and the ruling refunds the payer for work the provider did.
 */
export function createEvidencePoster(options: EvidencePosterOptions): EvidencePoster {
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1_000)));

  return async (delivered) => {
    // A commitment with nowhere to fetch it proves nothing to anyone: the resolver's whole check
    // is to hash the bytes it downloads.
    if (delivered.outputURI === '') {
      throw new EvidenceRejected(
        'The output has no public URI to point a resolver at. Set OUTPUT_BASE_URL so outputs too large to inline are published.',
      );
    }

    const submission = await signDeliveryEvidence(options.account, options.escrow, options.chainId, {
      escrowId: delivered.id,
      inputCommit: delivered.inputCommit,
      outputCommit: delivered.outputCommit,
      outputURI: delivered.outputURI,
      deliveredAt: now(),
    });

    const response = await options.fetch(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(encodeEvidence(submission)),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (response.ok) return;

    const detail = await response.text().catch(() => '');
    const message = `The resolver answered ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 300)}`}`;
    // 4xx is the resolver saying no to these bytes; 408 and 429 are it saying not now.
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      throw new EvidenceRejected(message);
    }
    throw new Error(message);
  };
}
