'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { Instant } from '@/components/instant';
import { Card, Section, Skeleton } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { Unread } from '@/components/status';
import { spellDuration } from '@/lib';
import { bps, formatBrsr, usdExact } from '@/money';
import { useSystemState } from '@/state';
import { ConnectModal } from '@/wallet';

import { BondPanel } from './bond-panel';
import type { DisputeRow, ResolverDesk } from './desk';
import { DisputeList, SettledList } from './dispute-list';
import { ROSTER_SEATS, ResolverStatus } from './phases';
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
        description="Bonded resolvers decide contested settlements by sealed vote."
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
              When a payer contests a settlement, the money stays locked until the dispute closes. Each resolver posts a
              BRSR bond, seals a score, then reveals it, and the median sets how much goes back to the payer. Resolvers
              whose scores hold share the resolver fee. A sealed score that is never revealed, or one far from the
              median, loses part of the bond.
            </p>
            {/*
              The chain clock, not the browser's. Every window on this page is judged against it,
              and a reader comparing a countdown here with the one in their wallet needs to know
              which clock the deadline belongs to.
            */}
            <span className="text-note text-[color:var(--color-muted)]">
              {desk ? (
                <>
                  Updated <Instant at={desk.readAt} relative local />. Chain time <Instant at={desk.chainTime} />.
                </>
              ) : (
                <Skeleton width={220} />
              )}
            </span>
          </div>
        </Card>
        <ErrorSurface error={error} action="Reading open disputes" onRetry={refresh} />
      </Section>

      {isLoading && desk === undefined && (
        <Card>
          <Skeleton height={80} />
        </Card>
      )}

      {desk !== undefined && !desk.complete && (
        <Unread onRetry={refresh}>
          Part of this page could not be read right now, so empty lists and zeros below may be incomplete.
        </Unread>
      )}

      <Operator commitWindow={desk?.config?.commitWindow} bench={desk?.resolverCount} />

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

/** Bursar's own resolvers, the three the ruling policy names. */
const OPERATED = 3;
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/**
 * Who the panel is, said before anything else a reader could weigh a ruling by. While every bonded
 * resolver is Bursar's, Bursar is the arbiter of every dispute here. A resolver governance admits
 * beside them changes that sentence, so the bench the registry counts decides which one is shown.
 */
function Operator({ commitWindow, bench }: { readonly commitWindow: bigint | undefined; readonly bench: number | undefined }) {
  // The ruling service stops counting evidence halfway through the sealing window.
  const cutoff = commitWindow === undefined ? 'halfway through the sealing window' : `${spellDuration(Number(commitWindow) / 2)} after the dispute opens`;
  const shared = bench !== undefined && bench > OPERATED;
  return (
    <Card title="Who rules today">
      <div className="max-w-3xl space-y-3 text-sm">
        {shared ? (
          <p>
            Bursar operates three of the {WORDS[bench] ?? bench} resolvers bonded here. Its three vote by the published policy and cast
            the same score, and the reasons are published on the dispute once the votes are revealed.
          </p>
        ) : (
          <p>
            Bursar operates all three bonded resolvers, so Bursar decides every dispute here. Each ruling follows the
            published policy, the three resolvers cast the same score, and the reasons are published on the dispute once
            the votes are revealed.
          </p>
        )}
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
      <StatGrid columns={account ? 4 : 3}>
        <Stat
          label="Open disputes"
          value={open === undefined ? unread : open.toString()}
          hint={open === 0 ? 'Nothing is contested right now' : 'Contested settlements not yet closed'}
          level={open === undefined ? 'unknown' : undefined}
        />
        {account && (
          <Stat
            label="Reveals you owe"
            value={owed === undefined ? unread : owed.toString()}
            hint="Sealed scores to reveal now. A missed reveal costs part of the bond."
            level={owed !== undefined && owed > 0 ? 'blocked' : undefined}
          />
        )}
        <Stat
          label="Ready to close"
          value={closable === undefined ? unread : closable.toString()}
          hint="Voting is over. Anyone can close these to release the money."
          level={closable !== undefined && closable > 0 ? 'attention' : undefined}
        />
        {account ? (
          <Stat
            label="Yours to claim"
            value={standing?.rewards === undefined ? unread : usdExact(standing.rewards)}
            hint="Resolver fees earned on settled disputes, in USDG"
          />
        ) : (
          <Stat
            label="Resolvers"
            value={desk?.resolverCount === undefined ? unread : desk.resolverCount.toString()}
            hint={desk?.totalBonded === undefined ? 'Bonded in BRSR' : `${formatBrsr(desk.totalBonded)} BRSR bonded between them`}
          />
        )}
      </StatGrid>

      {account && standing?.status === ResolverStatus.None && (
        <p className="mt-4 text-detail text-[color:var(--color-muted)]">
          This wallet has no bond, so it cannot seal a score. Anyone can still close a dispute once voting ends.
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
    <Section title="How a ruling works" description="Live from the dispute registry.">
      <Card>
        <StatGrid columns={4}>
          <Stat
            label="Sealing window"
            value={config === undefined ? unread : spellDuration(Number(config.commitWindow))}
            hint="Opens when the payer contests"
          />
          <Stat
            label="Reveal window"
            value={config === undefined ? unread : spellDuration(Number(config.revealWindow))}
            hint="Opens when the sealing window closes"
          />
          <Stat
            label="Quorum"
            value={config === undefined ? unread : config.quorum.toString()}
            hint={
              config === undefined || config.maxVoters >= ROSTER_SEATS
                ? 'Revealed scores a ruling needs'
                : `Revealed scores a ruling needs, from a panel of up to ${config.maxVoters}`
            }
          />
          <Stat
            label="Slash"
            value={config === undefined ? unread : bps(config.slashBps)}
            hint={config === undefined ? 'Of the bond' : `Of the bond, for an unrevealed score or one over ${config.maxDeviation} points from the median`}
          />
        </StatGrid>

        <div className="mt-5 max-w-3xl space-y-3 text-sm">
          <p>
            A dispute ends one of two ways, and once the reveal window closes, anyone can end it. A ruling takes the
            median of the revealed scores and splits the money by it, after the resolver fee
            {desk?.resolverFeeBps === undefined ? '' : ` of ${bps(desk.resolverFeeBps)}`}. If too few resolvers reveal,
            the dispute closes without a ruling: the payment goes back on hold for the payee with a new deadline, the
            contest bond is returned, and no fee is taken. If the scores are too far apart to rule on, the payer gets the
            full amount back, also with no fee. If the USDG issuer blocks a payout, the escrow holds it for the recipient
            to claim, so no party can hold up a ruling.
          </p>
          <p>
            Every bonded resolver can vote on every dispute, up to {ROSTER_SEATS} resolvers, so no one can fill a panel
            ahead of the rest. The payer, the payee and the principal behind the paying account cannot vote on their own
            dispute.
          </p>
          <p>
            Bonds are posted in BRSR. The staking pool sets the floor, the smallest bond that can vote, and every vote
            checks it. Governance can raise the floor for everyone or for one address, which benches a resolver at once
            without touching their bond. Topping up brings them back.
            {desk?.totalBonded === undefined
              ? ''
              : ` ${formatBrsr(desk.totalBonded)} BRSR is bonded across ${desk.resolverCount ?? 0} ${
                  desk.resolverCount === 1 ? 'resolver' : 'resolvers'
                }.`}
          </p>
        </div>
      </Card>
    </Section>
  );
}
