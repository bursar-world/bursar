'use client';

import { useState } from 'react';
import type { Micro } from '@bursar/core';
import { mandateAccountAbi, priceGuardAbi, stockSpendRouterAbi } from '@bursar/core';
import type { Abi } from 'viem';

import { rhcClient } from '@/chain/client';
import { sameAddress } from '@/chain/rhc';
import { AmountInput } from '@/components/amount-input';
import { Badge, LevelBadge } from '@/components/badge';
import { TextField } from '@/components/fields';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { Table } from '@/components/table';
import { TxButton } from '@/components/tx-button';
import { bps, usd, usdExact } from '@/money';
import { formatRelative } from '@/lib/time';
import { readUsdgAmount } from '../lib/amount';
import {
  allowsRwa,
  feedPrice,
  holdingValue,
  hours,
  minOutAt,
  refuseEarly,
  refusalInText,
  routerSet,
  tokenAmount,
  useRwa,
} from '../lib/rwa';
import type { RwaAsset, RwaState } from '../lib/rwa';
import { callGates, transferGates } from '../lib/write-gates';
import { useMandateScope } from './mandate-scope';
import { useWriteContract } from '@/wallet/write';

export function StockPanel() {
  const { address, account } = useMandateScope();
  const rwa = useRwa(address, account?.contractSet === 'v2');

  if (!account || account.contractSet !== 'v2' || rwa.data === undefined) return null;

  return <StockBody rwa={rwa.data} onChange={() => void rwa.refetch()} />;
}

function StockBody({ rwa, onChange }: { readonly rwa: RwaState; readonly onChange: () => void }) {
  const { account, connected, isOwner } = useMandateScope();
  if (!account) return null;

  const stocks = rwa.assets.filter((asset) => asset.kind === 'stock');
  const classOn = allowsRwa(account.limits.classMask);
  const isAgent = sameAddress(connected, account.agent);
  const now = rwa.chainTime ?? new Date();
  const holdings = stocks.filter((asset) => (asset.held ?? 0n) > 0n);
  const heldValue = holdings.reduce(
    (sum, asset) => sum + (asset.priceE8 ? holdingValue(asset.held ?? 0n, asset.priceE8, asset.config?.decimals) : 0n),
    0n,
  );
  const tradeStaleness = stocks.find((asset) => asset.config)?.config?.tradeStaleness;

  return (
    <Section
      title="Stock purchases"
      description={`The agent buys listed stocks with USDG from this mandate, at the feed price and inside the slippage limit.${
        tradeStaleness === undefined ? '' : ` Prices older than ${hours(tradeStaleness)} are refused.`
      }`}
    >
      <Card>
        <div className="space-y-6">
          <StatGrid columns={3}>
            <Stat
              label="Stock purchases"
              value={classOn ? 'Allowed' : 'Off'}
              level={classOn ? 'ok' : 'blocked'}
              hint={classOn ? 'Eligible stocks is on in this mandate’s spend classes.' : 'The owner turns on eligible stocks in the limits.'}
            />
            <Stat
              label="Slippage limit"
              value={rwa.slippageBps === undefined ? 'Unread' : rwa.slippageBps === 0 ? 'Asset band' : bps(rwa.slippageBps)}
              hint="The most a fill may fall below the feed price. It never goes wider than the asset’s own band."
            />
            <Stat
              label="Stocks held, at feed price"
              value={usdExact(heldValue as Micro)}
              hint="Each holding valued at its raw amount times the feed price."
            />
          </StatGrid>

          <Table<RwaAsset>
            caption="Listed stocks"
            rows={stocks}
            rowKey={(row) => row.address}
            columns={[
              { key: 'symbol', header: 'Stock', cell: (row) => <span className="font-medium">{row.symbol}</span> },
              {
                key: 'price',
                header: 'Feed price',
                align: 'right',
                cell: (row) => <span className="tabular">{row.priceE8 === undefined ? 'Unread' : feedPrice(row.priceE8)}</span>,
              },
              {
                key: 'age',
                header: 'Updated',
                cell: (row) => (row.updatedAt === undefined ? 'Unread' : formatRelative(row.updatedAt, now)),
                secondary: true,
              },
              {
                key: 'eligible',
                header: 'Eligible',
                cell: (row) =>
                  row.config === undefined ? (
                    'Unread'
                  ) : !row.config.eligible ? (
                    <LevelBadge level="blocked">No</LevelBadge>
                  ) : row.tradeRefusal ? (
                    <LevelBadge level="attention">{row.tradeRefusal}</LevelBadge>
                  ) : (
                    <LevelBadge level="ok">Yes</LevelBadge>
                  ),
              },
              {
                key: 'allowed',
                header: 'This mandate',
                cell: (row) => (row.allowed === undefined ? 'Unread' : row.allowed ? <Badge>Allowed</Badge> : <Badge tone="quiet">Not allowed</Badge>),
              },
              {
                key: 'held',
                header: 'Held',
                align: 'right',
                cell: (row) =>
                  (row.held ?? 0n) === 0n ? (
                    <span className="text-[color:var(--color-muted)]">None</span>
                  ) : (
                    <span className="tabular">
                      {tokenAmount(row.held ?? 0n, row.config?.decimals)} {row.symbol}
                      {row.priceE8 !== undefined && (
                        <span className="block text-note text-[color:var(--color-muted)]">
                          {usdExact(holdingValue(row.held ?? 0n, row.priceE8, row.config?.decimals) as Micro)}
                        </span>
                      )}
                    </span>
                  ),
              },
            ]}
          />

          {isOwner && <PolicyForm rwa={rwa} stocks={stocks} onChange={onChange} />}

          {isAgent ? (
            <BuyForm rwa={rwa} stocks={stocks} classOn={classOn} onChange={onChange} />
          ) : (
            <p className="text-detail text-[color:var(--color-muted)]">
              Purchases are sent by the agent wallet on this mandate. Connect it to buy.
            </p>
          )}
        </div>
      </Card>
    </Section>
  );
}

