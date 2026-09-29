'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { Instant } from '@/components/instant';
import { Card, Section, Skeleton } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { Unread } from '@/components/status';
import { formatDuration } from '@/lib';
import { bps, formatBrsr, usdExact } from '@/money';
import { useSystemState } from '@/state';
import { ConnectModal } from '@/wallet';

import { BondPanel } from './bond-panel';
import type { DisputeRow, ResolverDesk } from './desk';
import { DisputeList, SettledList } from './dispute-list';
import { ResolverStatus } from './phases';
import { countOpen } from './reading';
import { RewardsPanel } from './rewards-panel';
import { POLICY_PATH } from './ruling';
import { UnbondPanel } from './unbond-panel';
import { useResolverDesk } from './use-desk';

/**
 * The resolver desk.
 *
 * Everything public renders without a wallet: the open panel, the windows, the bond floor and what
 * ruling pays. A wallet is needed to act, never to read. That is the right shape for a role
 * somebody is deciding whether to take on, and it is the shape the contracts already have.
 */
export function ResolverView() {
  const [connecting, setConnecting] = useState(false);
  const { account, desk, isLoading, isFetching, error, refresh } = useResolverDesk();

  // Connectivity, the settlement asset and the fee float decide whether a write can be sent at all.
  // Reading them here is what lets every button name whichever one is in the way.
  const system = useSystemState();
  const writeBlockers = [system.connectivity, system.asset, system.funding];

  return (
    <div className="space-y-10">
      <Section
        title="Ruling on disputes"
        description="Bonded resolvers decide contested settlements by sealed vote. This is the desk that runs it."
        actions={
          <div className="flex items-center gap-2">
            {account === undefined && (
              <Button size="sm" onClick={() => setConnecting(true)}>
                Connect a wallet
              </Button>
            )}
            <Button size="sm" onClick={refresh} disabled={isFetching}>
              {isFetching ? 'Reading' : 'Read again'}
            </Button>
          </div>
        }
      >
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-sm">
              A payer who disputes a settlement freezes it. Resolvers who have posted a BRSR bond seal a score, reveal
              it, and the median decides how much of the locked money goes back. Ruling well pays a cut of the
              settlement. Staying silent after sealing a score, or landing far from the panel, costs part of the bond.
            </p>
            {/*
              The chain clock, not the browser's. Every window on this page is judged against it,
              and a reader comparing a countdown here with the one in their wallet needs to know
              which clock the deadline belongs to.
            */}
            <span className="text-note text-[color:var(--color-muted)]">
              {desk ? (
                <>
                  Read <Instant at={desk.readAt} relative /> against a chain clock of{' '}
                  <Instant at={desk.chainTime} />, in {desk.requests} {desk.requests === 1 ? 'request' : 'requests'}.
                </>
              ) : (
                <Skeleton width={220} />
              )}
            </span>
          </div>
        </Card>
        <ErrorSurface error={error} action="read the dispute registry" onRetry={refresh} />
      </Section>

      {isLoading && desk === undefined && (
        <Card>
          <Skeleton height={80} />
        </Card>
      )}

      {desk !== undefined && !desk.complete && (
        <Unread onRetry={refresh}>
          {desk.failures} {desk.failures === 1 ? 'call in this reading went' : 'calls in this reading went'} unanswered.
          Anything showing as empty or zero below is unknown, not clear. Nothing has changed on chain; only the reading
          failed.
        </Unread>
      )}

      <Operator commitWindow={desk?.config?.commitWindow} />

      <Headline desk={desk} account={account !== undefined} />

      <BondPanel desk={desk} account={account} blockedBy={writeBlockers} onDone={refresh} />

      <DisputeList
        desk={desk}
        error={error}
        account={account}
        blockedBy={writeBlockers}
        onDone={refresh}
        onRetry={refresh}
      />

      <RewardsPanel desk={desk} account={account} blockedBy={writeBlockers} onDone={refresh} />

      <UnbondPanel desk={desk} account={account} blockedBy={writeBlockers} onDone={refresh} />

      <Rules desk={desk} />

      <SettledList desk={desk} />

      <ConnectModal open={connecting} onClose={() => setConnecting(false)} />
    </div>
  );
}

/**
 * Who the panel is, said before anything else a reader could weigh a ruling by. Every bonded
 * resolver on this registry is Bursar's, which makes Bursar the arbiter of every dispute here.
 */
function Operator({ commitWindow }: { readonly commitWindow: bigint | undefined }) {
  // The ruling service stops counting evidence halfway through the sealing window.
  const cutoff = commitWindow === undefined ? 'halfway through the sealing window' : `${formatDuration(Number(commitWindow) / 2)} after the dispute opens`;
  return (
    <Card title="Who rules today">
      <div className="max-w-3xl space-y-3 text-sm">
        <p>
          All three bonded resolvers on this registry are operated by Bursar, so Bursar is the arbiter of every dispute it hears.
          Each ruling follows the published policy, all three resolvers cast the same score, and the reasons are published on
          the dispute once the votes are revealed.
        </p>
        <p>
          A provider who delivered can send signed evidence from its desk until {cutoff}. Bursar never
          overrides a dispute in which it is the payer or the provider.
        </p>
        <p>
          <Link href={POLICY_PATH} className="underline underline-offset-2">
            Read the ruling policy
          </Link>
        </p>
      </div>
    </Card>
  );
}

