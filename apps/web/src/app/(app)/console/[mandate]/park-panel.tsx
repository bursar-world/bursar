'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Micro } from '@bursar/core';
import { mandateAccountAbi, treasuryParkAbi, usdgMicrosToRaw } from '@bursar/core';
import type { Abi } from 'viem';

import { onCurrentSet } from '@/chain/deployments';
import { ADDRESSES } from '@/chain/rhc';
import { AmountInput } from '@/components/amount-input';
import { LevelBadge } from '@/components/badge';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { Table } from '@/components/table';
import { TxButton } from '@/components/tx-button';
import { bps, usd, usdExact } from '@/money';
import { formatRelative } from '@/lib/time';
import { readUsdgAmount } from '../lib/amount';
import { drawsInsidePayment, feedPrice, hours, holdingValue, refuseEarly, tokenAmount, useRwa } from '../lib/rwa';
import type { ParkPosition, RwaState } from '../lib/rwa';
import { callGates, transferGates } from '../lib/write-gates';
import { useMandateScope } from './mandate-scope';
import { useWriteContract } from '@/wallet/write';

const USDG_DECIMALS = 6;

function decimalsOf(position: ParkPosition): number {
  return position.asset?.config?.decimals ?? USDG_DECIMALS;
}

export function ParkPanel() {
  const { address, account } = useMandateScope();
  const served = account !== undefined && onCurrentSet(account.contractSet);
  const rwa = useRwa(address, served);

  if (!account || !served || rwa.data === undefined) return null;

  return <ParkBody rwa={rwa.data} onChange={() => void rwa.refetch()} />;
}

function ParkBody({ rwa, onChange }: { readonly rwa: RwaState; readonly onChange: () => void }) {
  const { address, isOwner } = useMandateScope();
  const now = rwa.chainTime ?? new Date();
  const valuationStaleness = rwa.positions.find((p) => p.asset?.config)?.asset?.config?.valuationStaleness;
  const parked = rwa.positions.filter((p) => (p.raw ?? 0n) > 0n);
  const draws = useQuery({ queryKey: ['console', 'draws', address], queryFn: () => drawsInsidePayment(address), staleTime: Infinity });

  return (
    <Section
      title="Parked USDG"
      description={`Idle USDG the owner has parked in treasury holdings. It still counts toward what the agent can spend.${
        valuationStaleness === undefined ? '' : ` A holding counts only while its price is under ${hours(valuationStaleness)} old.`
      }`}
    >
      <Card>
        <div className="space-y-6">
          <StatGrid columns={4}>
            <Stat
              label="Parked value"
              value={rwa.parkedTotal === undefined ? 'Unread' : usdExact(rwa.parkedTotal as Micro)}
              hint="Valued at the feed price. Holdings with a stale price are left out."
            />
            <Stat
              label="Counted toward spending power"
              value={rwa.parkedCounted === undefined ? 'Unread' : usdExact(rwa.parkedCounted as Micro)}
              hint="Parked value after each holding’s haircut."
            />
            <Stat
              label="Spending power"
              value={rwa.spendingPower === undefined ? 'Unread' : usdExact(rwa.spendingPower as Micro)}
              hint={
                draws.data === false
                  ? 'USDG in the mandate and its vault, plus counted parked value. This mandate pays only from USDG on hand, so unpark before a payment needs it.'
                  : 'USDG in the mandate and its vault, plus counted parked value. A payment larger than the USDG on hand unparks the difference automatically.'
              }
            />
            <Stat
              label="Buffer"
              value={rwa.buffer === undefined ? 'Unread' : usd(rwa.buffer as Micro)}
              hint="The mandate keeps at least this much USDG unparked."
            />
          </StatGrid>

          <Table<ParkPosition>
            caption="Parked positions"
            rows={parked}
            rowKey={(row) => row.adapter}
            empty={<p className="text-detail text-[color:var(--color-muted)]">Nothing is parked.</p>}
            columns={[
              { key: 'symbol', header: 'Holding', cell: (row) => <span className="font-medium">{row.symbol}</span> },
              {
                key: 'raw',
                header: 'Amount',
                align: 'right',
                cell: (row) => <span className="tabular">{tokenAmount(row.raw ?? 0n, decimalsOf(row))}</span>,
              },
              {
                key: 'price',
                header: 'Feed price',
                align: 'right',
                cell: (row) => (
                  <span className="tabular">
                    {row.priceE8 === undefined ? 'Unread' : feedPrice(row.priceE8)}
                    {row.updatedAt !== undefined && (
                      <span className="block text-note text-[color:var(--color-muted)]">{formatRelative(row.updatedAt, now)}</span>
                    )}
                  </span>
                ),
              },
              {
                key: 'value',
                header: 'Value',
                align: 'right',
                cell: (row) => <span className="tabular">{row.value === undefined ? 'Unread' : usdExact(row.value as Micro)}</span>,
              },
              {
                key: 'counts',
                header: 'Spending power',
                cell: (row) =>
                  row.fresh === undefined ? (
                    'Unread'
                  ) : row.fresh ? (
                    <LevelBadge level="ok">
                      Counts{row.haircutBps ? `, less ${bps(row.haircutBps)}` : ''}
                    </LevelBadge>
                  ) : (
                    <LevelBadge level="attention">Stale price, not counted</LevelBadge>
                  ),
              },
            ]}
          />

          {(rwa.vaultHeld ?? 0n) > 0n && (
            <p className="text-detail text-[color:var(--color-muted)]">
              {usdExact(rwa.vaultHeld as Micro)} is waiting in the parking vault and counts toward spending power.
            </p>
          )}

          {!isOwner && <BufferNote rwa={rwa} />}

          {isOwner ? <OwnerForms rwa={rwa} onChange={onChange} /> : (
            <p className="text-detail text-[color:var(--color-muted)]">Only the owner can park and unpark.</p>
          )}
        </div>
      </Card>
    </Section>
  );
}

