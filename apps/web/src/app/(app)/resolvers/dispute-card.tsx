'use client';

import type { Micro } from '@bursar/core';
import type { Address } from 'viem';

import { oracleRegistryAbi, shortAddress, splitSettlement } from '@/chain';
import { publishedCapability } from '@/chain/capabilities';
import { Address as AddressLine } from '@/components/address';
import { LevelBadge } from '@/components/badge';
import { Countdown, Instant } from '@/components/instant';
import { Card, Field, FieldGrid } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { formatRelative } from '@/lib';
import { bps, usd, usdExact } from '@/money';
import type { AnyState } from '@/state';

import { CommitForm } from './commit-form';
import type { DisputeRow, OracleConfig } from './desk';
import { commitCheck, phaseLabel, phaseLevel, revealCheck, silenceSlash } from './phases';
import type { CommitBlocker, RevealBlocker } from './phases';
import { resolverFailure } from './refusal';
import { RevealForm } from './reveal-form';
import { RulingNote } from './ruling-note';
import { useWriteContract } from '@/wallet/write';

/**
 * One dispute, whole: what is being argued over, what the panel has done so far, what this wallet
 * has done, and the one call that moves it next.
 *
 * The money comes first. A resolver deciding how much attention a dispute is worth is deciding it
 * against the amount at stake and the clock, and both are at the top of the card.
 */
export function DisputeCard({
  dispute,
  config,
  resolverFeeBps,
  chainTime,
  account,
  registry,
  standing,
  blockedBy,
  onDone,
}: {
  readonly dispute: DisputeRow;
  readonly config: OracleConfig | undefined;
  /** The escrow's cut of a settled lock. Undefined where the escrow did not answer for it. */
  readonly resolverFeeBps: number | undefined;
  /** The chain's clock. Every window on this card is judged against it, never the browser's. */
  readonly chainTime: Date;
  readonly account: Address | undefined;
  readonly registry: Address;
  readonly standing: {
    readonly status: number | undefined;
    readonly bond: bigint | undefined;
    readonly floor: bigint | undefined;
    readonly barred: boolean | undefined;
  } | undefined;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
}) {
  const settlement = dispute.settlement;
  const capability = settlement === undefined ? undefined : publishedCapability(settlement.capabilityId);

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          Dispute {dispute.id.toString()}
          <LevelBadge level={phaseLevel(dispute.phase)}>{phaseLabel(dispute.phase)}</LevelBadge>
        </span>
      }
      description={
        settlement === undefined ? (
          `Settlement ${dispute.escrowId.toString()}. The escrow did not answer for it, so the amount at stake is unknown.`
        ) : (
          <>
            {usd(settlement.amount)} locked on settlement {settlement.id.toString()}, contested by{' '}
            {shortAddress(settlement.disputer)}.
          </>
        )
      }
      actions={
        dispute.deadline === null ? (
          <span className="text-note text-[color:var(--color-muted)]">No clock running</span>
        ) : (
          <span className="text-note text-[color:var(--color-muted)]">
            {dispute.phase === 'commit' ? 'Sealing closes' : 'Reveal closes'} <Countdown to={dispute.deadline} />
          </span>
        )
      }
    >
      <div className="space-y-5">
        <FieldGrid columns={4}>
          <Field label="At stake" hint="Held by the escrow until this dispute is closed.">
            <span className="tabular">{settlement === undefined ? 'Not read' : usd(settlement.amount)}</span>
          </Field>
          <Field label="Paid to" hint="The party that took the job.">
            {settlement === undefined ? 'Not read' : <AddressLine value={settlement.payee} />}
          </Field>
          <Field label="Paid by" hint="The party contesting the work.">
            {settlement === undefined ? 'Not read' : <AddressLine value={settlement.payer} />}
          </Field>
          {/*
            A bond is a few basis points of the lock, so two decimal places round most of them to
            nothing. The escrow held 0.005 USDG against dispute 1 and this field read $0.00, which
            tells a resolver the disputer has staked nothing when they have.
          */}
          <Field label="Contest bond" hint="Staked by the disputer. The ruling decides whether it comes back.">
            <span className="tabular">{settlement === undefined ? 'Not read' : usdExact(settlement.bond)}</span>
          </Field>
        </FieldGrid>

        <FieldGrid columns={4}>
          <Field label="Sealed scores" hint={config === undefined ? 'Panel size not read' : `Panel takes ${config.maxVoters}, quorum is ${config.quorum}`}>
            <span className="tabular">{dispute.commitCount}</span>
          </Field>
          <Field label="Revealed" hint="Published scores. The median of these decides the refund.">
            <span className="tabular">{dispute.revealCount}</span>
          </Field>
          <Field label="Opened">
            <Instant at={dispute.openedAt} />
          </Field>
          <Field label="Kind of work" hint="What the payer bought.">
            {settlement === undefined ? 'Not read' : (capability ?? <span className="tabular text-detail">{shortAddress(settlement.capabilityId, 10, 6)}</span>)}
          </Field>
        </FieldGrid>

        {settlement !== undefined && (settlement.inputURI !== '' || settlement.outputURI !== '') && (
          <FieldGrid columns={2}>
            <Field label="What was asked for" hint="Published by the payer when the lock was made.">
              <Evidence uri={settlement.inputURI} />
            </Field>
            <Field label="What was delivered" hint="Published by the payee at release.">
              <Evidence uri={settlement.outputURI} />
            </Field>
          </FieldGrid>
        )}

        <Outcome dispute={dispute} resolverFeeBps={resolverFeeBps} />
        <RulingNote disputeId={dispute.id} />
        {account !== undefined && <YourPart dispute={dispute} />}

        {config !== undefined && (
          <Action
            dispute={dispute}
            config={config}
            resolverFeeBps={resolverFeeBps}
            chainTime={chainTime}
            account={account}
            registry={registry}
            standing={standing}
            blockedBy={blockedBy}
            onDone={onDone}
          />
        )}
      </div>
    </Card>
  );
}

