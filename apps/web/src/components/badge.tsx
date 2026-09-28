import type { ReactNode } from 'react';
import type { StateLevel } from '../state';

const LEVEL_COLOR: Record<StateLevel, string> = {
  ok: 'var(--color-state-ok)',
  attention: 'var(--color-state-attention)',
  blocked: 'var(--color-state-blocked)',
  unknown: 'var(--color-state-unknown)',
  'not-applicable': 'var(--color-muted)',
};

/**
 * The shape carries the level as well as the colour. A reader who cannot tell the green from the
 * red still gets the answer from the outline, the filled square and the word.
 */
const LEVEL_WORD: Record<StateLevel, string> = {
  ok: 'Clear',
  attention: 'Needs attention',
  blocked: 'Blocked',
  unknown: 'Unknown',
  'not-applicable': 'Not in use',
};

export function levelWord(level: StateLevel): string {
  return LEVEL_WORD[level];
}

export function LevelDot({ level, label }: { readonly level: StateLevel; readonly label?: string }) {
  return (
    <span
      role="img"
      aria-label={label ?? LEVEL_WORD[level]}
      title={label ?? LEVEL_WORD[level]}
      className="inline-block h-2 w-2 shrink-0"
      style={{
        backgroundColor: level === 'ok' || level === 'blocked' ? LEVEL_COLOR[level] : 'transparent',
        border: `2px solid ${LEVEL_COLOR[level]}`,
      }}
    />
  );
}

export function LevelBadge({ level, children }: { readonly level: StateLevel; readonly children?: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 border bg-surface px-2 py-1 font-mono text-label uppercase leading-none tracking-wide"
      style={{ color: LEVEL_COLOR[level], borderColor: `color-mix(in srgb, ${LEVEL_COLOR[level]} 45%, transparent)` }}
    >
      <LevelDot level={level} />
      {children ?? LEVEL_WORD[level]}
    </span>
  );
}

export function Badge({ children, tone = 'neutral' }: { readonly children: ReactNode; readonly tone?: 'neutral' | 'quiet' }) {
  return (
    <span
      className={`inline-flex items-center border px-2 py-1 font-mono text-label uppercase leading-none tracking-wide ${
        tone === 'quiet'
          ? 'border-[color:var(--color-line)] text-[color:var(--color-muted)]'
          : 'border-[color:var(--color-line-strong)] bg-[color:var(--color-raised)] text-[color:var(--color-ink)]'
      }`}
    >
      {children}
    </span>
  );
}
