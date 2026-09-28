import Link from 'next/link';
import { EmptyState } from '@/components/layout';

export default function NotFound() {
  return (
    <EmptyState
      title="That page does not exist."
      action={
        <Link href="/" className="text-detail underline underline-offset-2">
          Back to the start
        </Link>
      }
    />
  );
}
