'use client';

import { useState } from 'react';

import { TOKEN_ADDRESSES, isZeroAddress, brsrAbi, sameAddress, stakingAbi } from '@/chain';
import { collateralLane } from '@/chain/collateral';
import { Address } from '@/components/address';
import { AmountInput } from '@/components/amount-input';
import { Countdown, Instant } from '@/components/instant';
import { Card, EmptyState, Field, FieldGrid, Section } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { Table } from '@/components/table';
import { TxButton } from '@/components/tx-button';
import { formatDuration } from '@/lib';
import { ZERO_BRSR, bps, formatBrsr, usdExact } from '@/money';
import type { Brsr } from '@/money';
import type { AnyState } from '@/state';

import { rebateReason, rebateSentence } from './rebate';
import type { TokenPageData } from './use-token-page';
import { useWriteContract } from '@/wallet/write';

/**
 * The staking surface.
 *
 * What a staker is exposed to comes before what the position pays, and both come before the
 * controls. The credit pool writes bad debt off against its own lender and never calls
 * `Staking.slash`, so the page says stake is not first-loss cover rather than implying it is.
 */
export function StakingSection({ data, blockedBy }: { readonly data: TokenPageData; readonly blockedBy: readonly AnyState[] }) {
  const pool = data.token?.pool;
  const position = data.token?.position;
  const creditLane = data.extras?.creditManager;
  const creditLaneLive = creditLane !== undefined && !isZeroAddress(creditLane);
  const creditPool = collateralLane()?.CreditPool;
  const spreadReachesStakers = creditLaneLive && creditPool !== undefined && sameAddress(creditLane, creditPool);
  const unread = unreadWord(data);
  const laneUnread = data.extras === undefined ? 'Reading' : 'Not read';

  const maturesAt =
    position?.unbondingAt && pool?.unbondingPeriod !== undefined
      ? new Date(position.unbondingAt.getTime() + Number(pool.unbondingPeriod) * 1000)
      : null;

  return (
    <Section title="Staking" description="Where the collateralized lane's spread and the buyback arrive, and the fee rebate a staked balance earns.">
      <Card title="What staking here exposes you to">
        <div className="max-w-3xl space-y-3 text-sm">
          <p>
            Staked BRSR does not cover credit defaults. The collateralized lane lends USDG from a separate credit pool
            against posted stock and treasury tokens. When a line&rsquo;s collateral cannot repay its debt, the shortfall
            is written off inside that credit pool and falls on the pool&rsquo;s lender, not on stakers. The credit pool
            has no call that takes stake.
          </p>
          <p>
            The staking contract lets exactly one address take stake: the credit manager governance names. Naming a
            different one is a proposal that waits out the 48-hour delay and appears on the governance page before it
            can run. What staking does carry is the BRSR price itself, which can fall, and the exit wait below.
          </p>
          <p>
            In exchange the pool is where the collateralized lane&rsquo;s spread is paid, in USDG. The buyback
            compounds purchased BRSR into the same pool. A staked balance also takes a rebate off the facilitator fee
            on that party&rsquo;s own settlements. None of these is a rate. None is promised. What arrives depends on
            how much the system is used.
          </p>
        </div>
      </Card>

      <Card title="What is switched on today" description="Read from the staking contract, not from a plan.">
        <FieldGrid columns={3}>
          <Field
            label="Spread from the collateralized lane"
            hint={
              spreadReachesStakers
                ? 'The credit pool is named here, so its spread is paid to stakers in USDG.'
                : 'The lane is lending. Its spread waits in the credit pool until governance names the pool here; that proposal is on the governance page.'
            }
          >
            {creditLane === undefined ? (
              laneUnread
            ) : spreadReachesStakers ? (
              'Reaching stakers'
            ) : creditLaneLive ? (
              <Address value={creditLane} />
            ) : (
              'Waiting on governance'
            )}
          </Field>
          {/*
            The hint here used to read "a staked balance earns a rebate of zero until this table is
            set". The table is set, and that sentence was the only explanation of a zero rebate
            anywhere on the page, so a staker reading 0% beside it was told the wrong cause. What a
            tier is measured against is the part that is not obvious, and it belongs here.
          */}
          <Field label="Fee rebate tiers" hint="Each tier is measured against active stake, so a pending withdrawal counts against it.">
            {pool?.tiers === undefined ? unread : pool.tiers.length === 0 ? 'None set' : `${pool.tiers.length} tiers`}
          </Field>
          <Field label="Exit wait" hint="How long a withdrawal request sits before it can complete.">
            {pool?.unbondingPeriod === undefined ? unread : formatDuration(Number(pool.unbondingPeriod))}
          </Field>
          <Field label="In the pool">
            <span className="tabular">{amountOr(pool?.totalStaked, unread)}</span>
          </Field>
          <Field label="Reward asset" hint="Spread is distributed in the settlement asset, not in BRSR.">
            {pool?.rewardToken === undefined ? unread : <Address value={pool.rewardToken} label="USDG" />}
          </Field>
          <Field label="Brake" hint="Deposits and withdrawals stop while paused. Claiming spread stays open.">
            {pool?.paused === undefined ? unread : pool.paused ? 'Paused' : 'Running'}
          </Field>
        </FieldGrid>

        {pool?.tiers && pool.tiers.length > 0 && (
          <div className="mt-4">
            <Table
              rows={[...pool.tiers]}
              rowKey={(_, index) => `${index}`}
              caption="Fee rebate by staked balance"
              columns={[
                { key: 'min', header: 'Staked at least', align: 'right', cell: (row) => <span className="tabular">{formatBrsr(row.minStake)} BRSR</span> },
                { key: 'rebate', header: 'Off the facilitator fee', align: 'right', cell: (row) => <span className="tabular">{bps(row.rebateBps)}</span> },
              ]}
            />
          </div>
        )}
      </Card>

      {data.account === undefined ? (
        <EmptyState title="Connect a wallet to stake or to see a position.">
          Everything above is read from the contract and does not need a wallet. A position does.
        </EmptyState>
      ) : (
        <>
          <Card title="Your position">
            <StatGrid columns={4}>
              <Stat
                label="Active stake"
                value={amountOr(position?.activeStake, unread)}
                hint="Earning spread and counted for the rebate."
              />
              <Stat
                label="Held in the pool"
                value={amountOr(position?.stakedValue, unread)}
                hint="Including anything already on its way out."
              />
              <Stat
                label="Spread to claim"
                value={position?.pendingRewards === undefined ? unread : usdExact(position.pendingRewards)}
                hint="Paid in USDG. Claimable while the pool is paused."
              />
              <Stat
                label="Your fee rebate"
                value={position?.rebateBps === undefined ? unread : bps(position.rebateBps)}
                hint="Applied to the facilitator fee on your own settlements."
              />
            </StatGrid>

            {/*
              Why that figure is that figure, read off the same three numbers the contract reads.
              The tiers, the active stake and the stake held are all on this card already, and
              nothing on the page joined them to the rebate.
            */}
            <p className="mt-4 max-w-3xl text-detail text-[color:var(--color-muted)]">
              {rebateSentence(
                rebateReason(pool?.tiers, {
                  rebateBps: position?.rebateBps,
                  activeStake: position?.activeStake,
                  stakedValue: position?.stakedValue,
                }),
              )}
            </p>

            <div className="mt-4">
              <FieldGrid columns={3}>
                <Field label="In your wallet">
                  <span className="tabular">{amountOr(data.token?.balance, unread)}</span>
                </Field>
                <Field label="Shares" hint="What you own is a fraction of the pool, not a balance inside it.">
                  <span className="tabular">{position === undefined ? unread : position.shares.toString()}</span>
                </Field>
                <Field label="Staking contract">
                  <Address value={TOKEN_ADDRESSES.Staking} />
                </Field>
              </FieldGrid>
            </div>
          </Card>

          <StakeCard data={data} blockedBy={blockedBy} />
          <ExitCard data={data} blockedBy={blockedBy} maturesAt={maturesAt} />
          <ClaimCard data={data} blockedBy={blockedBy} />
        </>
      )}
    </Section>
  );
}

