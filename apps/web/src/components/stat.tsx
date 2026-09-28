import type { ReactNode } from 'react';
import type { StateLevel } from '../state';
import { LevelDot } from './badge';

export type StatProps = {
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** The second line: what the number is against, or when it changes. */
  readonly hint?: ReactNode;
  readonly level?: StateLevel;
  /** Renders the value in the tabular face, which is what a column of money needs. */
  readonly numeric?: boolean;
};

export function Stat({ label, value, hint, level, numeric = true }: StatProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-label uppercase tracking-wide text-[color:var(--color-muted)]">
        {level && <LevelDot level={level} />}
        {label}
      </div>
      <div className={`text-xl leading-tight ${numeric ? 'tabular tracking-[-0.02em]' : 'tracking-[-0.02em]'}`}>{value}</div>
      {hint && <div className="text-note text-[color:var(--color-muted)]">{hint}</div>}
    </div>
  );
}

export function StatGrid({ columns = 3, children }: { readonly columns?: 2 | 3 | 4; readonly children: ReactNode }) {
  const map = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-4' } as const;
  return <div className={`grid grid-cols-1 gap-x-6 gap-y-6 ${map[columns]}`}>{children}</div>;
}

/** How much of a limit is used. Shows the remainder, because that is the number being decided on. */
export function LimitBar({ used, total, level = 'ok' }: { readonly used: number; readonly total: number; readonly level?: StateLevel }) {
  const share = total <= 0 ? 0 : Math.min(100, Math.max(0, (used / total) * 100));
  const colour = level === 'blocked' ? 'var(--color-state-blocked)' : level === 'attention' ? 'var(--color-state-attention)' : 'var(--color-primary)';
  return (
    <div className="h-1 w-full overflow-hidden bg-[color:var(--color-line)]" role="presentation">
      <div className="h-full" style={{ width: `${share}%`, backgroundColor: colour }} />
    </div>
  );
}
