'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Address } from 'viem';

import { collateralVaultAbi } from '@bursar/core';

import { ADDRESSES, escrowAbi, isZeroAddress, sameAddress } from '@/chain';
import { formatBps, formatBrsrAmount, formatUsdg, parseField } from '@/chain/admin-actions';
import { Address as AddressLabel } from '@/components/address';
import { Badge, LevelDot } from '@/components/badge';
import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { TextField } from '@/components/fields';
import { Instant } from '@/components/instant';
import { Card, EmptyState, Field, FieldGrid, Section } from '@/components/layout';
import { Table } from '@/components/table';
import { TxButton } from '@/components/tx-button';
import { formatDuration } from '@/lib';
import { tokenAmountText } from '@/money';
import { useSystemState } from '@/state';
import type { AnyState } from '@/state';

import { ProposePanel } from '../governance/actions-panel';
import { permits } from '../governance/roles';
import type { Roles } from '../governance/roles';
import { NEEDS, TREASURY_WARNING, answerWord, canSweep, needFor, opsAccess, seizedLine, sweepLine } from './gate';
import type { OpsRead, StakingTier } from './read';
import { useOps } from './use-ops';
import { useWriteContract } from '@/wallet/write';

const NOT_READ = <span className="text-[color:var(--color-muted)]">Not read</span>;

/**
 * The operator surface.
 *
 * Four things live here that live nowhere else: the escrow's fees, the escrow's treasury, the
 * staking pool's settings and the buyback's. The first two are direct calls, because the escrow
 * has no admin role and never had one. The last two are proposals, because the timelock
 * administers both contracts. Mixing them on one page is deliberate: the operator's job is the
 * same in all four cases, and which of them waits out a delay is exactly the thing the page has
 * to say out loud.
 */
export function OpsView() {
  const ops = useOps();
  const system = useSystemState();
  const blockedBy = [system.connectivity, system.asset];
  const data = ops.data;
  const access = opsAccess(ops.roles);

  return (
    <div className="space-y-10">
      <Section
        title="Operations"
        description="Settlement fees, the treasury that receives them, and the staking and buyback settings governance controls."
        actions={
          <Button size="sm" onClick={ops.refresh} disabled={ops.isFetching}>
            {ops.isFetching ? 'Reading' : 'Read again'}
          </Button>
        }
      >
        <Card>
          <p className="flex items-start gap-2 text-sm">
            <span className="pt-1">
              <LevelDot
                level={
                  access.admitted || access.accepting ? 'ok' : ops.roles.address === undefined ? 'unknown' : 'attention'
                }
              />
            </span>
            <span>
              {access.headline} <span className="text-[color:var(--color-muted)]">{access.detail}</span>
            </span>
          </p>

          <div className="mt-5">
            <FieldGrid columns={3}>
              <Field label="Timelock signer" hint="Proposes, approves, cancels and executes.">
                {answerWord(ops.roles.signer)}
              </Field>
              <Field label="Guardian" hint="Pauses an administered contract, and nothing else.">
                {answerWord(ops.roles.guardian)}
              </Field>
              <Field label="Escrow treasury" hint="Receives swept fees and names its own successor.">
                {answerWord(ops.roles.treasury)}
              </Field>
              <Field label="Named successor" hint="Named by step one. Only this address can complete a rotation.">
                {answerWord(ops.roles.incomingTreasury)}
              </Field>
            </FieldGrid>
          </div>

          <div className="mt-4">
            {data && (
              <p className="text-note text-[color:var(--color-muted)]">
                Updated <Instant at={data.readAt} relative />
                {data.blockNumber !== undefined && <> at block {data.blockNumber.toString()}</>}. Every figure below is
                from that block.
              </p>
            )}
          </div>

        </Card>

        <Card title="What each action needs" description="Four of these go straight to the contract. The rest wait out the governance delay.">
          <Table
            rows={[...NEEDS]}
            rowKey={(row) => row.id}
            caption="Actions and the key each one needs"
            columns={[
              { key: 'title', header: 'Action', cell: (row) => row.title },
              { key: 'call', header: 'Call', cell: (row) => <span className="font-mono text-detail">{row.call}</span> },
              { key: 'needs', header: 'Needs', cell: (row) => row.needs },
              {
                key: 'route',
                header: 'Lands',
                cell: (row) => <Badge tone="quiet">{row.route === 'direct' ? 'Next block' : 'After the delay'}</Badge>,
              },
            ]}
          />
        </Card>

        {data && data.failures > 0 && (
          <Card>
            <p className="flex items-start gap-2 text-sm">
              <span className="pt-1">
                <LevelDot level="unknown" />
              </span>
              <span>
                Part of this page could not be read right now. Anything marked Not read is unknown, not zero or empty.
              </span>
            </p>
          </Card>
        )}

        <ErrorSurface error={ops.error} action="Reading operations" onRetry={ops.refresh} />
      </Section>

      <FeesSection data={data} roles={ops.roles} admitted={access.admitted} blockedBy={blockedBy} onDone={ops.refresh} />
      <TreasurySection
        data={data}
        roles={ops.roles}
        admitted={access.admitted}
        accepting={access.accepting}
        blockedBy={blockedBy}
        onDone={ops.refresh}
      />
      <SeizedSection data={data} connected={ops.roles.address} blockedBy={blockedBy} onDone={ops.refresh} />
      <ParameterSections data={data} roles={ops.roles} admitted={access.admitted} blockedBy={blockedBy} onDone={ops.refresh} />
    </div>
  );
}