function StakeCard({ data, blockedBy }: { readonly data: TokenPageData; readonly blockedBy: readonly AnyState[] }) {
  const [text, setText] = useState('');
  const [atomic, setAtomic] = useState<bigint | undefined>(undefined);
  const { writeContractAsync } = useWriteContract();

  const balance = data.token?.balance;
  const allowance = data.extras?.allowance;
  const paused = data.token?.pool?.paused;

  const amount = atomic ?? 0n;
  const overBalance = balance !== undefined && amount > balance;
  // An unread allowance is not a zero allowance. Sending the deposit on that assumption is how a
  // wallet ends up signing a transaction that reverts on transferFrom. The balance and the brake
  // are the same story: each one decides whether this deposit can land at all.
  const allowanceKnown = allowance !== undefined;
  const needsAllowance = allowanceKnown && amount > allowance;
  const ready = amount > 0n && !overBalance && paused === false && allowanceKnown && balance !== undefined;

  // Named only once both readings have landed, so a control that is off while the page is still
  // loading does not accuse a contract of failing to answer.
  const unreadReason =
    data.token === undefined || data.extras === undefined
      ? undefined
      : balance === undefined
      ? 'the BRSR balance in this wallet'
      : !allowanceKnown
      ? 'what the staking contract may already move from this wallet'
      : paused === undefined
      ? 'whether the pool is taking deposits'
      : undefined;

  return (
    <Card title="Stake" description="Two steps: let the contract move the tokens, then deposit them.">
      <div className="max-w-md">
        <AmountInput
          label="Amount to stake"
          asset="BRSR"
          value={text}
          onChange={(next, value) => {
            setText(next);
            setAtomic(value);
          }}
          max={balance === undefined ? undefined : { atomic: balance, label: 'All of it' }}
          problem={overBalance ? 'More than this wallet holds.' : undefined}
          hint="Once staked, leaving takes the exit wait above."
          disabled={paused === true}
        />
      </div>

      <div className="mt-4">
        {/*
          Keyed apart because these are two different calls in one slot. Without the keys React
          keeps one button instance across the swap, and the allowance's confirmed state is still
          on screen under the label of the call that has not been made yet.
        */}
        {needsAllowance ? (
          <TxButton
            key="approve"
            label={`Allow ${formatBrsr(amount as Brsr)} BRSR`}
            tone="secondary"
            disabled={!ready}
            blockedBy={blockedBy}
            send={() =>
              writeContractAsync({
                address: TOKEN_ADDRESSES.BRSR,
                abi: brsrAbi,
                functionName: 'approve',
                args: [TOKEN_ADDRESSES.Staking, amount],
              })
            }
            onContinue={data.refresh}
          />
        ) : (
          <TxButton
            key="stake"
            label="Stake"
            disabled={!ready}
            blockedBy={blockedBy}
            send={() =>
              writeContractAsync({
                address: TOKEN_ADDRESSES.Staking,
                abi: stakingAbi,
                functionName: 'stake',
                args: [amount],
              })
            }
            onConfirmed={() => {
              setText('');
              setAtomic(undefined);
              data.refresh();
            }}
          />
        )}
      </div>

      {paused === true && <p className="mt-3 text-detail text-[color:var(--color-muted)]">Deposits are stopped while the pool is paused.</p>}
      {unreadReason !== undefined && (
        <p className="mt-3 text-detail text-[color:var(--color-muted)]">
          Staking is held back because {unreadReason} could not be read. Nothing has changed on chain; only the reading
          failed.
        </p>
      )}
      {allowance !== undefined && allowance > 0n && (
        <p className="mt-3 text-detail text-[color:var(--color-muted)]">
          The contract may currently move {formatBrsr(allowance)} BRSR from this wallet.
        </p>
      )}
    </Card>
  );
}