function PolicyForm({ rwa, stocks, onChange }: { readonly rwa: RwaState; readonly stocks: readonly RwaAsset[]; readonly onChange: () => void }) {
  const { address, system, writeContext } = useMandateScope();
  const { writeContractAsync } = useWriteContract();
  const [slippageText, setSlippageText] = useState(rwa.slippageBps === undefined ? '' : String(rwa.slippageBps / 100));
  const [allowed, setAllowed] = useState<Readonly<Record<string, boolean>>>(
    Object.fromEntries(stocks.map((asset) => [asset.address, asset.allowed === true])),
  );

  const percent = Number(slippageText);
  const slippageBps = Math.round(percent * 100);
  const slippageProblem =
    slippageText.trim() === '' || !Number.isFinite(percent) || percent < 0
      ? 'Enter a percentage, such as 1.'
      : slippageBps >= 10_000
        ? 'The slippage limit has to be below 100%.'
        : undefined;

  return (
    <div className="space-y-4 border border-[color:var(--color-line)] p-4">
      <div>
        <h3 className="text-sm font-semibold">Purchase policy</h3>
        <p className="mt-0.5 text-detail text-[color:var(--color-muted)]">
          Which stocks the agent may buy for this mandate, and how far below the feed price a fill may land.
        </p>
      </div>

      {!routerSet(rwa.router) && (
        <div className="space-y-2">
          <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
            No purchase router is set on this mandate, so every purchase is refused.
          </p>
          <TxButton
            label="Set the purchase router"
            blockedBy={callGates(system)}
            context={writeContext}
            send={() =>
              writeContractAsync({
                address,
                abi: mandateAccountAbi as Abi,
                functionName: 'setRouter',
                args: [rwa.lane.StockSpendRouter],
              })
            }
            onConfirmed={onChange}
          />
        </div>
      )}

      <FieldGrid columns={2}>
        <TextField
          label="Slippage limit"
          value={slippageText}
          onChange={setSlippageText}
          suffix="%"
          {...(slippageProblem === undefined ? {} : { problem: slippageProblem })}
          help="0 uses the asset’s own band. A wider limit is held to the band."
        />
        <Field label="Allowed stocks">
          <div className="flex flex-wrap gap-4 pt-1">
            {stocks.map((asset) => (
              <label key={asset.address} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={allowed[asset.address] === true}
                  onChange={(event) => setAllowed({ ...allowed, [asset.address]: event.target.checked })}
                />
                {asset.symbol}
              </label>
            ))}
          </div>
        </Field>
      </FieldGrid>

      <TxButton
        label="Save the purchase policy"
        tone="secondary"
        disabled={slippageProblem !== undefined}
        blockedBy={callGates(system)}
        context={writeContext}
        send={() =>
          writeContractAsync({
            address: rwa.lane.StockSpendRouter,
            abi: stockSpendRouterAbi as Abi,
            functionName: 'setPolicy',
            args: [address, slippageBps, stocks.map((asset) => asset.address), stocks.map((asset) => allowed[asset.address] === true)],
          })
        }
        onConfirmed={onChange}
      />
    </div>
  );
}