/** The inline form the SDK publishes a brief and a delivery in. */
const INLINE_JSON = 'data:application/json;base64,';

/**
 * What was asked for, and what came back.
 *
 * A resolver is being paid to judge whether the delivery matches the brief, and both of them
 * travel inline on the lock as base64. Printing that base64 puts the one thing the panel has to
 * read behind a decoding step done by hand, so it is decoded here. Nothing is fetched: a URI
 * pointing somewhere else stays a link, and following one on a counterparty's word from a page
 * holding a wallet is not a thing this product does.
 */
function Evidence({ uri }: { readonly uri: string }) {
  if (uri === '') return <span className="text-[color:var(--color-muted)]">Nothing published</span>;

  const inline = decodeInline(uri);
  if (inline !== undefined) {
    return (
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-note leading-relaxed" title={uri}>
        {inline}
      </pre>
    );
  }

  const safe = uri.startsWith('https://') || uri.startsWith('ipfs://') || uri.startsWith('data:');
  if (!safe) return <span className="tabular break-all text-detail">{uri}</span>;

  return (
    <a href={uri} target="_blank" rel="noreferrer noopener" className="tabular break-all text-detail underline underline-offset-2">
      {uri}
    </a>
  );
}

/**
 * The payload a data URI carries, or nothing when it is not one this console can read back.
 *
 * Undecodable is never guessed at. A payload that is not base64 UTF-8, or not JSON, falls through
 * to the raw URI: a resolver reading mangled text would be judging a delivery against something
 * neither party published.
 */
function decodeInline(uri: string): string | undefined {
  if (uri.slice(0, INLINE_JSON.length).toLowerCase() !== INLINE_JSON) return undefined;

  let text: string;
  try {
    const binary = atob(uri.slice(INLINE_JSON.length));
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return undefined;
  }

  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return undefined;
  }
}

/**
 * What a closed dispute did to the money, read back from the chain.
 *
 * `refundBps` is applied to the lock after the resolver fee has been taken off it, so a refund of
 * 10,000 basis points returns the lock less that fee. Printing the percentage on its own reads as
 * a whole refund and is off by the fee on every dispute this registry has ever closed.
 */