function ExitCard({
  data,
  blockedBy,
  maturesAt,
}: {
  readonly data: TokenPageData;
  readonly blockedBy: readonly AnyState[];
  readonly maturesAt: Date | null;
}) {
  const [text, setText] = useState('');
  const [atomic, setAtomic] = useState<bigint | undefined>(undefined);
  const { writeContractAsync } = useWriteContract();

  const position = data.token?.position;
  const pool = data.token?.pool;
  const paused = pool?.paused;
  const unread = unreadWord(data);

  if (position === undefined) {
    return (
      <Card title="Leaving">
        <p className="text-sm text-[color:var(--color-muted)]">
          {data.token === undefined
            ? 'Reading this position.'
            : 'The staking contract did not answer this position, so whether anything is staked is unknown.'}
        </p>
      </Card>
    );
  }

  const held = position.stakedValue;
  const shares = position.shares;
  const unbonding = position.unbondingShares;

  const requested = atomic ?? 0n;
  const overHeld = held !== undefined && requested > held;
  // Priced against this position's own holding, so a request for everything is exactly every share
  // and cannot round short of it. Pricing against the pool would leave dust behind.
  const sharesToExit = held === undefined || held === ZERO_BRSR || requested === 0n ? 0n : min((requested * shares) / held, shares);
  const matured = maturesAt !== null && maturesAt.getTime() <= Date.now();

  if (shares === 0n) {
    return (
      <Card title="Leaving">
        <p className="text-sm text-[color:var(--color-muted)]">Nothing staked, so there is nothing to withdraw.</p>
      </Card>
    );
  }

  if (unbonding > 0n) {
    return (
      <Card title="Leaving" description="One withdrawal request at a time.">
        <FieldGrid columns={3}>
          <Field label="Shares on their way out">
            <span className="tabular">{unbonding.toString()}</span>
          </Field>
          <Field label="Requested">
            <Instant at={position.unbondingAt} />
          </Field>
          <Field label={matured ? 'Ready since' : 'Can complete'}>
            {maturesAt === null ? unread : matured ? <Instant at={maturesAt} /> : <Countdown to={maturesAt} />}
          </Field>
        </FieldGrid>

        <p className="mt-4 max-w-3xl text-sm">
          These shares no longer earn spread. What they are worth in BRSR is decided when the withdrawal completes.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <TxButton
            label="Complete the withdrawal"
            disabled={!matured || paused !== false}
            blockedBy={blockedBy}
            send={() => writeContractAsync({ address: TOKEN_ADDRESSES.Staking, abi: stakingAbi, functionName: 'completeUnbond' })}
            onContinue={data.refresh}
          />
          <TxButton
            label="Cancel and stay in"
            tone="secondary"
            blockedBy={blockedBy}
            send={() => writeContractAsync({ address: TOKEN_ADDRESSES.Staking, abi: stakingAbi, functionName: 'cancelUnbond' })}
            onContinue={data.refresh}
          />
        </div>

        {paused === true && (
          <p className="mt-3 text-detail text-[color:var(--color-muted)]">
            Withdrawals are held while the pool is paused. Restarting it is a governance proposal.
          </p>
        )}
        {maturesAt === null && (
          <p className="mt-3 text-detail text-[color:var(--color-muted)]">
            The exit wait could not be read, so whether this withdrawal can complete yet is unknown and the control
            stays off until the next reading lands.
          </p>
        )}
        {paused === undefined && (
          <p className="mt-3 text-detail text-[color:var(--color-muted)]">
            Whether the pool is paused could not be read, and a withdrawal is refused while it is.
          </p>
        )}
      </Card>
    );
  }

  return (
    <Card title="Leaving" description="A request, then the wait, then the withdrawal.">
      <div className="max-w-md">
        <AmountInput
          label="Amount to withdraw"
          asset="BRSR"
          value={text}
          onChange={(next, value) => {
            setText(next);
            setAtomic(value);
          }}
          max={held === undefined ? undefined : { atomic: held, label: 'Everything' }}
          problem={overHeld ? 'More than this position holds.' : undefined}
          hint="This asks for a number of shares. What they pay out in BRSR is decided when the withdrawal completes."
          disabled={held === undefined}
        />
      </div>

      {sharesToExit > 0n && (
        <p className="mt-3 text-detail text-[color:var(--color-muted)]">
          That is {sharesToExit.toString()} of your {shares.toString()} shares.
        </p>
      )}

      {held === undefined && (
        <p className="mt-3 text-detail text-[color:var(--color-muted)]">
          What this position holds could not be read, and an amount cannot be priced into shares without it. The
          request stays off until the next reading lands.
        </p>
      )}

      <div className="mt-4">
        <TxButton
          label="Request the withdrawal"
          disabled={sharesToExit === 0n || overHeld}
          blockedBy={blockedBy}
          send={() =>
            writeContractAsync({
              address: TOKEN_ADDRESSES.Staking,
              abi: stakingAbi,
              functionName: 'requestUnbond',
              args: [sharesToExit],
            })
          }
          onConfirmed={() => {
            setText('');
            setAtomic(undefined);
          }}
          onContinue={data.refresh}
        />
      </div>
    </Card>
  );
}

