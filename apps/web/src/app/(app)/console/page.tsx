import type { Metadata } from 'next';

import { ConsoleView } from './console-view';

export const metadata: Metadata = {
  title: 'Console · Bursar',
  description: 'Give an AI agent a budget it cannot exceed, and see what each of your mandates has left.',
};

export default function ConsolePage() {
  return <ConsoleView />;
}