/**
 * Collateral a write-off took from a line, waiting for the credit pool's lender.
 *
 * The vault seizes what a written-off line still holds and keeps it until somebody claims it, and
 * the claim pays the lender whoever sends it. So the control is offered to any connected wallet,
 * and the lender's address is on the card so the sender knows where the money goes.
 */
function SeizedSection({
  data,
  connected,
  blockedBy,
  onDone,
}: {
  readonly data: OpsRead | undefined;
  readonly connected: Address | undefined;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const seized = data?.seized;
  const need = needFor('claim-seized');
  const isLender = seized?.lender !== undefined && connected !== undefined && sameAddress(seized.lender, connected);

  return (
    <Section title="Seized collateral" description="What the vault took from written-off lines, and who it goes to.">
      <Card>
        <p className="max-w-3xl text-sm">{seizedLine(seized, data !== undefined)}</p>

        {seized !== undefined && (
          <div className="mt-5">
            <FieldGrid columns={2}>
              <Field label="Paid to" hint="The credit pool's lender, who carried the loss the write-off booked.">
                {seized.lender === undefined ? NOT_READ : <AddressLabel value={seized.lender} />}
                {isLender && <span className="ml-2 text-detail text-[color:var(--color-muted)]">This wallet.</span>}
              </Field>
              <Field label="Who may call it" hint={need.needs}>
                Anyone
              </Field>
            </FieldGrid>
          </div>
        )}

        {seized !== undefined && seized.assets.length > 0 && (
          <div className="mt-5">
            <Table
              rows={[...seized.assets]}
              rowKey={(row) => row.asset}
              caption="Seized collateral waiting to be claimed"
              columns={[
                { key: 'asset', header: 'Asset', cell: (row) => <span className="font-medium">{row.symbol}</span> },
                { key: 'raw', header: 'Waiting', align: 'right', cell: (row) => <span className="tabular">{tokenAmountText(row.raw, row.asset)}</span> },
                {
                  key: 'claim',
                  header: '',
                  align: 'right',
                  cell: (row) =>
                    connected === undefined ? (
                      <span className="text-detail text-[color:var(--color-muted)]">Connect a wallet to claim</span>
                    ) : (
                      <TxButton
                        label={`Pay ${row.symbol} to the lender`}
                        tone="secondary"
                        blockedBy={blockedBy}
                        send={() =>
                          writeContractAsync({ address: seized.lane.CollateralVault, abi: collateralVaultAbi, functionName: 'claimSeized', args: [row.asset] })
                        }
                        onConfirmed={onDone}
                      />
                    ),
                },
              ]}
            />
          </div>
        )}
      </Card>
    </Section>
  );
}

function FeesSection({
  data,
  roles,
  admitted,
  blockedBy,
  onDone,
}: {
  readonly data: OpsRead | undefined;
  readonly roles: Roles;
  readonly admitted: boolean;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const need = needFor('sweep-fees');
  const accrued = data?.fees.accrued;
  const unread = data === undefined ? 'Reading' : NOT_READ;

  return (
    <Section title="Settlement fees" description="The fee from every released payment, held in the escrow until someone sweeps it to the treasury.">
      <Card>
        <FieldGrid columns={3}>
          <Field label="Accrued and unswept" hint="Owed to the treasury and held in the escrow until swept.">
            {accrued === undefined ? unread : <span className="tabular">{formatUsdg(accrued)}</span>}
          </Field>
          <Field label="Fee on a release" hint="Fixed for the life of the escrow, and governance cannot change it.">
            {data?.fees.feeBps === undefined ? unread : formatBps(BigInt(data.fees.feeBps))}
          </Field>
          <Field label="Escrow holds in total" hint="Includes locked payments. Only the accrued fees can be swept.">
            {data?.fees.escrowBalance === undefined ? unread : <span className="tabular">{formatUsdg(data.fees.escrowBalance)}</span>}
          </Field>
        </FieldGrid>

        <p className="mt-5 max-w-3xl text-sm">{sweepLine(accrued, data?.treasury.current, data !== undefined)}</p>

        <div className="mt-3">
          <FieldGrid columns={2}>
            <Field label="Destination" hint="The escrow's treasury. A sweep cannot go anywhere else.">
              {data?.treasury.current === undefined ? unread : <AddressLabel value={data.treasury.current} />}
            </Field>
            <Field label="Who may call it" hint={need.needs}>
              Anyone
            </Field>
          </FieldGrid>
        </div>

        {roles.treasury === 'yes' && (
          <p className="mt-3 text-detail text-[color:var(--color-muted)]">
            This wallet is the treasury, so a sweep sent from it pays itself. The network fee comes from this wallet
            either way.
          </p>
        )}

        {admitted ? (
          <div className="mt-5">
            <TxButton
              label="Sweep fees to the treasury"
              disabled={!canSweep(accrued)}
              blockedBy={blockedBy}
              send={() => writeContractAsync({ address: ADDRESSES.escrow, abi: escrowAbi, functionName: 'sweepFees' })}
              onConfirmed={onDone}
            />
            {accrued === 0n && (
              <p className="mt-2 text-detail text-[color:var(--color-muted)]">
                The escrow refuses a sweep of zero.
              </p>
            )}
          </div>
        ) : (
          <p className="mt-5 text-detail text-[color:var(--color-muted)]">
            Anyone can make this call, and it always pays the treasury. This page offers the control to a signer, the
            guardian or the treasury key.
          </p>
        )}
      </Card>
    </Section>
  );
}

function TreasurySection({
  data,
  roles,
  admitted,
  accepting,
  blockedBy,
  onDone,
}: {
  readonly data: OpsRead | undefined;
  readonly roles: Roles;
  readonly admitted: boolean;
  /** Step two is open to the address step one named, whatever else it does or does not hold. */
  readonly accepting: boolean;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const [successor, setSuccessor] = useState('');
  const unread = data === undefined ? 'Reading' : NOT_READ;

  const pending = data?.treasury.pending;
  const handoverOpen = pending !== undefined && !isZeroAddress(pending);
  const parsed = parseField({ name: 'to', label: 'Successor', kind: 'address', help: '' }, successor);
  const problem = successor.trim() === '' ? undefined : parsed.ok ? undefined : parsed.problem;
  const successorAddress = parsed.ok ? (parsed.value as Address) : undefined;
  const namingSelf = successorAddress !== undefined && sameAddress(successorAddress, data?.treasury.current);

  const canName = permits(roles.treasury);
  const canAccept = successorOrConnectedMatches(pending, roles.address);

  return (
    <Section title="The escrow treasury" description="Where every swept fee lands, and the one role the governance delay cannot reach.">
      <Card>
        <p className="max-w-3xl text-sm">{TREASURY_WARNING}</p>

        <div className="mt-5">
          <FieldGrid columns={3}>
            <Field label="Receiving now">{data?.treasury.current === undefined ? unread : <AddressLabel value={data.treasury.current} />}</Field>
            <Field label="Named successor" hint="Set by step one. It receives nothing until it accepts.">
              {pending === undefined ? unread : handoverOpen ? <AddressLabel value={pending} /> : 'None'}
            </Field>
            <Field label="Holds" hint="USDG at that address. Swept fees land here.">
              {data?.treasury.balance === undefined ? unread : <span className="tabular">{formatUsdg(data.treasury.balance)}</span>}
            </Field>
          </FieldGrid>
        </div>
      </Card>

      <Card title="Step one, name a successor" description={needFor('transfer-treasury').needs}>
        {admitted ? (
          <div className="max-w-xl space-y-4">
            <TextField
              label="New treasury address"
              value={successor}
              onChange={setSuccessor}
              help="Use a multisig, and name it while the current key is still available. Nothing here can recover a lost key."
              problem={problem ?? (namingSelf ? 'That is the address already receiving. Naming it again changes nothing.' : undefined)}
              placeholder="0x…"
              mono
            />
            <TxButton
              label="Name this successor"
              disabled={successorAddress === undefined || namingSelf || !canName}
              blockedBy={blockedBy}
              confirmPhrase="ROTATE"
              confirmTitle="Name a successor to the escrow treasury"
              confirmDescription="This names the address. It starts receiving only after it accepts from its own key, and once it accepts, nothing here and no proposal can undo it."
              send={() =>
                writeContractAsync({
                  address: ADDRESSES.escrow,
                  abi: escrowAbi,
                  functionName: 'transferTreasury',
                  args: [successorAddress ?? ('0x0000000000000000000000000000000000000000' as Address)],
                })
              }
              onConfirmed={() => {
                setSuccessor('');
                onDone();
              }}
            />
            {!canName && (
              <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
                This call comes from the current treasury key and from nowhere else. Connect{' '}
                {data?.treasury.current === undefined ? 'that address' : <AddressLabel value={data.treasury.current} />} and try again.
              </p>
            )}
          </div>
        ) : (
          <p className="text-detail text-[color:var(--color-muted)]">Connect the treasury key to name a successor.</p>
        )}
      </Card>

      <Card title="Step two, accept it" description={needFor('accept-treasury').needs}>
        {!handoverOpen ? (
          <EmptyState
            title={data === undefined ? 'Reading the escrow.' : pending === undefined ? 'Could not read the handover.' : 'No handover is open.'}
          >
            {data === undefined
              ? 'Checking whether a successor has been named.'
              : pending === undefined
                ? 'Could not read whether a successor has been named. Read again.'
                : 'Step one names a successor. Until one is named there is nothing to accept, and the address receiving now keeps receiving.'}
          </EmptyState>
        ) : (
          <div className="space-y-4">
            <p className="max-w-3xl text-sm">
              <AddressLabel value={pending} /> has been named and has not accepted. Until it does, every swept fee still goes
              to the address receiving now. This call has to come from the named address itself.
            </p>
            {accepting ? (
              <>
                <TxButton
                  label="Accept the treasury"
                  disabled={!canAccept}
                  blockedBy={blockedBy}
                  send={() => writeContractAsync({ address: ADDRESSES.escrow, abi: escrowAbi, functionName: 'acceptTreasury' })}
                  onContinue={onDone}
                />
                {!canAccept && (
                  <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
                    Only the named address can accept. Connect <AddressLabel value={pending} /> and try again.
                  </p>
                )}
              </>
            ) : (
              <p className="text-detail text-[color:var(--color-muted)]">
                Connect <AddressLabel value={pending} /> to accept. The escrow refuses this call from every other
                address, including the current treasury and governance.
              </p>
            )}
          </div>
        )}
      </Card>
    </Section>
  );
}

function successorOrConnectedMatches(pending: Address | undefined, connected: Address | undefined): boolean {
  // Unread leaves the control offered: the escrow refuses a caller that is not the named address,
  // so asking costs a refused simulation, and a failed reading must not read as a refusal.
  if (pending === undefined) return true;
  return sameAddress(pending, connected);
}

function ParameterSections({
  data,
  roles,
  admitted,
  blockedBy,
  onDone,
}: {
  readonly data: OpsRead | undefined;
  readonly roles: Roles;
  readonly admitted: boolean;
  readonly blockedBy: readonly AnyState[];
  readonly onDone: () => void;
}) {
  const unread = data === undefined ? 'Reading' : NOT_READ;
  const tiers = data?.staking.tiers;
  const params = data?.buyback.params;

  return (
    <>
      <Section title="Staking and the buyback" description="Governance administers both contracts, so every setting below takes a proposal.">
        <Card title="Where these two stand today" description="Live from both contracts.">
          <FieldGrid columns={3}>
            <Field label="Fee rebate tiers" hint="With no tiers, every rebate is zero.">
              {tiers === undefined ? unread : tiers.length === 0 ? 'Empty' : `${tiers.length} tiers`}
            </Field>
            <Field label="Credit manager" hint="The address the staking pool takes spread from. It cannot take stake.">
              {data?.staking.creditManager === undefined ? unread : isZeroAddress(data.staking.creditManager) ? 'Not named' : <AddressLabel value={data.staking.creditManager} />}
            </Field>
            <Field label="Slasher" hint="The only address that can take stake, up to the slash cap. Nothing can be slashed while none is named.">
              {data?.staking.slasher === undefined ? unread : isZeroAddress(data.staking.slasher) ? 'Not named' : <AddressLabel value={data.staking.slasher} />}
            </Field>
            <Field label="Buyback keeper" hint="The only address that can trigger a buy. With none named, no buy runs.">
              {data?.buyback.keeper === undefined ? unread : isZeroAddress(data.buyback.keeper) ? 'Not named' : <AddressLabel value={data.buyback.keeper} />}
            </Field>
            <Field label="Buyback price ceiling" hint="The most it will pay for one whole BRSR. Zero refuses every trade.">
              {params === undefined ? unread : params.maxPricePerBrsr === 0n ? 'Unset, so every buy is refused' : formatUsdg(params.maxPricePerBrsr)}
            </Field>
            <Field label="Ceiling usable until" hint="Any change to the buyback's limits resets this. After it, every buy is refused.">
              {data?.buyback.ceilingStaleAt === undefined ? unread : <Instant at={data.buyback.ceilingStaleAt} />}
            </Field>
          </FieldGrid>

          {tiers !== undefined && tiers.length > 0 && (
            <div className="mt-4">
              <Table
                rows={[...tiers] as StakingTier[]}
                rowKey={(_, index) => `${index}`}
                caption="Fee rebate by staked balance"
                columns={[
                  { key: 'min', header: 'Staked at least', align: 'right', cell: (row) => <span className="tabular">{formatBrsrAmount(row.minStake)}</span> },
                  { key: 'rebate', header: 'Off the facilitator fee', align: 'right', cell: (row) => <span className="tabular">{formatBps(BigInt(row.rebateBps))}</span> },
                ]}
              />
            </div>
          )}

          {params !== undefined && (
            <div className="mt-4">
              <FieldGrid columns={4}>
                <Field label="Spend per call">{formatUsdg(params.spendPerCall)}</Field>
                <Field label="Ceiling per window">{formatUsdg(params.maxSpendPerWindow)}</Field>
                <Field label="Window">{formatDuration(Number(params.window))}</Field>
                <Field label="Wait between buys">{formatDuration(Number(params.minInterval))}</Field>
              </FieldGrid>
            </div>
          )}

          <p className="mt-4 max-w-3xl text-detail text-[color:var(--color-muted)]">
            Set the ceiling against the pool&rsquo;s price, and set it again before the date above, or every buy is refused
            until governance does. Pending proposals are on{' '}
            <Link href="/governance" className="underline underline-offset-2">
              the governance page
            </Link>
            .
          </p>
        </Card>
      </Section>

      {admitted ? (
        <ProposePanel
          canPropose={roles.signer}
          delaySeconds={undefined}
          blockedBy={blockedBy}
          onProposed={onDone}
          only={[
            'staking.setTiers',
            'staking.setCreditManager',
            'staking.setSlasher',
            'buyback.setParams',
            'buyback.setKeeper',
            'buyback.setMaxCeilingAge',
          ]}
          title="Propose one of these"
          description="The governance page’s proposal form, limited to these two contracts. It needs one of the three signer keys, a second signer and the full delay."
        />
      ) : (
        <Card title="Propose one of these">
          <p className="max-w-3xl text-sm">
            Setting the tiers, the slasher, the keeper or the buyback ceiling is a proposal, so it needs one of the three
            signer keys, a second signer and the full delay. Connect a signer key here, or build the proposal on{' '}
            <Link href="/governance" className="underline underline-offset-2">
              the governance page
            </Link>
            .
          </p>
        </Card>
      )}
    </>
  );
}
