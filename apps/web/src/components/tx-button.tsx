'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { isBursarError } from '@bursar/core';
import { SubmittedButUnconfirmedError, TransactionRevertedError, revertFrom } from '@bursar/sdk';
import type { Hex, ReplacementReason, TransactionReceipt } from 'viem';
import { useWaitForTransactionReceipt } from 'wagmi';

import { CHAIN_ID, RHC, explorerTx } from '../chain/rhc';
import { failureFrom } from '../lib/revert';
import type { WriteContext } from '../lib/revert';
import type { AnyState } from '../state';
import { useWalletAccount } from '../wallet/account';
import { SwitchNetworkButton } from '../wallet/switch-network';
import { onWrongChain } from '../wallet/write';
import { Button } from './button';
import type { ButtonTone } from './button';
import { ErrorSurface, isUserRejection } from './error-surface';
import { Modal } from './modal';

export type TxPhase = 'idle' | 'signing' | 'pending' | 'confirmed' | 'replaced' | 'failed';

/**
 * What the screen already knows about the call, handed to the classifier when it fails.
 *
 * `action` and `hash` are the button's to supply: it has the label and it is holding the hash. The
 * rest is the caller's, and it is the difference between "execution reverted" and "$40 of the $50
 * daily limit is left, and the window rolls in four hours". Without the mandate the classifier has
 * nothing to hang a denial on and falls back to the node's own sentence.
 */
export type TxContext = Omit<WriteContext, 'action' | 'hash'>;

/**
 * For a form whose action is a `TxButton`. Enter in any field presses the button and the button
 * owns the transaction from there, so the only thing left to do is keep the browser from
 * navigating away from the screen the reader is on.
 */
export function preventNavigation(event: FormEvent): void {
  event.preventDefault();
}

export type TxButtonProps = {
  readonly label: string;
  /** Sends the transaction and returns its hash. Everything after that is handled here. */
  readonly send: () => Promise<Hex>;
  readonly tone?: ButtonTone;
  readonly disabled?: boolean;
  /**
   * `submit` where this is the action of a form. Enter in any of that form's fields then fires the
   * button the same way a press does, which is the only way a keyboard reaches this control.
   */
  readonly type?: 'button' | 'submit';
  /** States that stand in the way. The button disables and names the one in the way. */
  readonly blockedBy?: readonly AnyState[];
  /** The mandate, the amount and the readings on screen, so a refusal names the limit behind it. */
  readonly context?: TxContext;
  readonly signingLabel?: string;
  readonly pendingLabel?: string;
  readonly confirmedLabel?: string;
  readonly onConfirmed?: (receipt: TransactionReceipt) => void;
  readonly onError?: (error: unknown) => void;
  /**
   * Every move between the six states. For a screen whose inputs are the transaction: it holds
   * them still while the call is in flight, so the button and the receipt it is waiting on are
   * never unmounted by an edit.
   */
  readonly onPhaseChange?: (phase: TxPhase) => void;
  /**
   * What happens once the reader has read the receipt, and the label on the control that does it.
   *
   * Almost every control in this product sits on a surface that changes the moment the new state is
   * read: a proposal leaves `executable`, a lock leaves `Locked`, a request leaves the exit queue.
   * Re-reading from inside `onConfirmed` therefore takes the confirmation off the screen in the
   * same breath as it arrives, and the reader is shown the next state with no evidence that their
   * own transaction is what produced it.
   *
   * So the rule is: `onConfirmed` records the receipt, `onContinue` moves the surface on. Give a
   * control `onContinue` and the confirmed state holds until somebody presses it.
   */
  readonly continueLabel?: string;
  readonly onContinue?: () => void;
  /**
   * Asks the reader to type this exact phrase before the transaction is sent. For an action that
   * cannot be taken back: revoking an agent, pausing a mandate, withdrawing the balance.
   */
  readonly confirmPhrase?: string;
  readonly confirmTitle?: string;
  readonly confirmDescription?: ReactNode;
};

/**
 * How long this screen waits for a receipt before it says so.
 *
 * wagmi passes no timeout to viem at all, which means a transaction the network dropped leaves
 * the wait pending for as long as the tab is open: a disabled button, a spinner, and nothing said.
 * A bounded wait that ends in a sentence is the whole difference.
 */
