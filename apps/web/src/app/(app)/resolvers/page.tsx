import type { Metadata } from 'next';
import { ResolverView } from './resolver-view';

export const metadata: Metadata = {
  title: 'Ruling on disputes · BURSAR',
  description:
    'Rule on contested payments. Bonded resolvers seal a score, reveal it, and the median sets how much goes back to the payer.',
};

export default function ResolversPage() {
  return <ResolverView />;
}
