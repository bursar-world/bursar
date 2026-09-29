import { notFound } from 'next/navigation';

// An unknown path would otherwise fall outside this group's layout and get the framework's bare page.
export default function Missing() {
  notFound();
}
