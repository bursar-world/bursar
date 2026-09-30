'use client';

import { useState } from 'react';

import { TOKEN_ADDRESSES, isZeroAddress, brsrAbi, sameAddress, stakingAbi } from '@/chain';
import { collateralLane } from '@/chain/collateral';
import type { PendingExit, StakingPool } from '@/chain/token';
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
import { tokenFailure } from './refusal';
import { allowanceHint, brakeHint, capSentence, exitStage, slasherSentence } from './state';
import type { TokenPageData } from './use-token-page';
import { useWriteContract } from '@/wallet/write';

/**
 * The staking surface.
 *
 * What a staker is exposed to comes before what the position pays, and both come before the
 * controls. Stake is first-loss cover for the collateralized lane at a capped rate, and whether a
 * write-off can reach it today is a reading, not a sentence: it depends on whom the pool names as
 * its slasher.
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

  return (
    <Section
      title="Staking"
      description="First-loss cover for the collateralized lane, where its spread and the buyback arrive, and the fee rebate a staked balance earns."
    >
      <Card title="What staking here exposes you to">
        <div className="max-w-3xl space-y-3 text-sm">
          <p>
            Staked BRSR takes first loss on the collateralized lane. That lane lends USDG from a separate credit pool
            against posted stock and treasury tokens. When a line&rsquo;s collateral cannot repay its debt, the credit
            pool writes the shortfall off, and where the staking contract names that pool as its slasher, the write-off
            takes stake: the loss is converted to BRSR at the buyback&rsquo;s price ceiling and sent to the slash sink.
            The lender carries whatever the stake does not cover.
          </p>
          <p>{capSentence(pool)}</p>
          <p>{slasherSentence(pool, creditPool, data.token === undefined)}</p>
          <p>
            In exchange the pool is where the collateralized lane&rsquo;s spread is paid, in USDG, and where the buyback
            compounds the BRSR it buys, which raises what each earning share is worth. A staked balance also takes a
            rebate off the facilitator fee on that party&rsquo;s own settlements. None of these is a rate. None is
            promised. What arrives depends on how much the system is used. Staking also carries the BRSR price itself,
            which can fall, and the exit wait below.
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
          <Field label="Fee rebate tiers" hint="Each tier is measured against earning stake, so stake behind an exit request does not count toward it.">
            {pool?.tiers === undefined ? unread : pool.tiers.length === 0 ? 'None set' : `${pool.tiers.length} tiers`}
          </Field>
          <Field label="Slasher" hint="The one address that can take stake to cover a write-off.">
            {pool?.slasher === undefined ? (
              unread
            ) : isZeroAddress(pool.slasher) ? (
              'None named'
            ) : (
              <Address value={pool.slasher} label={sameAddress(pool.slasher, creditPool) ? 'Credit pool' : undefined} />
            )}
          </Field>
          <Field label="Slash allowance" hint={allowanceHint(pool)}>
            <span className="tabular">{amountOr(pool?.slashAllowance, unread)}</span>
          </Field>
          <Field label="Exit wait" hint="How long an exit request waits before it can complete. It earns nothing while it waits.">
            {pool?.unbondingPeriod === undefined ? unread : formatDuration(Number(pool.unbondingPeriod))}
          </Field>
          <Field label="Time to complete" hint="How long a request stays open once it is ready. After that it lapses until it is put back to work.">
            {pool?.unbondWindow === undefined ? unread : formatDuration(Number(pool.unbondWindow))}
          </Field>
          <Field label="In the pool" hint="Earning stake and stake behind exit requests together.">
            <span className="tabular">{amountOr(pool?.totalStaked, unread)}</span>
          </Field>
          <Field label="Behind exit requests" hint="Earns nothing, and takes its share of any slash until it leaves.">
            <span className="tabular">{amountOr(pool?.unbondingStaked, unread)}</span>
          </Field>
          <Field label="Reward asset" hint="Spread is distributed in the settlement asset, not in BRSR.">
            {pool?.rewardToken === undefined ? unread : <Address value={pool.rewardToken} label="USDG" />}
          </Field>
          <Field label="Brake" hint={brakeHint(pool)}>
            {pool?.paused === undefined ? (
              unread
            ) : !pool.paused ? (
              'Running'
            ) : pool.exitsHeldUntil ? (
              <>
                Paused, exits held until <Instant at={pool.exitsHeldUntil} />
              </>
            ) : (
              'Paused'
            )}
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
                label="Earning stake"
                value={amountOr(position?.activeStake, unread)}
                hint="Earning spread and compounds, and counted for the rebate."
              />
              <Stat
                label="Held in the pool"
                value={amountOr(position?.stakedValue, unread)}
                hint="Including an exit on its way out, which earns nothing and still takes losses."
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
                <Field label="Earning shares" hint="What you own is a fraction of the pool, not a balance inside it.">
                  <span className="tabular">{position?.shares === undefined ? unread : position.shares.toString()}</span>
                </Field>
                <Field label="Staking contract">
                  <Address value={TOKEN_ADDRESSES.Staking} />
                </Field>
              </FieldGrid>
            </div>
          </Card>

          <StakeCard data={data} blockedBy={blockedBy} />
          <ExitCard data={data} blockedBy={blockedBy} />
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
          hint="Once staked, leaving takes the exit wait above, and the stake takes its share of any slash until it leaves."
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
              }).catch((caught: unknown) => {
                throw tokenFailure(caught, { action: 'Allow the staking contract', contract: 'staking' });
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
              }).catch((caught: unknown) => {
                throw tokenFailure(caught, { action: 'Stake', contract: 'staking' });
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

function ExitCard({ data, blockedBy }: { readonly data: TokenPageData; readonly blockedBy: readonly AnyState[] }) {
  const [text, setText] = useState('');
  const [atomic, setAtomic] = useState<bigint | undefined>(undefined);
  const { writeContractAsync } = useWriteContract();

  const position = data.token?.position;
  const pool = data.token?.pool;

  if (position === undefined || position.exit === undefined) {
    return (
      <Card title="Leaving">
        <p className="text-sm text-[color:var(--color-muted)]">
          {data.token === undefined
            ? 'Reading this position.'
            : 'The staking contract did not answer whether an exit is open for this wallet, so leaving stays off until the next reading lands.'}
        </p>
      </Card>
    );
  }

  if (position.exit !== null) return <PendingExitCard exit={position.exit} pool={pool} data={data} blockedBy={blockedBy} />;

  const earning = position.activeStake;
  const shares = position.shares;

  if (shares === 0n) {
    return (
      <Card title="Leaving">
        <p className="text-sm text-[color:var(--color-muted)]">Nothing staked, so there is nothing to withdraw.</p>
      </Card>
    );
  }

  const requested = atomic ?? 0n;
  const overHeld = earning !== undefined && requested > earning;
  // Priced against this position's own holding, so a request for everything is exactly every share
  // and cannot round short of it. Pricing against the pool would leave dust behind.
  const sharesToExit =
    earning === undefined || shares === undefined || earning === ZERO_BRSR || requested === 0n ? 0n : min((requested * shares) / earning, shares);

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
          max={earning === undefined ? undefined : { atomic: earning, label: 'Everything' }}
          problem={overHeld ? 'More than this position has in earning stake.' : undefined}
          hint="Priced when the request is filed. From then it earns nothing, and completing pays that amount less any slash while it waits."
          disabled={earning === undefined || shares === undefined}
        />
      </div>

      {sharesToExit > 0n && shares !== undefined && (
        <p className="mt-3 text-detail text-[color:var(--color-muted)]">
          That is {sharesToExit.toString()} of your {shares.toString()} earning shares.
        </p>
      )}

      {pool?.unbondingPeriod !== undefined && pool.unbondWindow !== undefined && (
        <p className="mt-3 text-detail text-[color:var(--color-muted)]">
          It can complete after {formatDuration(Number(pool.unbondingPeriod))} and stays open for{' '}
          {formatDuration(Number(pool.unbondWindow))} after that. A request left past then lapses and earns nothing until it
          is put back to work.
        </p>
      )}

      {(earning === undefined || shares === undefined) && (
        <p className="mt-3 text-detail text-[color:var(--color-muted)]">
          What this position holds in earning stake could not be read, and an amount cannot be priced into shares without
          it. The request stays off until the next reading lands.
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
            }).catch((caught: unknown) => {
              throw tokenFailure(caught, { action: 'Request the withdrawal', contract: 'staking' });
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

/**
 * One exit request, from filing to lapse.
 *
 * Four moments decide what can be done with it: filed, ready, held by a pause, lapsed. The contract
 * dates all of them, so the card shows the dates and switches its controls on the same clock the
 * countdowns run on.
 */
