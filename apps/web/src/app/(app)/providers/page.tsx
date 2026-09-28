import type { Metadata } from 'next';
import { ProviderView } from './provider-view';

export const metadata: Metadata = {
  title: 'Getting paid · BURSAR',
  description:
    'For the party being paid: what a listing costs, locks held against an address, and the record that decides how large a single job may be. Readable without a wallet.',
};

export default function ProvidersPage() {
  return <ProviderView />;
}
