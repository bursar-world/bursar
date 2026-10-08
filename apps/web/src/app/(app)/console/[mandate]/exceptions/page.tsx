import type { Metadata } from 'next';

import { ExceptionsView } from './exceptions-view';

export const metadata: Metadata = {
  title: 'Exceptions · BURSAR',
  description: 'Payments that were refused, returned or contested, and why.',
};

export default function ExceptionsPage() {
  return <ExceptionsView />;
}
