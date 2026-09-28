import type { Metadata } from 'next';
import { ResolverView } from './resolver-view';

export const metadata: Metadata = {
  title: 'Ruling on disputes · BURSAR',
  description:
    'For bonded resolvers: contested settlements, the window on each one, and the sealed vote that decides how much of the locked money goes back.',
};

export default function ResolversPage() {
  return <ResolverView />;
}
