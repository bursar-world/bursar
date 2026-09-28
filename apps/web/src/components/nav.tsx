'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { SITE } from '../site';
import type { NavItem } from '../site';

function current(pathname: string): NavItem | undefined {
  return SITE.nav.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
}

/** The surfaces as links, the one in view marked with the site's peach square. */
export function NavLinks({ className = '' }: { readonly className?: string }) {
  const active = current(usePathname());

  return SITE.nav.map((item) => (
    <Link
      key={item.href}
      href={item.href}
      className={`inline-flex items-center gap-2 whitespace-nowrap font-mono text-note uppercase transition-colors hover:text-[color:var(--color-ink)] ${
        item === active ? 'text-[color:var(--color-ink)]' : 'text-[color:var(--color-muted-deep)]'
      } ${className}`}
    >
      {item === active && <i className="inline-block h-1.5 w-1.5 bg-[color:var(--color-mark)]" />}
      {item.label}
    </Link>
  ));
}

/** The site's section label above a page title: the surface's place in the navigation, then its name. */
export function PageEyebrow() {
  const active = current(usePathname());
  if (!active) return null;

  return (
    <div className="eyebrow mb-4 text-[color:var(--color-ink)]" aria-hidden="true">
      <i />
      <span>{String(SITE.nav.indexOf(active) + 1).padStart(2, '0')}</span>
      {active.label}
    </div>
  );
}
