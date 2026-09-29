import Link from 'next/link';
import { EmptyState } from '@/components/layout';

export default function NotFound() {
  return (
    <EmptyState
      title="That page does not exist."
      action={
        <div className="flex flex-wrap gap-4 text-detail">
          <Link href="/console" className="underline underline-offset-2">
            Open the console
          </Link>
          <Link href="/status" className="underline underline-offset-2">
            Check the status page
          </Link>
        </div>
      }
    >
      The address may be mistyped, or the page may have moved. Mandates open at /console followed by their address.
    </EmptyState>
  );
}