function Headline({ desk, account }: { readonly desk: ResolverDesk | undefined; readonly account: boolean }) {
  const unread = desk === undefined ? 'Reading' : 'Not read';
  // No count is offered from a reading that could not place a dispute in a phase. A headline
  // figure is believed harder than the list under it, and "0 reveals you owe" from a failed read
  // is the one sentence on this page that costs a resolver part of their bond.
  const open = countOpen(desk);
  // Only the current registry takes a call from this page, so only its disputes count as work.
  const owed = countOpen(desk, (row) => row.deployment.current && revealOwed(row));
  const closable = countOpen(desk, (row) => row.deployment.current && row.exit !== 'none');
  const standing = desk?.standing;

  return (
    <Card>
      <StatGrid columns={4}>
        <Stat
          label="Open disputes"
          value={open === undefined ? unread : open.toString()}
          hint={open === 0 ? 'Nothing is contested right now' : 'Contested settlements the registry has not closed'}
          level={open === undefined ? 'unknown' : undefined}
        />
        <Stat
          label="Reveals you owe"
          value={account ? (owed === undefined ? unread : owed.toString()) : 'No wallet'}
          hint="Sealed scores whose reveal window is open. Missing one is slashed."
          level={owed !== undefined && owed > 0 ? 'blocked' : undefined}
        />
        <Stat
          label="Ready to close"
          value={closable === undefined ? unread : closable.toString()}
          hint="The vote is over and the money is still locked. Anyone can close these."
          level={closable !== undefined && closable > 0 ? 'attention' : undefined}
        />
        <Stat
          label="Yours to claim"
          value={account ? (standing?.rewards === undefined ? unread : usdExact(standing.rewards)) : 'No wallet'}
          hint="Resolver fees from disputes that have settled, in USDG"
        />
      </StatGrid>

      {account && standing?.status === ResolverStatus.None && (
        <p className="mt-4 text-detail text-[color:var(--color-muted)]">
          This wallet holds no bond, so it cannot seal a score. Everything on this page is still readable, and closing a
          dispute that has finished voting is open to anyone, bonded or not.
        </p>
      )}
    </Card>
  );
}

function revealOwed(row: DisputeRow): boolean {
  return row.phase === 'reveal' && row.yours?.committed === true && row.yours.revealed === false;
}

/** The parameters the registry holds, read live, because governance moves all of them. */
function Rules({ desk }: { readonly desk: ResolverDesk | undefined }) {
  const config = desk?.config;
  // A parameter still being fetched and one the registry refused to answer are different answers,
  // and on a page whose whole subject is deadlines the second is worth saying out loud.
  const unread = desk === undefined ? 'Reading' : 'Not read';

  return (
    <Section title="How a ruling works" description="Every figure here is read from the registry on this page load.">
      <Card>
        <StatGrid columns={4}>
          <Stat
            label="Sealing window"
            value={config === undefined ? unread : formatDuration(Number(config.commitWindow))}
            hint="From the moment the payer disputes"
          />
          <Stat
            label="Reveal window"
            value={config === undefined ? unread : formatDuration(Number(config.revealWindow))}
            hint="Opens when the sealing window closes"
          />
          <Stat
            label="Quorum"
            value={config === undefined ? unread : `${config.quorum} of ${config.maxVoters}`}
            hint="Revealed scores needed for a ruling, and the size of the panel"
          />
          <Stat
            label="Slash"
            value={config === undefined ? unread : bps(config.slashBps)}
            hint={config === undefined ? 'Of the bond' : `Of the bond, for silence or a score over ${config.maxDeviation} points from the median`}
          />
        </StatGrid>

        <div className="mt-5 max-w-3xl space-y-3 text-sm">
          <p>
            A dispute has three exits and every one of them releases the lock. Finalising takes the median of the
            revealed scores and splits the money by it. Closing without a ruling sends the lock back to the payer and is
            what happens when too few resolvers revealed. Both of those charge the resolver fee first
            {desk?.resolverFeeBps === undefined ? '' : `, ${bps(desk.resolverFeeBps)} of the lock`}, and the refund is
            worked out on what is left, so a payer is never refunded the whole of a disputed payment. If neither is
            called, the escrow&rsquo;s own timeout returns the lock to the payer with no fee taken at all. A panel that
            could strand a payer&rsquo;s funds would be worse than no panel.
          </p>
          <p>
            The bond is BRSR and the floor that admits it lives in the staking pool, read live on every vote. Governance
            can raise that floor for everyone or for one address, which benches a resolver in the block the change lands
            without touching the bond itself. Topping up is how they return. Nothing in the registry reads the price of
            BRSR, so what a bond is worth against the settlements it backs is yours to watch.
          </p>
          <p>
            These contracts have had no external review.{' '}
            {desk?.totalBonded === undefined
              ? ''
              : `${formatBrsr(desk.totalBonded)} BRSR is bonded across ${desk.resolverCount ?? 0} ${
                  desk.resolverCount === 1 ? 'resolver' : 'resolvers'
                } today.`}
          </p>
        </div>
      </Card>
    </Section>
  );
}