function ClaimCard({ data, blockedBy }: { readonly data: TokenPageData; readonly blockedBy: readonly AnyState[] }) {
  const { writeContractAsync } = useWriteContract();
  const owed = data.token?.position?.pendingRewards;
  const note =
    owed !== undefined
      ? 'Spread earned by your shares and not yet taken.'
      : data.token === undefined
      ? 'Reading what your shares have earned.'
      : 'The staking contract did not answer what your shares have earned, so the claim stays off until the next reading lands.';

  return (
    <Card title="Spread" description="Distribution is in USDG and stays claimable while the pool is paused.">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="text-sm">
          <span className="tabular text-xl">{owed === undefined ? unreadWord(data) : usdExact(owed)}</span>
          <p className="mt-1 text-detail text-[color:var(--color-muted)]">{note}</p>
        </div>
        <TxButton
          label="Claim"
          disabled={owed === undefined || owed === 0n}
          blockedBy={blockedBy}
          send={() => writeContractAsync({ address: TOKEN_ADDRESSES.Staking, abi: stakingAbi, functionName: 'claimRewards' })}
          onConfirmed={data.refresh}
        />
      </div>
    </Card>
  );
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Before the first reading lands a figure is on its way. After it lands, a figure that is still
 * missing is a call the contract did not answer, and a staker reading zero where the answer is
 * unknown is the one mistake this section cannot make.
 */
function unreadWord(data: TokenPageData): string {
  return data.token === undefined ? 'Reading' : 'Not read';
}

function amountOr(value: Brsr | undefined, unread: string): string {
  return value === undefined ? unread : `${formatBrsr(value)} BRSR`;
}
