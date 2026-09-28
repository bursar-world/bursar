import { getAddress } from 'viem';
import type { ReactNode } from 'react';

import { readsAsAddress } from '@/lib/path';
import { MandateChrome } from './mandate-chrome';
import { MandateScopeProvider } from './mandate-scope';
import { UnreadableAddress } from './unreadable-address';

export default async function MandateLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly mandate: string }>;
}) {
  const { mandate } = await params;

  // A mandate account lives at an address, so the address in the URL is checked before anything is
  // read against it. Checksum is not required of whoever typed it; it is applied here.
  //
  // The screen is rendered here. `notFound()` would hand this to the router, which answers
  // with its own sentence: the page does not exist. The page does exist. Middleware has already set
  // the status by this point, on the same rule.
  if (!readsAsAddress(mandate)) return <UnreadableAddress typed={mandate} />;

  return (
    <MandateScopeProvider address={getAddress(mandate)}>
      <MandateChrome>{children}</MandateChrome>
    </MandateScopeProvider>
  );
}
