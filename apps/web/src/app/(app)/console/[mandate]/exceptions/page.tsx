import type { Metadata } from 'next';

import { ExceptionsView } from './exceptions-view';

export const metadata: Metadata = {
  title: 'Exceptions · BURSAR',
  description: 'Refused payments and contested deliveries, each naming the condition that caused it.',
};

export default function ExceptionsPage() {
  return <ExceptionsView />;
}
