import type { Bucket, Decision, RefuseReason } from './decision.js';
import type { Address } from './document.js';
import type { Divergence } from './reconcile.js';

/**
 * Which surface produced the answer. The chain is the only one that binds.
 *
 * `asset` is the settlement asset itself, and it is the one source here that belongs to nobody in
 * this system: a refusal carrying it is the token issuer's, not a term the principal or the
 * operator agreed to and not one either of them can change.
 */
export type DecisionSource = 'document' | 'account' | 'asset' | 'escrow' | 'simulation' | 'underwriter';

export type UnderwriterEvent =
  | {
      readonly type: 'decision';
      readonly requestId: string;
      readonly subject: string;
      readonly account: Address | null;
      readonly accountVersion: bigint | null;
      readonly decision: Decision;
      readonly source: DecisionSource;
      readonly bucket: Bucket | null;
      readonly entryHash: string;
      readonly root: string | null;
      readonly at: string;
    }
  | {
      readonly type: 'divergence';
      readonly requestId: string | null;
      readonly account: Address;
      readonly accountVersion: bigint;
      readonly divergence: Divergence;
    }
  | {
      readonly type: 'chain_unavailable';
      readonly requestId: string;
      readonly account: Address;
      readonly reason: RefuseReason;
      readonly detail: string;
    }
  | {
      readonly type: 'settlement';
      readonly requestId: string;
      readonly resolution: 'approve' | 'deny';
      readonly entryHash: string;
      readonly root: string | null;
      readonly at: string;
    };

export type EventSink = (event: UnderwriterEvent) => void;

/** A sink that throws must not turn an observation into a refusal, or a broken log tail stops payments. */
export function safeEmit(sink: EventSink | undefined, event: UnderwriterEvent): void {
  if (sink === undefined) return;
  try {
    sink(event);
  } catch {
    // Intentionally swallowed. Trust events are a record of what happened, not a precondition
    // for it, and the decision they describe has already been taken.
  }
}
