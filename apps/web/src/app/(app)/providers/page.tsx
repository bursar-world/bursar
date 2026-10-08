import type { Metadata } from 'next';
import { ProviderView } from './provider-view';

export const metadata: Metadata = {
  title: 'Getting paid · BURSAR',
  description:
    'Get paid by agents through escrow. List your address with a stake, deliver the work, and grow the size of job a payer can open.',
};

export default function ProvidersPage() {
  return <ProviderView />;
}
