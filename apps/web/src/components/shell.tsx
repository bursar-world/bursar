import type { ReactNode } from 'react';

import { SITE } from '../site';
import { ConnectButton } from '../wallet/connect-button';
import { NavLinks, PageEyebrow } from './nav';

export function Shell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 pb-20 pt-10 sm:px-8 sm:pt-14">
        <PageEyebrow />
        <div className="page">{children}</div>
      </main>
      <Footer />
    </div>
  );
}

function Wordmark({ className }: { readonly className: string }) {
  // A plain anchor: the site is another origin with its own root layout.
  return (
    <a href={SITE.home} className={`font-semibold leading-none ${className}`}>
      {SITE.wordmark}
    </a>
  );
}

function Header() {
  return (
    <header className="bg-[color:var(--color-band)]">
      <div className="flex items-center gap-8 px-5 py-4 sm:px-8 sm:py-6 xl:px-12">
        <Wordmark className="shrink-0 text-lg tracking-[-1.1px] sm:text-xl sm:tracking-[-1.3px]" />
        <nav aria-label={SITE.navLabel} className="hidden flex-1 items-center justify-center gap-7 xl:flex">
          <NavLinks />
        </nav>
        <div className="header-action ml-auto flex min-h-10 items-center gap-3 sm:min-h-[50px] xl:ml-0">
          <ConnectButton />
        </div>
      </div>
      <nav
        aria-label={SITE.navLabel}
        className="flex gap-6 overflow-x-auto border-t border-[color:var(--color-line)] px-5 py-3 sm:px-8 xl:hidden"
      >
        <NavLinks />
      </nav>
    </header>
  );
}

function Footer() {
  const { settlement, legal, channels } = SITE.footer;

  return (
    <footer className="bg-[color:var(--color-footer)]">
      <div className="grid gap-10 px-5 pb-10 pt-14 sm:px-8 lg:grid-cols-[1fr_2fr] lg:gap-[12.5%] xl:px-12">
        <Wordmark className="self-start text-5xl tracking-[-0.06em] lg:text-[4.1vw]" />
        <div>
          {/* A plain list rather than a third navigation landmark: the header already names two. */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
            <NavLinks />
          </div>
          <ul className="mt-10 flex flex-wrap gap-3">
            {channels.map((channel) => (
              <li key={channel.href}>
                <a
                  href={channel.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-12 items-center gap-3 border border-[color:var(--color-line-strong)] px-5 text-sm transition-colors hover:bg-[color:var(--color-raised)]"
                >
                  <ChannelMark mark={channel.mark} />
                  {channel.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-10 space-y-2 border-t border-[color:var(--color-line-strong)] pt-6 text-note text-[color:var(--color-muted-deep)]">
            <p>
              Settling on {settlement.network}, chain {settlement.chainId}. USDG at{' '}
              <span className="tabular break-all">{settlement.asset}</span>.
            </p>
            <p className="max-w-2xl">{legal}</p>
          </div>
        </div>
      </div>
    </footer>
  );
}

function ChannelMark({ mark }: { readonly mark: 'x' | 'github' }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {mark === 'x' ? (
        <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.835L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
      ) : (
        <path d="M12 .8a11.4 11.4 0 0 0-3.6 22.2c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.3-1.3-1.6-1.3-1.6-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.4-5.5-6.1 0-1.3.5-2.5 1.2-3.3-.1-.3-.5-1.6.1-3.3 0 0 1-.3 3.4 1.3a12 12 0 0 1 6.2 0C17.9 4 19 4.3 19 4.3c.6 1.7.2 3 .1 3.3.8.8 1.2 2 1.2 3.3 0 4.7-2.8 5.8-5.5 6.1.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A11.4 11.4 0 0 0 12 .8" />
      )}
    </svg>
  );
}
