import { Card, Skeleton } from '@/components/layout';

/**
 * What every route shows while its server work is in flight.
 *
 * Without a boundary here Next holds the previous screen and shows nothing at all, so a slow read
 * is indistinguishable from a click that missed. The shape is the shape of the pages underneath:
 * a heading, a row of figures, and a panel, so the page does not jump when the real one arrives.
 */
export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>

      <div className="space-y-2">
        <Skeleton width={220} height={36} />
        <Skeleton width={320} height={13} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {['one', 'two', 'three'].map((key) => (
          <div key={key} className="space-y-2 border border-[color:var(--color-line)] bg-surface px-5 py-4">
            <Skeleton width={90} height={11} />
            <Skeleton width={130} height={20} />
          </div>
        ))}
      </div>

      <Card>
        <div className="space-y-3">
          <Skeleton width="70%" />
          <Skeleton width="55%" />
          <Skeleton width="62%" />
        </div>
      </Card>
    </div>
  );
}
