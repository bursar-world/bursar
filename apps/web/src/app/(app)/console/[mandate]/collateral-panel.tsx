'use client';

import { useState } from 'react';
import { COLLATERAL_LANE, collateralVaultAbi, creditPoolAbi, mandateAccountAbi, settlementAssetAbi } from '@bursar/core';
import type { Micro } from '@bursar/core';
import Link from 'next/link';
import { erc20Abi } from 'viem';
import type { Abi, Address } from 'viem';

import { collateralLane, creditWired, formatHealth, formatRatio, liquidatable } from '@/chain/collateral';
import type { CollateralAccount, CollateralPosition } from '@/chain/collateral';
import { ADDRESSES } from '@/chain/rhc';
import { AmountInput } from '@/components/amount-input';
import { LevelBadge } from '@/components/badge';
import { TextField } from '@/components/fields';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { Table } from '@/components/table';
import { TxButton } from '@/components/tx-button';
import { bps, parseAmount, usdExact } from '@/money';
import { formatRelative } from '@/lib/time';
import { readUsdgAmount } from '../lib/amount';
import { checkFirst, useCollateral } from '../lib/collateral';
import { feedPrice, tokenAmount } from '../lib/rwa';
import { callGates } from '../lib/write-gates';
import { useMandateScope } from './mandate-scope';
import { useWriteContract } from '@/wallet/write';

export function CollateralPanel() {
  const { address, account, connected } = useMandateScope();
  const v2 = account?.contractSet === 'v2';
  const inLane = account?.limits.lane === COLLATERAL_LANE;
  const collateral = useCollateral(address, connected, v2 && inLane);

  if (!account || !v2 || collateralLane() === undefined) return null;
  if (!inLane) {
    return (
      <p className="text-detail text-[color:var(--color-muted)]">
        This mandate is prefunded. It spends only the USDG it holds and cannot borrow.
      </p>
    );
  }
  if (collateral.data === undefined) return null;

  return <CollateralBody state={collateral.data} onChange={() => void collateral.refetch()} />;
}

function CollateralBody({ state, onChange }: { readonly state: CollateralAccount; readonly onChange: () => void }) {
  const { isOwner } = useMandateScope();
  const now = state.chainTime ?? new Date();
  const floor = state.terms === undefined ? undefined : formatRatio(state.terms.minBorrowHealth);

  return (
    <Section
      title="Collateral and credit"
      description={`Stock and treasury tokens posted for this mandate, and the USDG it has borrowed against them. When a payment needs more USDG than the mandate holds, it borrows the difference in the same transaction${
        floor === undefined ? '' : `, as long as health stays at or above ${floor}`
      }.`}
      actions={
        <Link href="/docs/haircuts" className="text-detail underline underline-offset-2">
          Haircut tiers
        </Link>
      }
    >
      <Card>
        <div className="space-y-6">
          <StatGrid columns={4}>
            <Stat
              label="Collateral value"
              value={state.value === undefined ? 'Unread' : usdExact(state.value as Micro)}
              hint="Token amount times the Chainlink price. A stale or paused price counts zero."
            />
            <Stat label="Debt" value={state.debt === undefined ? 'Unread' : usdExact(state.debt as Micro)} hint="Borrowed USDG plus the spread accrued on it." />
            <Stat
              label="Can still borrow"
              value={state.headroom === undefined ? 'Unread' : usdExact(state.headroom as Micro)}
              hint="The most a payment can draw now without taking health below the floor or past the credit limits."
            />
            <Stat
              label="Health"
              value={formatHealth(state.healthE18)}
              hint="Collateral value after haircuts, divided by debt. Below 1.00 anyone can sell part of the collateral to repay."
            />
          </StatGrid>

          {liquidatable(state.healthE18) && (
            <LevelBadge level="blocked">Health is below 1.00. Part of the collateral can be sold to repay the debt.</LevelBadge>
          )}

          <Table<CollateralPosition>
            caption="Posted collateral"
            rows={state.positions.filter((p) => p.raw > 0n)}
            rowKey={(row) => row.asset}
            empty={<p className="text-detail text-[color:var(--color-muted)]">Nothing is posted yet.</p>}
            columns={[
              { key: 'symbol', header: 'Asset', cell: (row) => <span className="font-medium">{row.symbol}</span> },
              { key: 'raw', header: 'Amount', align: 'right', cell: (row) => <span className="tabular">{tokenAmount(row.raw)}</span> },
              {
                key: 'price',
                header: 'Price',
                align: 'right',
                cell: (row) => (
                  <span className="tabular">
                    {row.priceE8 === 0n ? 'Unread' : feedPrice(row.priceE8)}
                    {row.updatedAt !== undefined && (
                      <span className="block text-note text-[color:var(--color-muted)]">{formatRelative(row.updatedAt, now)}</span>
                    )}
                  </span>
                ),
              },
              { key: 'value', header: 'Value', align: 'right', cell: (row) => <span className="tabular">{usdExact(row.value as Micro)}</span> },
              {
                key: 'haircut',
                header: 'Haircut',
                cell: (row) =>
                  !row.fresh ? (
                    <LevelBadge level="attention">Price is stale or paused, counts as zero</LevelBadge>
                  ) : (
                    <LevelBadge level={row.afterHours ? 'attention' : 'ok'}>
                      {bps(row.haircutBps)}
                      {row.afterHours ? ', after hours' : ''}
                    </LevelBadge>
                  ),
              },
            ]}
          />

          {isOwner ? <OwnerForms state={state} onChange={onChange} /> : (
            <p className="text-detail text-[color:var(--color-muted)]">Only the owner can open the line and post or withdraw collateral. Anyone can repay.</p>
          )}
          <RepayForm state={state} onChange={onChange} />
        </div>
      </Card>
    </Section>
  );
}

