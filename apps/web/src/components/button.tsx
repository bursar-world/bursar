'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonTone = 'primary' | 'secondary' | 'quiet' | 'destructive';
export type ButtonSize = 'sm' | 'md';

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  readonly tone?: ButtonTone;
  readonly size?: ButtonSize;
  readonly children: ReactNode;
  /** Escape hatch for a surface that needs to place the control. Visual style stays here. */
  readonly className?: string;
};

const TONES: Record<Exclude<ButtonTone, 'primary'>, string> = {
  secondary:
    'border-[color:var(--color-line-strong)] bg-transparent text-[color:var(--color-ink)] hover:border-[color:var(--color-ink)] hover:bg-surface',
  quiet: 'border-transparent bg-transparent text-[color:var(--color-muted)] hover:text-[color:var(--color-ink)]',
  destructive: 'border-[color:var(--color-state-blocked)] bg-[color:var(--color-state-blocked)] text-on-ink hover:opacity-90',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 px-3.5 text-label',
  md: 'h-11 px-5 text-note',
};

const ACTION_SIZES: Record<ButtonSize, { readonly bar: string; readonly label: string; readonly square: string; readonly chevron: number }> = {
  sm: { bar: 'min-h-9 text-label', label: 'px-3.5 py-1.5', square: 'w-9', chevron: 15 },
  md: { bar: 'min-h-11 text-note', label: 'px-5 py-2', square: 'w-11', chevron: 17 },
};

export function Button({ tone = 'secondary', size = 'md', type = 'button', className = '', children, ...rest }: ButtonProps) {
  if (tone === 'primary') {
    const shape = ACTION_SIZES[size];
    return (
      <button type={type} data-tone={tone} className={`action ${shape.bar} disabled:opacity-50 ${className}`} {...rest}>
        <span className={`action-label ${shape.label}`}>
          <span>{children}</span>
        </span>
        <span className={`action-square ${shape.square}`}>
          <Chevron size={shape.chevron} />
        </span>
      </button>
    );
  }

  return (
    <button
      type={type}
      data-tone={tone}
      className={`inline-flex items-center justify-center gap-2 border font-mono uppercase tracking-wide transition-colors disabled:opacity-50 ${TONES[tone]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A button whose whole content is an icon. Needs a label, because nothing else names it. */
export function IconButton({ label, children, className = '', ...rest }: Omit<ButtonProps, 'children' | 'tone' | 'size'> & { readonly label: string; readonly children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex h-7 w-7 items-center justify-center border border-transparent text-[color:var(--color-muted)] transition-colors hover:bg-[color:var(--color-band)] hover:text-[color:var(--color-ink)] disabled:opacity-50 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

function Chevron({ size }: { readonly size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
