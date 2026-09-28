import type { Metadata } from 'next';

import { ConsoleView } from './console-view';

export const metadata: Metadata = {
  title: 'Console · BURSAR',
  description: 'Mandates you own, what each one has left, approvals waiting on a signature, settled payments, and refusals with the reason attached.',
};

export default function ConsolePage() {
  return <ConsoleView />;
}