function Outcome({ dispute, resolverFeeBps }: { readonly dispute: DisputeRow; readonly resolverFeeBps: number | undefined }) {
  if (dispute.phase !== 'finalized' && dispute.phase !== 'failed') return null;

  const settlement = dispute.settlement;
  const money =
    settlement === undefined || resolverFeeBps === undefined
      ? 'The escrow takes its resolver fee off the lock before the refund is worked out, so the payer was refunded the lock less that fee. The amounts behind it were not read here.'
      : refundSentence(settlement.amount, dispute.refundBps, resolverFeeBps);

  if (dispute.phase === 'finalized') {
    return (
      <p className="text-sm">
        The panel ruled. Median score <span className="tabular font-semibold">{dispute.medianScore}</span>, which sets
        the refund at {bps(dispute.refundBps)} and leaves the rest with the payee. {money} The fee splits between the{' '}
        {dispute.rewardShares} {dispute.rewardShares === 1 ? 'score' : 'scores'} that held.
      </p>
    );
  }

  return (
    <p className="text-sm">
      Closed without a ruling, which is what happens when the panel produces no usable result. The refund was set to{' '}
      {bps(dispute.refundBps)}. {money} No resolver earned a share of that fee, so it sits on the registry until
      somebody sweeps it to the slash sink.
    </p>
  );
}

function refundSentence(amount: Micro, refundBps: number, resolverFeeBps: number): string {
  const split = splitSettlement(amount, refundBps, resolverFeeBps, 0);
  return `The payer was refunded ${usdExact(split.refunded)} of the ${usd(amount)} held, after a ${bps(
    resolverFeeBps,
  )} resolver fee of ${usdExact(split.resolverFee)} came off the top.`;
}

function YourPart({ dispute }: { readonly dispute: DisputeRow }) {
  const yours = dispute.yours;
  if (yours === undefined) return null;

  if (yours.committed === undefined) {
    return <p className="text-detail text-[color:var(--color-muted)]">Whether this wallet sealed a score here could not be read.</p>;
  }

  if (!yours.committed) {
    return <p className="text-detail text-[color:var(--color-muted)]">This wallet has not sealed a score on this dispute.</p>;
  }

  if (yours.revealed === true) {
    return (
      <p className="text-detail">
        You revealed <span className="tabular font-semibold">{yours.score}</span> on this dispute.{' '}
        {yours.rewarded === true ? 'Your score held and is in the fee split.' : ''}
      </p>
    );
  }

  return (
    <p className="text-detail" style={{ color: 'var(--color-state-attention)' }}>
      You have a sealed score on this dispute and it is not revealed yet.
    </p>
  );
}

function Action({
  dispute,
  config,
  resolverFeeBps,
  chainTime,
  account,
  registry,
  standing,
  blockedBy,
  onDone,
}: {
  readonly dispute: DisputeRow;
  readonly config: OracleConfig;
  readonly resolverFeeBps: number | undefined;
  readonly chainTime: Date;
  readonly account: Address | undefined;
  readonly registry: Address;
  readonly standing: {
    readonly status: number | undefined;
    readonly bond: bigint | undefined;
    readonly floor: bigint | undefined;
    readonly barred: boolean | undefined;
  } | undefined;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
}) {
  if (dispute.phase === 'finalized' || dispute.phase === 'failed' || dispute.phase === 'unknown') return null;

  if (dispute.phase === 'ruling') {
    return (
      <div className="space-y-3 border-t border-[color:var(--color-line)] pt-4">
        {closeLines(dispute, config, resolverFeeBps, chainTime).map((line) => (
          <p key={line} className="text-sm">
            {line}
          </p>
        ))}
        {account === undefined ? (
          <p className="text-detail text-[color:var(--color-muted)]">
            Connect a wallet to make this call. Anyone can, bonded or not. Until somebody does, the money stays locked
            and the bonds behind every sealed score stay locked with it.
          </p>
        ) : (
          <CloseForm dispute={dispute} registry={registry} blockedBy={blockedBy} onDone={onDone} />
        )}
      </div>
    );
  }

  if (account === undefined) {
    return (
      <p className="text-detail text-[color:var(--color-muted)]">
        Connect a bonded wallet to take part. Everything above is public and needs no wallet.
      </p>
    );
  }

  if (dispute.phase === 'commit') {
    const check = commitCheck(
      { status: dispute.status, commitEndsAt: dispute.commitEndsAt, revealEndsAt: dispute.revealEndsAt, commitCount: dispute.commitCount, revealCount: dispute.revealCount },
      config,
      {
        status: standing?.status,
        bond: standing?.bond,
        floor: standing?.floor,
        barred: standing?.barred,
        committed: dispute.yours?.committed,
      },
      dispute.phase,
    );

    if (!check.allowed) {
      return <p className="text-detail text-[color:var(--color-muted)]">{commitBlockerLine(check.blocker, config)}</p>;
    }

    return (
      <CommitForm dispute={dispute} config={config} account={account} registry={registry} blockedBy={blockedBy} onDone={onDone} />
    );
  }

  if (dispute.phase === 'reveal') {
    const check = revealCheck(
      { status: dispute.status, commitEndsAt: dispute.commitEndsAt, revealEndsAt: dispute.revealEndsAt, commitCount: dispute.commitCount, revealCount: dispute.revealCount },
      { committed: dispute.yours?.committed, revealed: dispute.yours?.revealed },
      new Date(),
    );

    if (!check.allowed) {
      return <p className="text-detail text-[color:var(--color-muted)]">{revealBlockerLine(check.blocker)}</p>;
    }

    return <RevealForm dispute={dispute} account={account} registry={registry} blockedBy={blockedBy} onDone={onDone} />;
  }

  return null;
}

