import type { Metadata } from 'next';
import { StatusView } from './status-view';

export const metadata: Metadata = {
  title: 'Status · Bursar',
  description: 'Live conditions for payments on Bursar: connectivity, the settlement asset, and each account’s mandate, permissions and funding.',
};

export default function StatusPage() {
  return <StatusView />;
}
