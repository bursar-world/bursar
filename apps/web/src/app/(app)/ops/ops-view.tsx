'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Address } from 'viem';

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
import { useSystemState } from '@/state';
import type { AnyState } from '@/state';

import { ProposePanel } from '../governance/actions-panel';
import { CUSTODY_LINE, permits } from '../governance/roles';
import type { Roles } from '../governance/roles';
import { NEEDS, TREASURY_WARNING, answerWord, canSweep, needFor, opsAccess, sweepLine } from './gate';
import type { OpsRead, StakingTier } from './read';
import { useOps } from './use-ops';
import { useWriteContract } from '@/wallet/write';

const NOT_READ = <span className="text-[color:var(--color-muted)]">Not read</span>;

/**
 * The operator surface.
 *
 * Four things live here that live nowhere else: the escrow's fees, the escrow's treasury, the
 * staking rebate table and the buyback's limits. The first two are direct calls, because the
 * escrow has no admin role and never had one. The last two are proposals, because the timelock
 * administers both contracts. Mixing them on one page is deliberate: the operator's job is the
 * same in all four cases, and which of them waits two days is exactly the thing the page has to
 * say out loud.
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
        description="Escrow fees, the treasury that receives them, and the staking and buyback settings governance controls."
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
              <Field label="Guardian" hint="Stops an administered contract. Nothing else.">
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
                Read <Instant at={data.readAt} relative />
                {data.blockNumber !== undefined && <> at block {data.blockNumber.toString()}</>}. Every figure below is
                from that block.
              </p>
            )}
          </div>

          <p className="mt-5 max-w-3xl text-detail text-[color:var(--color-muted)]">{CUSTODY_LINE}</p>
        </Card>

        <Card title="What each action needs" description="Two of these go straight to the contract. Two wait out the governance delay.">
          <Table
            rows={[...NEEDS]}
            rowKey={(row) => row.id}
            caption="Operator actions and the key each one needs"
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
                {data.failures} {data.failures === 1 ? 'reading' : 'readings'} on this page did not come back. Anything
                marked not read is unknown, not zero and not empty. Nothing has changed on chain; only the reading failed.
              </span>
            </p>
          </Card>
        )}

        <ErrorSurface error={ops.error} action="reading the operator surface" onRetry={ops.refresh} />
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
      <ParameterSections data={data} roles={ops.roles} admitted={access.admitted} blockedBy={blockedBy} onDone={ops.refresh} />
    </div>
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
    <Section title="Escrow fees" description="The protocol's cut of every release, held in the escrow until somebody pushes it to the treasury.">
      <Card>
        <FieldGrid columns={3}>
          <Field label="Accrued and unswept" hint="Owed to the treasury. It sits in the escrow until the sweep runs.">
            {accrued === undefined ? unread : <span className="tabular">{formatUsdg(accrued)}</span>}
          </Field>
          <Field label="Fee on a release" hint="Fixed at construction. Nobody can change it, governance included.">
            {data?.fees.feeBps === undefined ? unread : formatBps(BigInt(data.fees.feeBps))}
          </Field>
          <Field label="Escrow holds in total" hint="Locked payments sit in the same balance. Only the accrued figure is sweepable.">
            {data?.fees.escrowBalance === undefined ? unread : <span className="tabular">{formatUsdg(data.fees.escrowBalance)}</span>}
          </Field>
        </FieldGrid>

        <p className="mt-5 max-w-3xl text-sm">{sweepLine(accrued, data?.treasury.current, data !== undefined)}</p>

        <div className="mt-3">
          <FieldGrid columns={2}>
            <Field label="Destination" hint="Fixed by the escrow's own treasury slot. The sweep cannot be pointed anywhere else.">
              {data?.treasury.current === undefined ? unread : <AddressLabel value={data.treasury.current} />}
            </Field>
            <Field label="Who may call it" hint={need.needs}>
              Anyone
            </Field>
          </FieldGrid>
        </div>

        {roles.treasury === 'yes' && (
          <p className="mt-3 text-detail text-[color:var(--color-muted)]">
            This wallet is the treasury, so a sweep sent from it pays it. Gas comes out of this wallet either way.
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
                The escrow refuses a sweep of zero. Come back once a lock has released.
              </p>
            )}
          </div>
        ) : (
          <p className="mt-5 text-detail text-[color:var(--color-muted)]">
            The call itself is permissionless and pays the treasury whoever sends it. This page asks for a signer, the
            guardian or the treasury key before it offers the control.
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
    <Section title="The escrow treasury" description="Where every swept fee lands, and the one role in this deployment the timelock cannot reach.">
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
              help="Point it at a multisig while the current key is still in hand. Nothing here can recover that key later."
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
              confirmDescription="This names the address. It starts receiving only once it calls acceptTreasury from its own key. If that key does not exist, nothing here and no proposal can undo it once the new address accepts."
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
            title={data === undefined ? 'Reading the escrow.' : pending === undefined ? 'This was not read.' : 'No handover is open.'}
          >
            {data === undefined
              ? 'Whether a successor has been named is on its way.'
              : pending === undefined
                ? 'Whether a successor has been named could not be read. Nothing here says there is none, and the escrow has not changed; only the reading failed.'
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
                address, the current treasury and the timelock included.
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
      <Section title="Staking and the buyback" description="The timelock administers both contracts, so both parameters below go through governance.">
        <Card title="Where these two stand today" description="Read from the contracts, not from a plan.">
          <FieldGrid columns={3}>
            <Field label="Fee rebate tiers" hint="An empty table means every rebate reads zero, whatever anyone has staked.">
              {tiers === undefined ? unread : tiers.length === 0 ? 'Empty' : `${tiers.length} rungs`}
            </Field>
            <Field label="Credit lane" hint="The only address that can take stake. Nothing can be slashed until one is named.">
              {data?.staking.creditManager === undefined ? unread : isZeroAddress(data.staking.creditManager) ? 'Not named' : <AddressLabel value={data.staking.creditManager} />}
            </Field>
            <Field label="Buyback price ceiling" hint="The most it will pay for one whole BRSR. Zero refuses every trade.">
              {params === undefined ? unread : params.maxPricePerBrsr === 0n ? 'Unset, so every buy is refused' : formatUsdg(params.maxPricePerBrsr)}
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
            A ceiling is the most a buyback will pay for one whole BRSR, and there is no price to set it against until the
            BRSR/USDG pool holds liquidity. Set it after the pool exists, never before. Everything pending is listed on{' '}
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
          only={['staking.setTiers', 'staking.setCreditManager', 'buyback.setParams']}
          title="Propose one of these"
          description="The same builder the governance page uses, narrowed to the two contracts on this surface. It needs one of the three signer keys and then the full delay."
        />
      ) : (
        <Card title="Propose one of these">
          <p className="max-w-3xl text-sm">
            Setting the tiers or the buyback ceiling is a proposal, so it needs one of the three signer keys, a second
            signer and the full delay. Connect a signer key here, or build the proposal on{' '}
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