/**
 * The two ways a dispute ends, and which one the registry will take.
 *
 * Both are permissionless and both release the escrow's lock, which is the property that matters:
 * money that a stalled panel could strand is worse than a panel that never rules. The card names
 * the condition that decided which call is on offer, so nobody presses the other one and pays for
 * a revert to find out.
 */
function CloseForm({
  dispute,
  registry,
  blockedBy,
  onDone,
}: {
  readonly dispute: DisputeRow;
  readonly registry: Address;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const finalising = dispute.exit === 'finalize';

  if (dispute.exit === 'none') return null;

  return (
    <div className="space-y-3">
      <TxButton
        label={finalising ? 'Finalise the ruling' : 'Close it without a ruling'}
        tone={finalising ? 'primary' : 'secondary'}
        blockedBy={blockedBy}
        send={() =>
          writeContractAsync({
            address: registry,
            abi: oracleRegistryAbi,
            functionName: finalising ? 'finalize' : 'failDispute',
            args: [dispute.id],
          }).catch((caught: unknown) => {
            throw resolverFailure(caught, { action: finalising ? 'Finalise the ruling' : 'Close the dispute' });
          })
        }
        onContinue={onDone}
      />
      <p className="text-detail text-[color:var(--color-muted)]">
        Anyone can make this call, resolver or not. Until somebody does, the money stays locked and the bonds behind
        every sealed score stay locked with it.
      </p>
    </div>
  );
}

/**
 * Which exit the registry will take, what it does to the money, and what it does to the bonds.
 *
 * Three sentences, each computed against this dispute. The two claims this
 * screen used to make in the abstract were both wrong in the case it was printed on: a refund of
 * 10,000 basis points is not a whole refund, because `Escrow._split` takes the resolver fee off
 * the lock before it divides what is left; and "nobody is slashed" holds only while the reveal
 * window is still open, because `failDispute` decides the silence slash off the clock alone.
 */
function closeLines(
  dispute: DisputeRow,
  config: OracleConfig,
  resolverFeeBps: number | undefined,
  now: Date,
): readonly string[] {
  if (dispute.exit === 'finalize') {
    return [
      `${dispute.revealCount} of ${dispute.commitCount} sealed scores are revealed, which clears the quorum of ${config.quorum}. Finalising takes the median of them, sets the payer's refund from it, and releases the lock.`,
      feeLine(dispute, resolverFeeBps, 'The median decides how much of what is left goes back to the payer.'),
      `A resolver who sealed a score and never revealed it is slashed here, and so is one whose revealed score sits more than ${config.maxDeviation} points from the median. If most of the revealed scores sit outside that band the panel is treated as having no centre, nobody is slashed for disagreeing, and the payer is refunded everything the fee left.`,
    ];
  }

  return [
    dispute.commitCount < config.quorum
      ? `Only ${dispute.commitCount} ${dispute.commitCount === 1 ? 'resolver' : 'resolvers'} sealed a score and the quorum is ${config.quorum}, so this panel can never reach a result. Closing it releases the lock.`
      : `${dispute.revealCount} of ${dispute.commitCount} sealed scores were revealed and the quorum is ${config.quorum}, so there is no median to rule on. Closing it releases the lock.`,
    refundLine(dispute, resolverFeeBps),
    slashLine(dispute, config, now),
  ];
}

/** What the payer gets back, and the fee that is taken before the refund is worked out. */
function refundLine(dispute: DisputeRow, resolverFeeBps: number | undefined): string {
  const settlement = dispute.settlement;
  const bondBack =
    settlement === undefined || settlement.bond === 0n
      ? ''
      : ` The ${usdExact(settlement.bond)} contest bond goes back to the disputer in full.`;

  if (settlement === undefined || resolverFeeBps === undefined) {
    return `The payer is refunded the lock less the escrow's resolver fee, which comes off the top before the refund is worked out and is charged whether or not this panel produced anybody to pay it to. The amounts behind it were not read here.${bondBack}`;
  }

  const split = splitSettlement(settlement.amount, 10_000, resolverFeeBps, 0);
  return `The payer is refunded ${usdExact(split.refunded)} of the ${usd(settlement.amount)} held. The other ${usdExact(split.resolverFee)} is the ${bps(resolverFeeBps)} resolver fee, taken off the lock before the refund is worked out and charged whether or not this panel produced anybody to pay it to.${bondBack}`;
}

/** The same fee, on the branch where the median has not been taken yet. */
function feeLine(dispute: DisputeRow, resolverFeeBps: number | undefined, tail: string): string {
  const settlement = dispute.settlement;
  if (settlement === undefined || resolverFeeBps === undefined) {
    return `The escrow takes its resolver fee off the lock before it applies the refund, so the payer can never be refunded the whole of it. The amounts behind it were not read here. ${tail}`;
  }

  const split = splitSettlement(settlement.amount, 10_000, resolverFeeBps, 0);
  return `The escrow takes a ${bps(resolverFeeBps)} resolver fee, ${usdExact(split.resolverFee)} of the ${usd(settlement.amount)} held, off the lock before it applies the refund. ${tail}`;
}

/** Whose bond closing this dispute costs, decided by the clock the registry reads. */
function slashLine(dispute: DisputeRow, config: OracleConfig, now: Date): string {
  const { silent, counted } = silenceSlash(dispute, now);
  const share = bps(config.slashBps);
  const scores = silent === 1 ? 'sealed score' : 'sealed scores';

  if (silent === 0) {
    return 'Nobody is slashed. Every sealed score on this dispute was revealed, and a revealed score is never slashed on a close that produces no median.';
  }

  if (dispute.revealEndsAt === null) {
    return `The reveal window on this dispute did not read. The registry slashes a sealed score that was never revealed once that window has closed, so closing now may cost the ${silent} silent ${scores} ${share} of the bond behind each.`;
  }

  if (counted) {
    return `The reveal window closed ${formatRelative(dispute.revealEndsAt, now)}, so silence counts. Closing now slashes the ${silent} ${scores} that ${silent === 1 ? 'was' : 'were'} never revealed, ${share} of the bond behind each.`;
  }

  return `Nobody is slashed by closing it now: the reveal window runs for another ${formatRelative(dispute.revealEndsAt, now).replace(/^in /u, '')} and a resolver cannot be silent in a window they can still speak in. Closing it after that moment slashes the ${silent} ${scores} still unrevealed, ${share} of the bond behind each.`;
}

function commitBlockerLine(blocker: CommitBlocker | null, config: OracleConfig): string {
  switch (blocker) {
    case 'already-committed':
      return 'You have already sealed a score on this dispute. Come back to reveal it when the commit window closes.';
    case 'panel-full':
      return `The panel is full at ${config.maxVoters} sealed scores. Nothing frees a seat on this dispute.`;
    case 'not-active':
      return 'This wallet is not an active resolver. Post a bond, or cancel an exit in progress, before sealing a score.';
    case 'bond-short':
      return 'This wallet’s bond is under the floor the staking pool holds for it, so the registry will not take a vote. Top the bond back up first.';
    case 'barred':
      return 'Governance has barred this address from bonding, so it cannot vote at any amount.';
    case 'window-closed':
      return 'The commit window on this dispute has closed.';
    case 'unread':
      return 'This wallet’s standing on the registry could not be read, so whether it can vote here is unknown. Nothing has changed on chain; only the reading failed.';
    default:
      return '';
  }
}

function revealBlockerLine(blocker: RevealBlocker | null): string {
  switch (blocker) {
    case 'nothing-sealed':
      return 'This wallet sealed no score on this dispute, so there is nothing to reveal. Only the resolvers who committed in time take part in the ruling.';
    case 'already-revealed':
      return 'Your score is revealed and on the registry. Nothing further is owed here until somebody closes the dispute.';
    case 'commit-window-open':
      return 'The commit window is still open, so nothing can be revealed yet.';
    case 'window-closed':
      return 'The reveal window has closed.';
    case 'unread':
      return 'Whether this wallet sealed a score here could not be read. Nothing has changed on chain; only the reading failed.';
    default:
      return '';
  }
}
