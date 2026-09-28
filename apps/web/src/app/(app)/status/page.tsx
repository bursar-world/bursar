import type { Metadata } from 'next';
import { StatusView } from './status-view';

export const metadata: Metadata = {
  title: 'Status · BURSAR',
  description: 'Asset, mandate, permission, funding and connectivity, each reported on its own terms.',
};

export default function StatusPage() {
  return <StatusView />;
}