const RECEIPT_TIMEOUT_MS = 90_000;

const RECEIPT_RETRIES = 2;

/**
 * One button, six states.
 *
 * Signing is the wallet being open. Pending is a hash that exists and has not been mined. Confirmed
 * is a receipt. Collapsing those into one spinner leaves a reader who cancelled a signature and a
 * reader whose transaction is three blocks deep looking at exactly the same screen.
 *
 * Replaced is its own answer because it is common and it is not a failure of this product. A
 * speed-up in the wallet lands the same call under a different hash and counts as confirmed. A
 * cancel lands nothing at all, and a different call on the same nonce lands something else; both
 * come back from the node as a receipt for a transaction nobody here sent, and reporting either as
 * "done" would be a lie about money.
 *
 * A wallet on another network gets no button to press, only the way onto the right one. Every
 * write is pinned to the deployment chain as well, so a wallet that moves between this render and
 * the signature is refused before it opens.
 */
export function TxButton({
  label,
  send,
  tone = 'primary',
  disabled = false,
  type = 'button',
  blockedBy = [],
  context,
  signingLabel = 'Confirm in your wallet',
  pendingLabel = 'Sending',
  confirmedLabel = 'Done',
  onConfirmed,
  onError,
  onPhaseChange,
  continueLabel = 'Read it again',
  onContinue,
  confirmPhrase,
  confirmTitle,
  confirmDescription,
}: TxButtonProps) {
  const [phase, setPhase] = useState<TxPhase>('idle');
  const [hash, setHash] = useState<Hex | undefined>(undefined);
  const [landed, setLanded] = useState<Hex | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');
  const [replacedBy, setReplacedBy] = useState<ReplacementReason | undefined>(undefined);
  const account = useWalletAccount();

  // viem names the replacement when it sees one, which is the only reliable way to tell a speed-up
  // from a cancel or from a different call on the same nonce. It is held in a ref as well as in
  // state because the receipt can arrive in the same render the reason was set in.
  const replacement = useRef<ReplacementReason | undefined>(undefined);

  const receipt = useWaitForTransactionReceipt({
    hash,
    chainId: CHAIN_ID,
    timeout: RECEIPT_TIMEOUT_MS,
    onReplaced: (replaced) => {
      replacement.current = replaced.reason;
      setReplacedBy(replaced.reason);
    },
    query: {
      enabled: hash !== undefined,
      // A wait the endpoint dropped is worth repeating. A wait that ran out of time is not: it has
      // already waited, and a silent second pass doubles the time before anyone is told anything.
      retry: (attempt, caught) => attempt < RECEIPT_RETRIES && isEndpointFailure(caught),
    },
  });

  // The error the failed phase was entered on. Pressing "Check again" puts the phase back to
  // pending while the query still holds the error it just failed with, and without this the effect
  // would read that stale error and fail the button again before the refetch had made a request.
  const reported = useRef<unknown>(null);

  // The receipt arrives from a query, not from the send call, so the transition out of `pending`
  // belongs in an effect. Doing it during render would fire onConfirmed on every re-render that
  // happens to have a receipt in hand.
  useEffect(() => {
    if (phase !== 'pending' || hash === undefined) return;

    const mined = receipt.data;
    if (mined) {
      const swapped = !sameHash(mined.transactionHash, hash);
      setLanded(mined.transactionHash);

      const next = settledPhase({ swapped, reason: replacement.current, success: mined.status === 'success' });
      setPhase(next);
      if (next === 'confirmed') onConfirmed?.(mined);
      if (next === 'failed') setError(new TransactionRevertedError(label, mined.transactionHash));
      return;
    }

    const caught = receipt.error;
    if (!caught || caught === reported.current) return;

    reported.current = caught;
    const failure = isReceiptTimeout(caught)
      ? new SubmittedButUnconfirmedError(hash, RECEIPT_TIMEOUT_MS, caught)
      : failureFrom(caught, { ...context, action: label, hash });

    setPhase('failed');
    setError(failure);
    onError?.(failure);
  }, [receipt.data, receipt.error, phase, hash, label, context, onConfirmed, onError]);

  // Held in a ref so a parent passing a fresh arrow each render does not replay the phase.
  const phaseListener = useRef(onPhaseChange);
  phaseListener.current = onPhaseChange;
  useEffect(() => phaseListener.current?.(phase), [phase]);

  const run = useCallback(async () => {
    setError(null);
    setHash(undefined);
    setLanded(undefined);
    setReplacedBy(undefined);
    replacement.current = undefined;
    reported.current = null;
    setPhase('signing');
    try {
      const sent = await send();
      setHash(sent);
      setPhase('pending');
    } catch (caught) {
      if (isUserRejection(caught)) {
        setPhase('idle');
        setError(caught);
        onError?.(caught);
        return;
      }

      // `context` is what turns a refusal into the limit that caused it: the mandate, the amount
      // and the reading already on the screen. A button that supplies none still reports the
      // contract's own error rather than viem's sentence about calldata.
      const failure = failureFrom(caught, { ...context, action: label });
      setPhase('failed');
      setError(failure);
      onError?.(failure);
    }
  }, [send, onError, label, context]);

  const keepWaiting = () => {
    setError(null);
    setPhase('pending');
    void receipt.refetch();
  };

  const blocker = blockedBy.find((state) => state.level === 'blocked');
  const busy = phase === 'signing' || phase === 'pending';
  // A call already in flight keeps its own display: the receipt is read on the deployment chain
  // whatever the wallet has moved to since.
  const wrongChain = !busy && onWrongChain(account);
  // The call has landed and the next move belongs to the control beside it, so this one is done.
  const held = phase === 'confirmed' && onContinue !== undefined;

  // Pressing it clears this button as well as moving the surface on. A control whose parent does
  // not replace it would otherwise sit disabled under a stale confirmation for the rest of the
  // session.
  const moveOn = () => {
    setPhase('idle');
    setHash(undefined);
    setLanded(undefined);
    reported.current = null;
    onContinue?.();
  };
  const text = phase === 'signing' ? signingLabel : phase === 'pending' ? pendingLabel : phase === 'confirmed' ? confirmedLabel : label;
  const timedOut = isBursarError(error) && error.code === 'receipt_timeout';
  const shown = landed ?? hash;
  // Nothing on mainnet, where the explorer is permissioned. The sentence stands on its own and the
  // offer is dropped, because an invitation that answers 403 is worse than no invitation.
  const link = shown === undefined ? undefined : explorerTx(shown);

  const onClick = () => {
    if (wrongChain) return;
    if (confirmPhrase) {
      setTyped('');
      setAsking(true);
      return;
    }
    void run();
  };

  if (wrongChain) {
    return (
      // The switch is not the action it stands in for, so it never wears that action's warning colour.
      <SwitchNetworkButton
        tone={tone === 'destructive' ? 'primary' : tone}
        reason={`Your wallet is on another network. Switch to ${RHC.name}, then press "${label}" again.`}
      />
    );
  }

  return (
    <div className="space-y-2">
      {/* Once held, the confirmation and the next control say it all; a disabled copy of this one would only sit in the way. */}
      {!held && (
        <Button type={type} tone={tone} disabled={disabled || busy || blocker !== undefined} onClick={onClick} aria-busy={busy}>
          {busy && <Spinner />}
          {text}
        </Button>
      )}

      {blocker && (
        <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
          {blocker.headline} <span className="text-[color:var(--color-muted)]">{blocker.detail}</span>
        </p>
      )}

      {shown && phase !== 'confirmed' && phase !== 'replaced' && (
        <p className="text-detail text-[color:var(--color-muted)]">
          Sent.
          {link !== undefined && (
            <>
              {' '}
              <a href={link} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                Follow it on the explorer
              </a>
              .
            </>
          )}
        </p>
      )}

      {phase === 'confirmed' && shown && (
        <p className="text-detail" style={{ color: 'var(--color-state-ok)' }}>
          Confirmed.{' '}
          {landed && hash && !sameHash(landed, hash) && 'Your wallet resent it as a replacement, and that is what confirmed. '}
          {link !== undefined && (
            <>
              <a href={link} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                View the transaction
              </a>
              .
            </>
          )}
        </p>
      )}

      {held && (
        <Button tone="primary" onClick={moveOn}>
          {continueLabel}
        </Button>
      )}

      {phase === 'replaced' && (
        <p className="text-detail" style={{ color: 'var(--color-state-attention)' }}>
          {replacedBy === 'cancelled'
            ? 'Cancelled in your wallet before it confirmed, so nothing ran and nothing was paid. '
            : 'Your wallet replaced it with a different transaction, so this action did not run. Check the replacement before you try again. '}
          {link !== undefined && (
            <a href={link} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              See the replacement
            </a>
          )}
        </p>
      )}

      {error !== null && (
        <ErrorSurface
          error={error}
          action={label}
          onRetry={timedOut ? keepWaiting : () => void run()}
          retryLabel={timedOut ? 'Check again' : 'Try again'}
        />
      )}

      {confirmPhrase && (
        <Modal
          open={asking}
          onClose={() => setAsking(false)}
          title={confirmTitle ?? label}
          description={confirmDescription}
          footer={
            /*
              The way out of this dialog never reads "Cancel". The button beside it carries the
              label of the control that opened it, and on a governance proposal that label is
              "Cancel": two buttons reading the same word, one abandoning the dialog and one
              cancelling the proposal. "Go back" belongs to no action in this product, so the pair
              can never collide whatever the control is called.
            */
            <div className="flex justify-end gap-2">
              <Button tone="secondary" onClick={() => setAsking(false)}>
                Go back
              </Button>
              <Button
                // A typed word guards only actions with consequences, so its button always reads as one,
                // whatever tone the control that opened it carries on the page.
                tone="destructive"
                disabled={typed.trim() !== confirmPhrase}
                onClick={() => {
                  setAsking(false);
                  void run();
                }}
              >
                {label}
              </Button>
            </div>
          }
        >
          <label className="block text-detail">
            Type <span className="font-mono font-semibold">{confirmPhrase}</span> to continue.
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="mt-2 h-11 w-full border border-[color:var(--color-line)] bg-surface px-3.5 font-mono text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
            />
          </label>
        </Modal>
      )}
    </div>
  );
}

