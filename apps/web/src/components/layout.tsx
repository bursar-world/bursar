import type { ReactNode } from 'react';

export function Card({ title, description, actions, children }: { readonly title?: ReactNode; readonly description?: ReactNode; readonly actions?: ReactNode; readonly children: ReactNode }) {
  return (
    <section className="border border-[color:var(--color-line)] bg-surface">
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-[color:var(--color-line)] px-5 py-4 sm:px-6">
          <div className="min-w-0">
            {title && <h2 className="text-base font-medium tracking-[-0.01em]">{title}</h2>}
            {description && <p className="mt-0.5 text-detail text-[color:var(--color-muted)]">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="px-5 py-4 sm:px-6 sm:py-5">{children}</div>
    </section>
  );
}

export function Section({ title, description, actions, children }: { readonly title: ReactNode; readonly description?: ReactNode; readonly actions?: ReactNode; readonly children: ReactNode }) {
  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-normal leading-tight tracking-[-0.04em]">{title}</h2>
          {description && <p className="mt-1.5 text-sm text-[color:var(--color-muted)]">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** Label above, value below. The shape most of this product's detail views are made of. */
export function Field({ label, hint, children }: { readonly label: ReactNode; readonly hint?: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-label uppercase tracking-wide text-[color:var(--color-muted)]">{label}</div>
      <div className="text-sm">{children}</div>
      {hint && <div className="text-note text-[color:var(--color-muted)]">{hint}</div>}
    </div>
  );
}

export function FieldGrid({ columns = 2, children }: { readonly columns?: 2 | 3 | 4; readonly children: ReactNode }) {
  const map = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-4' } as const;
  return <div className={`grid grid-cols-1 gap-x-6 gap-y-5 ${map[columns]}`}>{children}</div>;
}

export function EmptyState({ title, children, action }: { readonly title: ReactNode; readonly children?: ReactNode; readonly action?: ReactNode }) {
  return (
    <div className="border border-[color:var(--color-line)] bg-[color:var(--color-raised)] px-6 py-12 text-center">
      <p className="text-lg leading-snug tracking-[-0.02em]">{title}</p>
      {children && <p className="mx-auto mt-2 max-w-md text-detail text-[color:var(--color-muted)]">{children}</p>}
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}

export function Skeleton({ width = '100%', height = 14 }: { readonly width?: string | number; readonly height?: number }) {
  return <span className="inline-block bg-[color:var(--color-line)] align-middle motion-safe:animate-pulse" style={{ width, height }} aria-hidden="true" />;
}
