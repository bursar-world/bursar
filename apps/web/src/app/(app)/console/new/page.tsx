import type { Metadata } from 'next';

import { CreateMandateView } from './create-view';

export const metadata: Metadata = {
  title: 'Create a mandate · BURSAR',
  description: 'Set what an agent may spend, who it may pay and what it may buy, and read the account address before it exists.',
};

export default function NewMandatePage() {
  return <CreateMandateView />;
}