function OwnerForms({ state, onChange }: { readonly state: CollateralAccount; readonly onChange: () => void }) {
  const { address, connected, system, writeContext, refresh } = useMandateScope();
  const { writeContractAsync } = useWriteContract();
  const [symbol, setSymbol] = useState(state.positions[0]?.symbol ?? '');
  const [amountText, setAmountText] = useState('');

  const done = () => {
    onChange();
    refresh();
  };
  const vault = state.lane.CollateralVault;
  const wired = creditWired(state);

  if (!state.isLine || !wired) {
    return (
      <FieldGrid columns={2}>
        <Field label="Open the collateral line" hint="Registers this mandate with the collateral vault. Needed once.">
          <TxButton
            label={state.isLine ? 'Line is open' : 'Open the line'}
            disabled={state.isLine === true}
            blockedBy={callGates(system)}
            context={writeContext}
            send={async () => {
              const request = { address: vault, abi: collateralVaultAbi as Abi, functionName: 'openLine', args: [address] } as const;
              await checkFirst({ ...request, account: connected as Address });
              return writeContractAsync(request);
            }}
            onConfirmed={done}
          />
        </Field>
        <Field label="Borrow when short" hint="Sets the vault as the place this mandate asks for USDG when a payment needs more than it holds.">
          <TxButton
            label={wired ? 'Set' : 'Use the collateral line'}
            tone="secondary"
            disabled={wired}
            blockedBy={callGates(system)}
            context={writeContext}
            send={() => writeContractAsync({ address, abi: mandateAccountAbi as Abi, functionName: 'setTreasuryPark', args: [vault] })}
            onConfirmed={done}
          />
        </Field>
      </FieldGrid>
    );
  }

  const target = state.positions.find((p) => p.symbol === symbol);
  const parsed = parseAmount(amountText, 18);
  const raw = parsed.ok ? parsed.value : undefined;
  const needsApproval = raw !== undefined && (target?.allowance ?? 0n) < raw;

  return (
    <Field label="Post collateral" hint="Two steps the first time: approve the vault to take the tokens, then post them from your wallet.">
      <div className="space-y-3">
        <select
          value={symbol}
          onChange={(event) => setSymbol(event.target.value)}
          className="h-11 w-full border border-[color:var(--color-line)] bg-surface px-3 text-sm"
        >
          {state.positions.map((p) => (
            <option key={p.asset} value={p.symbol}>
              {p.symbol}
            </option>
          ))}
        </select>
        <TextField
          label="Token amount"
          value={amountText}
          onChange={setAmountText}
          {...(amountText.trim() === '' || parsed.ok ? {} : { problem: parsed.problem })}
          help={target?.walletHeld === undefined ? 'Connect the owner wallet to see its balance.' : `Your wallet holds ${tokenAmount(target.walletHeld)} ${symbol}.`}
        />
        {needsApproval ? (
          <TxButton
            label={`Approve ${symbol}`}
            tone="secondary"
            disabled={target === undefined}
            blockedBy={callGates(system)}
            context={writeContext}
            send={() => writeContractAsync({ address: target?.asset as Address, abi: erc20Abi, functionName: 'approve', args: [vault, raw] })}
            onConfirmed={done}
          />
        ) : (
          <TxButton
            label="Post collateral"
            disabled={raw === undefined || raw === 0n || target === undefined}
            blockedBy={callGates(system)}
            context={writeContext}
            send={async () => {
              const request = { address: vault, abi: collateralVaultAbi as Abi, functionName: 'deposit', args: [address, target?.asset, raw] } as const;
              await checkFirst({ ...request, account: connected as Address });
              return writeContractAsync(request);
            }}
            onConfirmed={() => {
              setAmountText('');
              done();
            }}
          />
        )}
      </div>
    </Field>
  );
}

