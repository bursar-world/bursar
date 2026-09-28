import { Card, Field, FieldGrid } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { usd, usdExact } from '@/money';

import type { ProviderDesk } from './desk';
import { capAtScore } from './registry';

/** The scores the curve is worth showing at: the floor, the midpoint and a clean record. */
const SAMPLE_SCORES = [0, 50, 100] as const;

/**
 * The settlement record, and the ceiling it buys.
 *
 * These five figures are the whole argument for finishing a job rather than letting it run out.
 * Score is delivered work as a share of settled work, and the escrow will not let a payer lock
 * more than `capOf(score)` against this address, so the curve is the price list: a payee can read
 * what the next ten points are worth before deciding whether to chase them.
 */
export function ReputationPanel({ desk, owned }: { readonly desk: ProviderDesk; readonly owned: boolean }) {
  const { record } = desk;
  const whose = owned ? 'you' : 'this address';
  const possessive = owned ? 'your' : "this address's";

  const curve =
    record.baseCap === undefined || record.capPerScore === undefined || record.maxCap === undefined
      ? undefined
      : `${usd(record.baseCap)} at a score of nothing, plus ${usd(record.capPerScore)} for every point, to a ceiling of ${usd(record.maxCap)}.`;

  return (
    <div className="space-y-3">
      <Card>
        <StatGrid columns={4}>
          <Stat label="Delivered" value={record.released?.toString() ?? '—'} hint="Releases written into the record" />
          <Stat label="Contested" value={record.disputed?.toString() ?? '—'} hint="Jobs a payer challenged" />
          {/*
            Exact, and the sum of what the escrow moved rather than what the jobs were
            worth. Two decimal places round a cent payment to nothing, and this figure sits beside
            a column that now names each payout to the sixth.
          */}
          <Stat
            label="Paid out"
            value={desk.paidOut === undefined ? '—' : usdExact(desk.paidOut)}
            hint={
              desk.complete
                ? `What reached this address, across the ${desk.locks.length === 1 ? 'job' : 'jobs'} read below`
                : 'Not read'
            }
          />
          <Stat
            label="Score"
            value={record.score === undefined ? '—' : `${record.score} / 100`}
            hint="Delivered as a share of settled"
          />
        </StatGrid>
      </Card>

      <Card
        title="What the score is worth"
        description="The escrow refuses a lock larger than the ceiling, so this is the size of job a payer may open."
      >
        <div className="space-y-4">
          <FieldGrid columns={4}>
            <Field label="Returned to payer" hint="Locks that ran past their deadline">
              {record.timedOut?.toString() ?? 'Not read'}
            </Field>
            {SAMPLE_SCORES.map((score) => {
              const cap = capAtScore(record, score);
              const here = record.score === score;
              return (
                <Field key={score} label={`Score ${score}`} hint={here ? `Where ${whose} stand${owned ? '' : 's'} now` : undefined}>
                  <span className="tabular">{cap === undefined ? 'Not read' : usd(cap)}</span>
                </Field>
              );
            })}
          </FieldGrid>

          <p className="text-detail text-[color:var(--color-muted)]">
            Score is the jobs {whose} delivered as a share of every job that reached an outcome, from 0 to 100. The
            largest single job a payer may lock against {whose} follows from it by a published curve:{' '}
            {curve ?? 'the curve could not be read.'} Changing that curve waits out the governance delay, so the number
            above is the one to plan against.
          </p>
          <p className="text-detail text-[color:var(--color-muted)]">
            A lock that runs past its deadline counts against {possessive} record whoever opened it, and returning a job
            that cannot be taken costs the record nothing. Declining early is worth more than letting the clock run out.
            A contested job counts as settled and not as delivered, which is what pulls the score down.
          </p>
        </div>
      </Card>
    </div>
  );
}