function BufferNote({ rwa }: { readonly rwa: RwaState }) {
  const { account } = useMandateScope();
  if (!account || (rwa.buffer ?? 0n) === 0n || parkableOf(account.balance, rwa.vaultHeld ?? 0n, rwa.buffer ?? 0n) > 0n) return null;
  return <p className="text-detail text-[color:var(--color-muted)]">{bufferSentence(account.balance, rwa.buffer ?? 0n)}</p>;
}

function OwnerForms({ rwa, onChange }: { readonly rwa: RwaState; readonly onChange: () => void }) {
  const { address, account, connected, system, writeContext, refresh } = useMandateScope();
  const { writeContractAsync } = useWriteContract();
  const [parkSymbol, setParkSymbol] = useState(rwa.positions[0]?.symbol ?? '');
  const [parkText, setParkText] = useState('');
  const [unparkSymbol, setUnparkSymbol] = useState(rwa.positions.find((p) => (p.raw ?? 0n) > 0n)?.symbol ?? '');
  const [unparkText, setUnparkText] = useState('');
  const [bufferText, setBufferText] = useState('');

  if (!account) return null;

  const done = () => {
    onChange();
    refresh();
  };
  const vaultHeld = rwa.vaultHeld ?? 0n;
  const target = rwa.positions.find((p) => p.symbol === parkSymbol);
  const parkable = parkableOf(account.balance, vaultHeld, rwa.buffer ?? 0n);
  const park = readUsdgAmount(parkText, {
    ceiling: {
      most: parkable as Micro,
      over: `Up to ${usd(parkable as Micro)} can be parked while the mandate keeps its ${usd((rwa.buffer ?? 0n) as Micro)} buffer.`,
    },
  });
  const shortfall = park.value === undefined ? 0n : park.value > vaultHeld ? park.value - vaultHeld : 0n;

  const source = rwa.positions.find((p) => p.symbol === unparkSymbol);
  const sourceValue = source?.raw !== undefined && source.priceE8 ? holdingValue(source.raw, source.priceE8, decimalsOf(source)) : undefined;
  const unpark = readUsdgAmount(unparkText, {
    ...(sourceValue === undefined ? {} : { ceiling: { most: sourceValue as Micro, over: `The position is worth ${usdExact(sourceValue as Micro)}.` } }),
  });
  const unparkAll = unpark.value !== undefined && sourceValue !== undefined && unpark.value === sourceValue;
  const unparkRaw =
    unpark.value === undefined || source?.raw === undefined || !source.priceE8
      ? undefined
      : unparkAll
        ? source.raw
        : minBig(usdgMicrosToRaw(unpark.value, source.priceE8, decimalsOf(source)), source.raw);
  const band = source?.asset?.config?.bandBps ?? 0;
  const minUsdg =
    unparkRaw === undefined || !source?.priceE8
      ? 0n
      : (holdingValue(unparkRaw, source.priceE8, decimalsOf(source)) * BigInt(10_000 - band)) / 10_000n;

  const buffer = readUsdgAmount(bufferText);

  const select = (value: string, onSelect: (value: string) => void, rows: readonly ParkPosition[]) => (
    <select
      value={value}
      onChange={(event) => onSelect(event.target.value)}
      className="h-11 w-full border border-[color:var(--color-line)] bg-surface px-3 text-sm"
    >
      {rows.map((row) => (
        <option key={row.adapter} value={row.symbol}>
          {row.symbol}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-6">
      <FieldGrid columns={2}>
        <Field
          label="Park USDG"
          hint="Two steps: move USDG into the parking vault, then buy the holding."
        >
          <div className="space-y-3">
            {select(parkSymbol, setParkSymbol, rwa.positions)}
            <AmountInput
              label="Amount"
              asset="USDG"
              value={parkText}
              onChange={setParkText}
              {...(parkText.trim() === '' || park.problem === undefined ? {} : { problem: park.problem })}
              hint={`This mandate holds ${usd(account.balance)}. Up to ${usd(parkable as Micro)} can be parked.`}
            />
            {parkable === 0n ? (
              <p className="text-detail" style={{ color: 'var(--color-state-attention)' }}>
                {bufferSentence(account.balance, rwa.buffer ?? 0n)}
              </p>
            ) : shortfall > 0n ? (
              <TxButton
                label="Move the USDG into the vault"
                tone="secondary"
                disabled={park.value === undefined || rwa.vault === undefined}
                blockedBy={transferGates(system)}
                context={{ ...writeContext, amount: shortfall as Micro }}
                send={() =>
                  writeContractAsync({
                    address,
                    abi: mandateAccountAbi as Abi,
                    functionName: 'withdraw',
                    args: [ADDRESSES.usdg, rwa.vault, shortfall],
                  })
                }
                onConfirmed={done}
              />
            ) : (
              <TxButton
                label={`Park in ${parkSymbol}`}
                disabled={park.value === undefined || target === undefined}
                blockedBy={transferGates(system)}
                context={{ ...writeContext, ...(park.value === undefined ? {} : { amount: park.value }) }}
                send={async () => {
                  const request = {
                    address: rwa.lane.TreasuryPark,
                    abi: treasuryParkAbi as Abi,
                    functionName: 'park',
                    args: [address, target?.adapter, park.value, 0n],
                  } as const;
                  await refuseEarly({ ...request, account: connected as `0x${string}` });
                  return writeContractAsync(request);
                }}
                onConfirmed={() => {
                  setParkText('');
                  done();
                }}
              />
            )}
          </div>
        </Field>

        <Field label="Unpark" hint="Sells the holding for USDG, paid into the mandate.">
          <div className="space-y-3">
            {select(unparkSymbol, setUnparkSymbol, rwa.positions.filter((p) => (p.raw ?? 0n) > 0n))}
            <AmountInput
              label="Amount"
              asset="USDG"
              value={unparkText}
              onChange={setUnparkText}
              {...(sourceValue === undefined ? {} : { max: { atomic: sourceValue, label: 'All of it' } })}
              {...(unparkText.trim() === '' || unpark.problem === undefined ? {} : { problem: unpark.problem })}
              hint={
                unparkRaw === undefined
                  ? 'Valued at the feed price.'
                  : `Sells ${tokenAmount(unparkRaw, source ? decimalsOf(source) : USDG_DECIMALS)} ${unparkSymbol} for at least ${usdExact(minUsdg as Micro)}.`
              }
            />
            <TxButton
              label="Unpark"
              tone="secondary"
              disabled={unparkRaw === undefined || unparkRaw === 0n || source === undefined}
              blockedBy={callGates(system)}
              context={writeContext}
              send={async () => {
                const request = {
                  address: rwa.lane.TreasuryPark,
                  abi: treasuryParkAbi as Abi,
                  functionName: 'unpark',
                  args: [address, source?.adapter, unparkRaw, minUsdg],
                } as const;
                await refuseEarly({ ...request, account: connected as `0x${string}` });
                return writeContractAsync(request);
              }}
              onConfirmed={() => {
                setUnparkText('');
                done();
              }}
            />
          </div>
        </Field>
      </FieldGrid>

      <FieldGrid columns={2}>
        <Field
          label="Buffer"
          hint={`USDG kept on hand for payments, now ${usd((rwa.buffer ?? 0n) as Micro)}. Only the amount above it can be parked.`}
        >
          <div className="space-y-3">
            <AmountInput
              label="Keep at least"
              asset="USDG"
              value={bufferText}
              onChange={setBufferText}
              {...(bufferText.trim() === '' || buffer.problem === undefined ? {} : { problem: buffer.problem })}
            />
            <TxButton
              label="Set the buffer"
              tone="secondary"
              disabled={buffer.value === undefined}
              blockedBy={callGates(system)}
              context={writeContext}
              send={() =>
                writeContractAsync({
                  address: rwa.lane.TreasuryPark,
                  abi: treasuryParkAbi as Abi,
                  functionName: 'setBuffer',
                  args: [address, buffer.value],
                })
              }
              onConfirmed={() => {
                setBufferText('');
                done();
              }}
            />
          </div>
        </Field>
        {vaultHeld > 0n && (
          <Field label="Waiting in the vault" hint="USDG moved out of the mandate and not parked yet.">
            <div className="space-y-3">
              <p className="tabular text-sm">{usdExact(vaultHeld as Micro)}</p>
              <TxButton
                label="Send it back to the mandate"
                tone="secondary"
                blockedBy={transferGates(system)}
                context={writeContext}
                send={() =>
                  writeContractAsync({
                    address: rwa.lane.TreasuryPark,
                    abi: treasuryParkAbi as Abi,
                    functionName: 'returnIdle',
                    args: [address],
                  })
                }
                onConfirmed={done}
              />
            </div>
          </Field>
        )}
      </FieldGrid>
    </div>
  );
}

/**
 * What can be parked now. The mandate has to hold at least its buffer once the USDG has moved to
 * the vault, so only USDG already in the vault and the balance above the buffer can go.
 */
export function parkableOf(balance: bigint, vaultHeld: bigint, buffer: bigint): bigint {
  return vaultHeld + (balance > buffer ? balance - buffer : 0n);
}

/** Why nothing can be parked, with the two ways out. */
export function bufferSentence(balance: bigint, buffer: bigint): string {
  if (buffer === 0n) return 'The mandate holds no USDG to park.';
  return `The mandate keeps ${usd(buffer as Micro)} on hand for payments and holds ${usd(balance as Micro)}, so there is nothing to park yet. Add funds or lower the buffer.`;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