function PendingExitCard({
  exit,
  pool,
  data,
  blockedBy,
}: {
  readonly exit: PendingExit;
  readonly pool: StakingPool | undefined;
  readonly data: TokenPageData;
  readonly blockedBy: readonly AnyState[];
}) {
  const { writeContractAsync } = useWriteContract();
  const stage = exitStage(exit, pool, Date.now());
  const lapsed = stage === 'lapsed';
  const matured = stage !== 'waiting';
  const heldUntil = pool?.exitsHeldUntil;
  const unread = unreadWord(data);

  return (
    <Card title="Leaving" description="One exit request at a time.">
      <FieldGrid columns={4}>
        <Field label="On its way out" hint="What completing pays now: its value when filed, less any slash since.">
          <span className="tabular">{formatBrsr(exit.amount)} BRSR</span>
        </Field>
        <Field label="Requested">{exit.requestedAt === undefined ? unread : <Instant at={exit.requestedAt} />}</Field>
        <Field label={matured ? 'Ready since' : 'Can complete'}>
          {matured ? <Instant at={exit.maturesAt} /> : <Countdown to={exit.maturesAt} />}
        </Field>
        <Field label={lapsed ? 'Lapsed' : 'Lapses'} hint="Time a pause spends holding exits is added to this.">
          {lapsed ? <Instant at={exit.lapsesAt} /> : <Countdown to={exit.lapsesAt} />}
        </Field>
      </FieldGrid>

      <p className="mt-4 max-w-3xl text-sm">
        {lapsed
          ? 'This request lapsed without being completed. The stake is still yours and still in the pool, earning nothing. Put it back to work, then ask to leave again if you still want to.'
          : 'This stake no longer earns spread or compounds, and it takes its share of any slash until the withdrawal completes. Complete it once it is ready and before it lapses.'}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {!lapsed && (
          <TxButton
            label="Complete the withdrawal"
            disabled={stage !== 'ready'}
            blockedBy={blockedBy}
            send={() =>
              writeContractAsync({ address: TOKEN_ADDRESSES.Staking, abi: stakingAbi, functionName: 'completeUnbond' }).catch(
                (caught: unknown) => {
                  throw tokenFailure(caught, { action: 'Complete the withdrawal', contract: 'staking' });
                },
              )
            }
            onContinue={data.refresh}
          />
        )}
        <TxButton
          label={lapsed ? 'Put it back to work' : 'Cancel and stay in'}
          tone={lapsed ? 'primary' : 'secondary'}
          blockedBy={blockedBy}
          send={() =>
            writeContractAsync({ address: TOKEN_ADDRESSES.Staking, abi: stakingAbi, functionName: 'cancelUnbond' }).catch(
              (caught: unknown) => {
                throw tokenFailure(caught, { action: lapsed ? 'Put it back to work' : 'Cancel the withdrawal', contract: 'staking' });
              },
            )
          }
          onContinue={data.refresh}
        />
      </div>

      <p className="mt-3 max-w-3xl text-detail text-[color:var(--color-muted)]">
        Going back to work is priced at today&rsquo;s share price. Anything the buyback compounded while this stake was out
        stays with the stakers who were earning, so it comes back as fewer shares than it left as.
      </p>

      {stage === 'held' && heldUntil && (
        <p className="mt-3 text-detail text-[color:var(--color-muted)]">
          The pool is paused, and the pause keeps exits from completing until <Instant at={heldUntil} />. The same time is
          added before this request lapses.
        </p>
      )}
      {stage === 'unknown-hold' && (
        <p className="mt-3 text-detail text-[color:var(--color-muted)]">
          {pool?.paused === true
            ? 'The pool is paused, and how long the pause holds exits could not be read, so completing stays off until the next reading lands. Restarting the pool is a governance proposal.'
            : 'Whether the pool is paused could not be read, and a pause can hold exits from completing, so completing stays off until the next reading lands.'}
        </p>
      )}
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
          send={() =>
            writeContractAsync({ address: TOKEN_ADDRESSES.Staking, abi: stakingAbi, functionName: 'claimRewards' }).catch(
              (caught: unknown) => {
                throw tokenFailure(caught, { action: 'Claim the spread', contract: 'staking' });
              },
            )
          }
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
