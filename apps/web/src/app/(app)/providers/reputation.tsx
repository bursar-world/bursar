import type { Micro } from '@bursar/core';

import { Card, Field, FieldGrid } from '@/components/layout';
import { LimitBar, Stat, StatGrid } from '@/components/stat';
import { usd, usdExact } from '@/money';

import type { ProviderDesk, ProviderRecord } from './desk';
import { capAtScore } from './registry';

/** The scores the curve is worth showing at: the floor, the midpoint and a clean record. */
const SAMPLE_SCORES = [0, 50, 100] as const;

/**
 * The settlement record, and the ceiling it buys.
 *
 * These five figures are the whole argument for finishing a job rather than letting it run out.
 * Score is delivered work as a share of settled work, from v4 scaled by the credit that work has
 * earned, and the escrow will not let a payer lock more than `capOf(score)` against this address,
 * so the curve is the price list: a payee can read what the next ten points are worth before
 * deciding whether to chase them.
 */
export function ReputationPanel({ desk, owned }: { readonly desk: ProviderDesk; readonly owned: boolean }) {
  const { record } = desk;
  const whose = owned ? 'you' : 'this address';
  const possessive = owned ? 'your' : "this address's";
  const weighed = record.credit !== null;

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
            hint={weighed ? 'Delivered as a share of settled, scaled by the credit earned' : 'Delivered as a share of settled'}
          />
        </StatGrid>
      </Card>

      {weighed && <CreditCard record={record} whose={whose} possessive={possessive} />}

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
            Score is the jobs {whose} delivered as a share of every job that reached an outcome
            {weighed ? ', scaled by the credit that work has earned,' : ','} from 0 to 100. The largest single job a payer
            may lock against {whose} follows from it by a published curve: {curve ?? 'the curve could not be read.'}{' '}
            Changing that curve waits out the governance delay, so the number above is the one to plan against.
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

/**
 * Why a record with every job delivered can still score 25.
 *
 * From v4 a point is paid for in delivered volume from more than one payer: each delivered job adds
 * its amount to a credit, each payer counts for up to the edge cap, and the released share is scaled
 * by how much of the full credit has been earned. Shown as the two factors and the one figure that
 * can still move, so a payee knows whether the next job from the same payer is worth anything.
 */
function CreditCard({ record, whose, possessive }: { readonly record: ProviderRecord; readonly whose: string; readonly possessive: string }) {
  const weights =
    record.minScored != null && record.edgeCap != null && record.fullCredit != null
      ? { minScored: record.minScored, edgeCap: record.edgeCap, fullCredit: record.fullCredit }
      : undefined;
  const credit = record.credit ?? undefined;
  const settled =
    record.released === undefined || record.timedOut === undefined || record.disputed === undefined
      ? undefined
      : record.released + record.timedOut + record.disputed;
  // Credit past the top is counted as the top, which is how the contract scores it.
  const earned = weights === undefined || credit === undefined ? undefined : credit < weights.fullCredit ? credit : weights.fullCredit;
  const full = weights !== undefined && credit !== undefined && credit >= weights.fullCredit;

  return (
    <Card
      title="Credit toward a full score"
      description={
        weights === undefined
          ? 'Delivered work earns it, each payer up to a cap.'
          : `Delivered work earns it: each job of ${usd(weights.minScored)} or more, each payer for up to ${usd(weights.edgeCap)}.`
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-4">
            <span className="tabular text-xl tracking-[-0.02em]">{earned === undefined ? 'Not read' : usd(earned)}</span>
            <span className="text-detail text-[color:var(--color-muted)]">
              of {weights === undefined ? 'the full credit' : usd(weights.fullCredit)}
            </span>
          </div>
          {weights !== undefined && earned !== undefined && (
            <LimitBar used={Number(earned) / 1e6} total={Number(weights.fullCredit) / 1e6} level={full ? 'ok' : 'attention'} />
          )}
        </div>

        <p className="text-detail text-[color:var(--color-muted)]">{creditStory({ weights, earned, full, settled, record, whose, possessive })}</p>
      </div>
    </Card>
  );
}

function creditStory({
  weights,
  earned,
  full,
  settled,
  record,
  whose,
  possessive,
}: {
  readonly weights: { readonly minScored: Micro; readonly edgeCap: Micro; readonly fullCredit: Micro } | undefined;
  readonly earned: Micro | undefined;
  readonly full: boolean;
  readonly settled: bigint | undefined;
  readonly record: ProviderRecord;
  readonly whose: string;
  readonly possessive: string;
}): string {
  if (weights === undefined || earned === undefined) return 'The credit behind this score could not be read.';
  if (settled === undefined) return 'The jobs behind this score could not be read.';
  const fullCredit = usd(weights.fullCredit);
  if (settled === 0n) {
    return (
      `Nothing has settled for ${whose} yet. Every delivered job of ${usd(weights.minScored)} or more adds its amount ` +
      `here, and a full score takes ${fullCredit} from at least ${fewestPayers(weights.fullCredit, weights.edgeCap)} payers.`
    );
  }
  const score = record.score === undefined ? '' : `: ${record.score} of 100`;
  const next = full
    ? `The credit is full, so ${possessive} score now moves with the delivered share alone.`
    : `A payer counts for up to ${usd(weights.edgeCap)}, so more work from a payer already there adds nothing, and work ` +
      `from a new payer does. A job under ${usd(weights.minScored)} counts for nothing either way.`;
  return (
    `${record.released} of ${settled} settled jobs were delivered, and that work has earned ${usd(earned)} of the ` +
    `${fullCredit} a full score takes. The score is the first share scaled by the second${score}. ${next}`
  );
}

function fewestPayers(fullCredit: bigint, edgeCap: bigint): string {
  if (edgeCap === 0n) return 'one';
  return ((fullCredit + edgeCap - 1n) / edgeCap).toString();
}