function RepayForm({ state, onChange }: { readonly state: CollateralAccount; readonly onChange: () => void }) {
  const { address, connected, system, writeContext, refresh } = useMandateScope();
  const { writeContractAsync } = useWriteContract();
  const [text, setText] = useState('');

  if ((state.debt ?? 0n) === 0n) return null;

  const debt = state.debt as Micro;
  const amount = readUsdgAmount(text);
  const needsApproval = amount.value !== undefined && (state.usdgAllowance ?? 0n) < amount.value;
  const done = () => {
    onChange();
    refresh();
  };

  return (
    <Field label="Repay" hint="Paid from the connected wallet straight to the lending pool. Takes no more than the mandate owes.">
      <div className="space-y-3">
        <AmountInput
          label="Amount"
          asset="USDG"
          value={text}
          onChange={setText}
          max={{ atomic: debt, label: 'All of it' }}
          {...(text.trim() === '' || amount.problem === undefined ? {} : { problem: amount.problem })}
          hint={`This mandate owes ${usdExact(debt)}.`}
        />
        {needsApproval ? (
          <TxButton
            label="Approve USDG"
            tone="secondary"
            blockedBy={callGates(system)}
            context={writeContext}
            send={() =>
              writeContractAsync({
                address: ADDRESSES.usdg,
                abi: settlementAssetAbi as Abi,
                functionName: 'approve',
                // A hair over the debt, so the spread accrued before the repayment lands is covered.
                args: [state.lane.CreditPool, (amount.value ?? 0n) + 1_000n],
              })
            }
            onConfirmed={done}
          />
        ) : (
          <TxButton
            label="Repay"
            disabled={amount.value === undefined}
            blockedBy={callGates(system)}
            context={{ ...writeContext, ...(amount.value === undefined ? {} : { amount: amount.value }) }}
            send={async () => {
              const request = {
                address: state.lane.CreditPool,
                abi: creditPoolAbi as Abi,
                functionName: 'repay',
                args: [address, amount.value],
              } as const;
              await checkFirst({ ...request, account: connected as Address });
              return writeContractAsync(request);
            }}
            onConfirmed={() => {
              setText('');
              done();
            }}
          />
        )}
      </div>
    </Field>
  );
}
