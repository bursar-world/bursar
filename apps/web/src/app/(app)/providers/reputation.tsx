import type { Micro } from '@bursar/core';

import { Card, Field, FieldGrid } from '@/components/layout';
import { LimitBar, Stat, StatGrid } from '@/components/stat';
import { usd, usdHeld } from '@/money';

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
      : `${usd(record.baseCap)} at a score of zero, plus ${usd(record.capPerScore)} per point, up to ${usd(record.maxCap)}.`;

  return (
    <div className="space-y-3">
      <Card>
        <StatGrid columns={5}>
          <Stat label="Delivered" value={record.released?.toString() ?? '—'} hint="Jobs recorded as delivered" />
          <Stat label="Contested" value={record.disputed?.toString() ?? '—'} hint="Jobs a payer challenged" />
          <Stat label="Returned to payer" value={record.timedOut?.toString() ?? '—'} hint="Jobs recorded as past their deadline" />
          {/*
            Exact, and the sum of what the escrow moved rather than what the jobs were
            worth. Two decimal places round a cent payment to nothing, and this figure sits beside
            a column that now names each payout to the sixth.
          */}
          <Stat
            label="Paid out"
            value={desk.paidOut === undefined ? '—' : usdHeld(desk.paidOut)}
            hint={
              desk.complete
                ? `Received across the ${desk.locks.length === 1 ? 'job' : 'jobs'} below`
                : 'Not read'
            }
          />
          <Stat
            label="Score"
            value={record.score === undefined ? '—' : `${record.score} / 100`}
            hint={weighed ? 'Delivered share of settled jobs, weighted by credit' : 'Delivered share of settled jobs'}
          />
        </StatGrid>
      </Card>

      {weighed && <CreditCard record={record} whose={whose} possessive={possessive} />}

      <Card
        title="What the score is worth"
        description="The largest single job a payer can open at each score."
      >
        <div className="space-y-4">
          <FieldGrid columns={3}>
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
            Score runs from 0 to 100: the share of jobs {whose} delivered
            {weighed ? ', weighted by the credit that work earned' : ''}. It sets the largest job a payer can open:{' '}
            {curve ?? 'the curve could not be read right now.'} The curve only changes through governance, after a public
            delay.
          </p>
          <p className="text-detail text-[color:var(--color-muted)]">
            A missed deadline counts against {possessive} record. Returning a job you cannot take does not, so decline
            early rather than let the clock run out. A contested job counts as settled but not delivered, which lowers the
            score.
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
          ? 'Earned by delivered work, up to a cap per payer.'
          : `Earned by delivered jobs of ${usd(weights.minScored)} or more, up to ${usd(weights.edgeCap)} per payer.`
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
  if (weights === undefined || earned === undefined) return 'The credit behind this score could not be read right now.';
  if (settled === undefined) return 'The jobs behind this score could not be read right now.';
  const fullCredit = usd(weights.fullCredit);
  if (settled === 0n) {
    return (
      `No job has been recorded for ${whose} yet. Each delivered job of ${usd(weights.minScored)} or more adds its amount ` +
      `here once it is recorded, and a full score takes ${fullCredit} from at least ${fewestPayers(weights.fullCredit, weights.edgeCap)} payers.`
    );
  }
  const score = record.score === undefined ? '' : `: ${record.score} of 100`;
  const next = full
    ? `The credit is full, so ${possessive} score now moves with the delivered share alone.`
    : `Each payer counts for up to ${usd(weights.edgeCap)}, so once a payer reaches that, only work from new payers ` +
      `adds credit. Jobs under ${usd(weights.minScored)} do not count.`;
  return (
    `${record.released} of ${settled} settled jobs were delivered, earning ${usd(earned)} of the ${fullCredit} a ` +
    `full score takes. The score combines the two${score}. ${next}`
  );
}

function fewestPayers(fullCredit: bigint, edgeCap: bigint): string {
  if (edgeCap === 0n) return 'one';
  return ((fullCredit + edgeCap - 1n) / edgeCap).toString();
}
