'use client';

import { useState } from 'react';
import type { Micro } from '@bursar/core';
import { mandateAccountAbi, priceGuardAbi, stockSpendRouterAbi } from '@bursar/core';
import type { Abi } from 'viem';

import { rhcClient } from '@/chain/client';
import { onCurrentSet } from '@/chain/deployments';
import { sameAddress } from '@/chain/rhc';
import { AmountInput } from '@/components/amount-input';
import { Badge, LevelBadge } from '@/components/badge';
import { TextField } from '@/components/fields';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { Table } from '@/components/table';
import { TxButton } from '@/components/tx-button';
import { bps, usd } from '@/money';
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
  const served = account !== undefined && onCurrentSet(account.contractSet);
  const rwa = useRwa(address, served);

  if (!account || !served || rwa.data === undefined) return null;

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
  const band = stockBand(stocks);

  return (
    <Section
      title="Stock purchases"
      description={`The agent can buy listed stocks with this mandate’s USDG, at the feed price within your slippage limit.${
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
              hint={classOn ? 'Turned on in this mandate’s limits.' : 'The owner can turn them on in the limits.'}
            />
            <Stat
              label="Slippage limit"
              value={rwa.slippageBps === undefined ? 'Unread' : rwa.slippageBps !== 0 ? bps(rwa.slippageBps) : band === undefined ? 'Each stock’s own' : bps(band)}
              hint={
                rwa.slippageBps === 0
                  ? 'How far below the feed price a purchase may fill. No tighter limit is set, so each stock’s own applies.'
                  : 'How far below the feed price a purchase may fill. Never wider than the stock’s own limit.'
              }
            />
            <Stat
              label="Stocks held, at feed price"
              value={usd(heldValue as Micro)}
              hint="Valued at the feed price."
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
                          {usd(holdingValue(row.held ?? 0n, row.priceE8, row.config?.decimals) as Micro)}
                        </span>
                      )}
                    </span>
                  ),
              },
            ]}
          />

          {isOwner && <PolicyForm rwa={rwa} stocks={stocks} onChange={onChange} />}
          {isOwner && <TakeOutForm stocks={holdings} onChange={onChange} />}

          {isAgent ? (
            <BuyForm rwa={rwa} stocks={stocks} classOn={classOn} onChange={onChange} />
          ) : (
            <p className="text-detail text-[color:var(--color-muted)]">
              Purchases are made by this mandate’s agent. Connect the agent wallet to buy.
            </p>
          )}
        </div>
      </Card>
    </Section>
  );
}

/** The band every listed stock shares, when they share one: the slippage a purchase gets with no tighter limit set. */
function stockBand(stocks: readonly RwaAsset[]): number | undefined {
  const bands = new Set(stocks.flatMap((asset) => (asset.config === undefined ? [] : [asset.config.bandBps])));
  return bands.size === 1 ? [...bands][0] : undefined;
}

function PolicyForm({ rwa, stocks, onChange }: { readonly rwa: RwaState; readonly stocks: readonly RwaAsset[]; readonly onChange: () => void }) {
  const band = stockBand(stocks);
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
          Choose which stocks the agent may buy and how far below the feed price a purchase may fill.
        </p>
      </div>

      {!routerSet(rwa.router) && (
        <div className="space-y-2">
          <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
            Set the purchase router once to turn on stock purchases.
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
          help={`0 uses each stock’s own limit${band === undefined ? '' : `, ${bps(band)}`}. A wider limit is capped at it.`}
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

/** The owner's way to the stocks the agent bought: the whole holding, to the connected wallet. */
function TakeOutForm({ stocks, onChange }: { readonly stocks: readonly RwaAsset[]; readonly onChange: () => void }) {
  const { address, connected, system, writeContext, refresh } = useMandateScope();
  const { writeContractAsync } = useWriteContract();
  const [pick, setPick] = useState('');
  const asset = stocks.find((entry) => entry.symbol === pick) ?? stocks[0];
  if (asset === undefined) return null;
  const held = asset.held ?? 0n;

  return (
    <div className="space-y-4 border border-[color:var(--color-line)] p-4">
      <div>
        <h3 className="text-sm font-semibold">Take stocks out</h3>
        <p className="mt-0.5 text-detail text-[color:var(--color-muted)]">
          Sends a holding to your wallet, where you can keep it, sell it or post it as collateral.
        </p>
      </div>
      <FieldGrid columns={2}>
        <Field label="Holding">
          <select
            aria-label="Holding to take out"
            value={asset.symbol}
            onChange={(event) => setPick(event.target.value)}
            className="h-11 w-full border border-[color:var(--color-line)] bg-surface px-3 text-sm"
          >
            {stocks.map((entry) => (
              <option key={entry.address} value={entry.symbol}>
                {entry.symbol}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount" hint="All of it.">
          <span className="tabular">
            {tokenAmount(held, asset.config?.decimals)} {asset.symbol}
          </span>
        </Field>
      </FieldGrid>
      <TxButton
        label={`Send the ${asset.symbol} to your wallet`}
        tone="secondary"
        disabled={connected === undefined || held === 0n}
        blockedBy={transferGates(system)}
        context={writeContext}
        send={() =>
          writeContractAsync({
            address,
            abi: mandateAccountAbi as Abi,
            functionName: 'withdraw',
            args: [asset.address, connected as `0x${string}`, held],
          })
        }
        onConfirmed={() => {
          onChange();
          refresh();
        }}
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
  if (!classOn) refusals.push('Stock purchases are off for this mandate. The owner can turn them on in the limits.');
  if (!routerSet(rwa.router)) refusals.push('The purchase router is not set. The owner sets it in the purchase policy.');
  if (asset?.allowed === false) refusals.push(`The owner has not allowed ${symbol} for this mandate.`);
  if (config && !config.eligible) refusals.push(`${symbol} is not eligible for purchase right now.`);
  if (asset?.tradeRefusal) refusals.push(asset.tradeRefusal);
  if (config && amount.value !== undefined && amount.value > config.perTradeCap) {
    refusals.push(`${symbol} purchases are capped at ${usd(config.perTradeCap as Micro)} each.`);
  }
  if (amount.value !== undefined && amount.value > account.remaining.perCall) {
    refusals.push(`This mandate allows up to ${usd(account.remaining.perCall)} per payment right now.`);
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
          Counts against the mandate’s limits like any payment. Purchases are final.
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
              : `You receive at least ${tokenAmount(floor, config.decimals)} ${symbol}, or the purchase is refused.`
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