function sameHash(a: Hex, b: Hex): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Where a mined receipt leaves the button.
 *
 * A receipt under a different hash is the wallet's doing, and viem names which kind it saw. Only a
 * reprice is the same call landing: same target, same data, same value, a higher fee. `cancelled`
 * sent nothing to the target and `replaced` sent something else, and calling either one the
 * reader's call confirmed would be a lie about money. A different hash with no reason given is
 * treated the same way, since nothing says it was this call.
 */
export function settledPhase(mined: {
  readonly swapped: boolean;
  readonly reason: ReplacementReason | undefined;
  readonly success: boolean;
}): 'confirmed' | 'replaced' | 'failed' {
  if (mined.swapped && mined.reason !== 'repriced') return 'replaced';
  return mined.success ? 'confirmed' : 'failed';
}

const TIMEOUT_NAMES: ReadonlySet<string> = new Set(['WaitForTransactionReceiptTimeoutError']);

const ENDPOINT_NAMES: ReadonlySet<string> = new Set([
  'HttpRequestError',
  'InternalRpcError',
  'LimitExceededRpcError',
  'RpcRequestError',
  'SocketClosedError',
  'TimeoutError',
  'WebSocketRequestError',
]);

function isReceiptTimeout(error: unknown): boolean {
  return carriesName(error, TIMEOUT_NAMES);
}

/**
 * Whether sending the same request again could answer differently.
 *
 * A revert is decided, and repeating it only spends the reader's time before they are told what
 * the contract said. Everything else here is the endpoint talking, not the transaction: a socket
 * that closed, a rate limit, a pool with nothing left to fail over to.
 */
function isEndpointFailure(error: unknown): boolean {
  if (isReceiptTimeout(error) || revertFrom(error)) return false;
  if (isBursarError(error) && error.code.startsWith('rpc_')) return true;
  return carriesName(error, ENDPOINT_NAMES);
}

/** viem files the useful name anywhere down the cause chain, so the whole chain is read. */
function carriesName(error: unknown, names: ReadonlySet<string>, depth = 0): boolean {
  if (depth > 8 || typeof error !== 'object' || error === null) return false;
  const shaped = error as { name?: unknown; cause?: unknown };
  if (typeof shaped.name === 'string' && names.has(shaped.name)) return true;
  return shaped.cause !== undefined && carriesName(shaped.cause, names, depth + 1);
}

function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className="animate-spin" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
