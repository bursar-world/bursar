import type { ReactNode } from 'react';
import type { AnyState, Check, NextAction, SystemState } from '../state';
import { LevelBadge, LevelDot, levelWord } from './badge';
import { Button } from './button';
import { Instant } from './instant';
import { Card } from './layout';

/**
 * One of the five states, rendered whole: what it is, what it means, and what to do about it.
 *
 * These are never combined into a single indicator. Each has a different owner and a different
 * fix, and a treasurer whose payment failed needs to know which of the five it was.
 */
export function StatusRow({
  state,
  onRetry,
  children,
}: {
  readonly state: AnyState;
  /** Supplied where the reading can be taken again, which is what makes "Read again" a control. */
  readonly onRetry?: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex gap-3 border-b border-[color:var(--color-line)] py-4 first:pt-1 last:border-0 last:pb-1">
      <div className="pt-1.5">
        <LevelDot level={state.level} label={`${state.label}: ${levelWord(state.level)}`} />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-label uppercase tracking-wide text-[color:var(--color-muted)]">{state.label}</span>
          <span className="text-sm font-medium">{state.headline}</span>
          {state.stale && <span className="text-label text-[color:var(--color-muted)]">reading is out of date</span>}
        </div>
        <p className="text-detail text-[color:var(--color-muted)]">{state.detail}</p>
        {state.nextAction && <NextActionLine action={state.nextAction} onRetry={onRetry} />}
        {children}
      </div>
    </div>
  );
}

/**
 * The next action, rendered as a control only when there is one.
 *
 * Bold text reading "Correct the endpoint" that does nothing when pressed is a worse answer than
 * the sentence on its own: the reader spends their attempt on the product instead of on the
 * endpoint. A link renders as a link because it has somewhere to go, a re-read renders as a button
 * because this screen can take the reading again, and everything else is an instruction to a
 * person and is set as plain text.
 */
export function NextActionLine({ action, onRetry }: { readonly action: NextAction; readonly onRetry?: () => void }) {
  const body = (
    <>
      {action.label}
      {action.waitUntil && (
        <>
          {' '}
          <Instant at={action.waitUntil} relative />
        </>
      )}
    </>
  );

  return (
    <p className="text-detail">
      <span className="text-[color:var(--color-muted)]">{ownerLabel(action.owner)}: </span>
      {action.href ? (
        <a href={action.href} className="underline underline-offset-2">
          {body}
        </a>
      ) : action.kind === 'retry' && onRetry ? (
        <button type="button" onClick={onRetry} className="underline underline-offset-2">
          {body}
        </button>
      ) : (
        <span>{body}</span>
      )}
    </p>
  );
}

function ownerLabel(owner: NextAction['owner']): string {
  switch (owner) {
    case 'principal':
      return 'The account owner';
    case 'agent':
      return 'The agent';
    case 'provider':
      return 'The provider';
    case 'operator':
      return 'Bursar';
    case 'token-issuer':
      return 'The token issuer';
  }
}

/** The individual findings inside one state, each with its own level. */
export function ChecksList({ checks }: { readonly checks: readonly Check[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {checks.map((check) => (
        <li key={check.id} className="flex items-start gap-2 text-detail">
          <span className="pt-1.5">
            <LevelDot level={check.level} label={`${check.label}: ${levelWord(check.level)}`} />
          </span>
          <span>
            <span className="font-medium">{check.label}. </span>
            <span className="text-[color:var(--color-muted)]">{check.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * All five, in reading order. Connectivity first because nothing below it means anything if the
 * chain is unreachable.
 */
export function StatusList({ system, detailed = false }: { readonly system: SystemState; readonly detailed?: boolean }) {
  return (
    <div>
      {system.all.map((state) => (
        <StatusRow key={state.key} state={state} onRetry={system.refresh}>
          {detailed && <ChecksList checks={state.checks} />}
        </StatusRow>
      ))}
    </div>
  );
}

/**
 * A compact reading of all five for a header. Five marks, never one: a single light here would be
 * the same lie in less space.
 */
export function StatusStrip({ system }: { readonly system: SystemState }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {system.all.map((state) => (
        <LevelBadge key={state.key} level={state.level}>
          {state.label}
        </LevelBadge>
      ))}
    </div>
  );
}

/** What stands between the reader and a payment right now, one line each. Empty when nothing does. */
export function Blockers({ system }: { readonly system: SystemState }) {
  if (system.blockers.length === 0) return null;
  return (
    <ul className="space-y-1">
      {system.blockers.map((state) => (
        <li key={state.key} className="flex items-start gap-2 text-detail">
          <span className="pt-1.5">
            <LevelDot level={state.level} />
          </span>
          <span>
            <span className="font-medium">{state.headline} </span>
            <span className="text-[color:var(--color-muted)]">{state.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Part of a reading did not land, said out loud above whatever it was reading.
 *
 * Five surfaces reach the same position: the aggregate came back with holes in it, and the figures
 * underneath are now a mix of what the chain said and what it never got round to saying. An empty
 * cell and a cell that reads zero look identical and mean opposite things, so the page says which
 * it is rather than rendering a screen of confident zeroes. Each surface writes its own sentence,
 * because what went unanswered differs: the timelock, the escrow, a token contract.
 */
export function Unread({ children, onRetry }: { readonly children: ReactNode; readonly onRetry: () => void }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="flex items-start gap-2 text-sm">
          <span className="pt-1.5">
            <LevelDot level="unknown" />
          </span>
          <span>{children}</span>
        </p>
        <Button size="sm" onClick={onRetry}>
          Read again
        </Button>
      </div>
    </Card>
  );
}
