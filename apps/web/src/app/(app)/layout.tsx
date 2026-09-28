import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { preload } from 'react-dom';
import { cookieToInitialState } from 'wagmi';

import { Shell } from '../../components/shell';
import { wagmiConfig } from '../../wallet/config';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'BURSAR',
  description: 'Set a spending mandate. Agents spend inside it. The limits are enforced by a contract.',
  icons: { icon: { url: '/brand/mark.png', type: 'image/png' } },
};

export default async function RootLayout({ children }: { readonly children: React.ReactNode }) {
  const initialState = cookieToInitialState(wagmiConfig(), (await headers()).get('cookie'));

  // The faces are declared in globals.css and fetched only once a rule asks for them, which is after
  // the first paint. Asking up front keeps the page from painting in the fallback and then reflowing.
  preload('/fonts/zalando.woff2', { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
  preload('/fonts/geist-mono.woff2', { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });

  return (
    <html lang="en">
      <body>
        <Providers initialState={initialState}>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