function BuyForm({
  rwa,
  stocks,
  classOn,
  onChange,
}: {
  readonly rwa: RwaState;
  readonly stocks: readonly RwaAsset[];
  readonly classOn: boolean;
  readonly onChange: () => void;
}) {
  const { address, account, connected, system, writeContext, refresh } = useMandateScope();
  const { writeContractAsync } = useWriteContract();
  const [symbol, setSymbol] = useState(stocks.find((asset) => asset.allowed)?.symbol ?? stocks[0]?.symbol ?? '');
  const [amountText, setAmountText] = useState('');

  if (!account) return null;

  const asset = stocks.find((entry) => entry.symbol === symbol);
  const config = asset?.config;
  const amount = readUsdgAmount(amountText, {
    ceiling: { most: account.balance, over: `This mandate holds ${usd(account.balance)}.` },
  });

  const refusals: string[] = [];
  if (!classOn) refusals.push('This mandate does not allow stock purchases. The owner turns on eligible stocks in the limits.');
  if (!routerSet(rwa.router)) refusals.push('No purchase router is set on this mandate. The owner sets it in the purchase policy.');
  if (asset?.allowed === false) refusals.push(`The owner has not allowed ${symbol} for this mandate.`);
  if (config && !config.eligible) refusals.push(`${symbol} is not eligible for purchase right now.`);
  if (asset?.tradeRefusal) refusals.push(asset.tradeRefusal);
  if (config && amount.value !== undefined && amount.value > config.perTradeCap) {
    refusals.push(`${symbol} purchases are capped at ${usd(config.perTradeCap as Micro)} each.`);
  }
  if (amount.value !== undefined && amount.value > account.remaining.perCall) {
    refusals.push(`The most this mandate allows per payment right now is ${usd(account.remaining.perCall)}.`);
  }

  const floor =
    amount.value !== undefined && asset?.priceE8 && config
      ? minOutAt(amount.value, asset.priceE8, config.decimals, rwa.slippageBps ?? 0, config.bandBps)
      : undefined;

  return (
    <div className="space-y-4 border border-[color:var(--color-line)] p-4">
      <div>
        <h3 className="text-sm font-semibold">Buy a stock</h3>
        <p className="mt-0.5 text-detail text-[color:var(--color-muted)]">
          Counted against the mandate’s limits like any payment. A fill is final and is never credited back.
        </p>
      </div>
      <FieldGrid columns={2}>
        <Field label="Stock">
          <select
            aria-label="Stock"
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            className="h-11 w-full border border-[color:var(--color-line)] bg-surface px-3 text-sm"
          >
            {stocks.map((entry) => (
              <option key={entry.address} value={entry.symbol}>
                {entry.symbol}
                {entry.priceE8 === undefined ? '' : `, ${feedPrice(entry.priceE8)}`}
              </option>
            ))}
          </select>
        </Field>
        <AmountInput
          label="Spend"
          asset="USDG"
          value={amountText}
          onChange={setAmountText}
          {...(amountText.trim() === '' || amount.problem === undefined ? {} : { problem: amount.problem })}
          hint={
            floor === undefined || !config
              ? `This mandate holds ${usd(account.balance)}.`
              : `At least ${tokenAmount(floor, config.decimals)} ${symbol}, or the purchase is refused.`
          }
        />
      </FieldGrid>

      {refusals.length > 0 && (
        <ul className="space-y-1 text-detail" style={{ color: 'var(--color-state-blocked)' }}>
          {refusals.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      <TxButton
        label={`Buy ${symbol}`}
        disabled={amount.value === undefined || asset === undefined || refusals.length > 0}
        blockedBy={transferGates(system)}
        context={{ ...writeContext, ...(amount.value === undefined ? {} : { amount: amount.value }) }}
        send={async () => {
          const usdgIn = amount.value as Micro;
          const target = asset as RwaAsset;
          const [minOut, valuation] = await Promise.all([
            readMinOut(rwa, address, target, usdgIn),
            readValuation(rwa, target),
          ]);
          const request = {
            address,
            abi: mandateAccountAbi as Abi,
            functionName: 'buy',
            args: [target.address, usdgIn, minOut, valuation],
          } as const;
          await refuseEarly({ ...request, account: connected as `0x${string}` });
          return writeContractAsync(request);
        }}
        onConfirmed={() => {
          setAmountText('');
          onChange();
          refresh();
        }}
      />
    </div>
  );
}

async function readMinOut(rwa: RwaState, mandate: `0x${string}`, asset: RwaAsset, usdgIn: bigint): Promise<bigint> {
  try {
    return (await rhcClient().readContract({
      address: rwa.lane.StockSpendRouter,
      abi: stockSpendRouterAbi as Abi,
      functionName: 'minOutFor',
      args: [mandate, asset.address, usdgIn],
    })) as bigint;
  } catch (error) {
    const reason = refusalInText(String(error));
    throw reason === undefined ? error : new Error(reason);
  }
}

async function readValuation(rwa: RwaState, asset: RwaAsset): Promise<bigint> {
  const [price] = (await rhcClient().readContract({
    address: rwa.lane.PriceGuard,
    abi: priceGuardAbi as Abi,
    functionName: 'valuationPrice',
    args: [asset.address],
  })) as readonly [bigint, bigint, boolean];
  return price;
}
