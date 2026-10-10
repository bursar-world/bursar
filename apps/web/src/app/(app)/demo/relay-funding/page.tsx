import type { Metadata } from 'next';

import { RelayFundingDemo } from './demo';

export const metadata: Metadata = {
  title: 'Fund a mandate from Base, Arc or Solana · Bursar',
  description: 'Send USDC from Base, Arc or Solana and USDG lands in a Bursar mandate on Robinhood Chain. Relay carries the transfer.',
};

export default function RelayFundingDemoPage() {
  return <RelayFundingDemo />;
}
