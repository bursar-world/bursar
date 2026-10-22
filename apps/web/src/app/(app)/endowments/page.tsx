import type { Metadata } from 'next';

import { EndowmentsList } from './list-view';

export const metadata: Metadata = {
  title: 'Endowments · Bursar',
  description: 'Fund an AI agent once. The principal stays invested in US stocks on Robinhood Chain, and the agent spends a yearly draw from it.',
};

export default function EndowmentsPage() {
  return <EndowmentsList />;
}
