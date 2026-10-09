'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export type ModalProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly width?: number;
};

/**
 * Escape closes it, the backdrop closes it, and focus moves inside on open and back to whatever
 * opened it on close. A dialog that traps a keyboard user is worse than no dialog.
 */
export function Modal({ open, onClose, title, description, children, footer, width = 420 }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  // Callers pass a fresh onClose on every render. Keyed on it, the effect below re-ran on each
  // keystroke in a field inside the dialog and moved focus off the field after one letter, so a
  // typed confirmation could not be typed.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    // A dialog that asks for something typed opens on that field; otherwise on its first control.
    const focusable =
      panel.current?.querySelector<HTMLElement>('input, select, textarea') ??
      panel.current?.querySelector<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])');
    focusable?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  const stop = useCallback((event: { stopPropagation: () => void }) => event.stopPropagation(), []);

  if (!open) return null;

  // The panel sets its own alignment: a control in a right-aligned table cell opens it, and the
  // dialog would otherwise read right-aligned too.
  return (
    <div
      className="dialog-scrim fixed inset-0 z-50 flex items-end justify-center bg-scrim p-4 sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onClick={stop}
        style={{ maxWidth: width }}
        className="dialog-panel w-full border border-[color:var(--color-line)] bg-surface text-left"
      >
        <header className="flex items-start justify-between gap-4 border-b border-[color:var(--color-line)] px-6 pb-4 pt-5">
          <div>
            <h2 className="text-2xl font-normal leading-tight tracking-[-0.04em]">{title}</h2>
            {description && <p className="mt-1.5 text-detail text-[color:var(--color-muted)]">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 -mt-1 grid h-9 w-9 shrink-0 place-items-center text-xl leading-none text-[color:var(--color-muted)] transition-colors hover:bg-[color:var(--color-accent)] hover:text-[color:var(--color-ink)]"
          >
            &times;
          </button>
        </header>
        <div className="px-6 py-5">{children}</div>
        {footer && <footer className="border-t border-[color:var(--color-line)] bg-[color:var(--color-raised)] px-6 py-4">{footer}</footer>}
      </div>
    </div>
  );
}
