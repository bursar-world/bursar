'use client';

import { useState } from 'react';
import type { Micro } from '@bursar/core';
import { mandateAccountAbi, priceGuardAbi, stockSpendRouterAbi } from '@bursar/core';
import { parseUnits } from 'viem';
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
import { approvalModeOf } from '../lib/format';
import {
  allowsRwa,
  feedPrice,
  holdingValue,
  hours,
  minOutAt,
  minUsdgAt,
  refuseEarly,
  refusalInText,
  routerIsCurrent,
  routerSet,
  tokenAmount,
  usdFloor,
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
  const heldValue = stocks.reduce(
    (sum, asset) =>
      sum + (asset.priceE8 ? holdingValue((asset.held ?? 0n) + (asset.sellable ?? 0n), asset.priceE8, asset.config?.decimals) : 0n),
    0n,
  );
  const tradeStaleness = stocks.find((asset) => asset.config)?.config?.tradeStaleness;
  const band = stockBand(stocks);

  return (
    <Section
      title="Stocks"
      description={`The agent can buy listed stocks with this mandate’s USDG, and sell what you release back to USDG, each at the feed price within your slippage limit.${
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
                  ? 'How far from the feed price a trade may fill. No tighter limit is set, so each stock’s own applies.'
                  : 'How far from the feed price a trade may fill. Never wider than the stock’s own limit.'
              }
            />
            <Stat label="Stocks held, at feed price" value={usd(heldValue as Micro)} hint="Held and released for sale, valued at the feed price." />
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
                cell: (row) => <PolicyBadges asset={row} />,
              },
              {
                key: 'held',
                header: 'Held',
                align: 'right',
                cell: (row) => <HoldingCell raw={row.held} asset={row} />,
              },
              {
                key: 'sellable',
                header: 'Released for sale',
                align: 'right',
                cell: (row) => <HoldingCell raw={row.sellable} asset={row} />,
              },
            ]}
          />

          {isOwner && <PolicyForm rwa={rwa} stocks={stocks} onChange={onChange} />}
          {isOwner && <ReleaseForm rwa={rwa} stocks={holdings} onChange={onChange} />}
          {isOwner && <TakeOutForm stocks={holdings} onChange={onChange} />}

          {isAgent || isOwner ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {isAgent ? (
                <BuyForm rwa={rwa} stocks={stocks} classOn={classOn} onChange={onChange} />
              ) : (
                <p className="text-detail text-[color:var(--color-muted)]">
                  Purchases are made by this mandate’s agent. Connect the agent wallet to buy.
                </p>
              )}
              <SellForm rwa={rwa} stocks={stocks} onChange={onChange} />
            </div>
          ) : (
            <p className="text-detail text-[color:var(--color-muted)]">
              Purchases and sales are made by this mandate’s agent, and sales by its owner too. Connect one of those wallets.
            </p>
          )}
        </div>
      </Card>
    </Section>
  );
}

function PolicyBadges({ asset }: { readonly asset: RwaAsset }) {
  if (asset.allowed === undefined || asset.saleAllowed === undefined) return <>Unread</>;
  if (!asset.allowed && !asset.saleAllowed) return <Badge tone="quiet">Not allowed</Badge>;
  return (
    <span className="flex flex-wrap gap-1">
      {asset.allowed && <Badge>Buy</Badge>}
      {asset.saleAllowed && <Badge>Sell</Badge>}
    </span>
  );
}

function HoldingCell({ raw, asset }: { readonly raw: bigint | undefined; readonly asset: RwaAsset }) {
  if (raw === undefined) return <>Unread</>;
  if (raw === 0n) return <span className="text-[color:var(--color-muted)]">None</span>;
  return (
    <span className="tabular">
      {tokenAmount(raw, asset.config?.decimals)} {asset.symbol}
      {asset.priceE8 !== undefined && (
        <span className="block text-note text-[color:var(--color-muted)]">{usd(holdingValue(raw, asset.priceE8, asset.config?.decimals) as Micro)}</span>
      )}
    </span>
  );
}

/** The band every listed stock shares, when they share one: the slippage a trade gets with no tighter limit set. */
function stockBand(stocks: readonly RwaAsset[]): number | undefined {
  const bands = new Set(stocks.flatMap((asset) => (asset.config === undefined ? [] : [asset.config.bandBps])));
  return bands.size === 1 ? [...bands][0] : undefined;
}

/** A count of a stock in its own units, as typed. */
function readTokenAmount(text: string, decimals: number | undefined, most: bigint): { value?: bigint; problem?: string } {
  if (text.trim() === '') return {};
  let value: bigint;
  try {
    value = parseUnits(text.trim(), decimals ?? 18);
  } catch {
    return { problem: 'Enter an amount, such as 0.001.' };
  }
  if (value <= 0n) return { problem: 'Enter an amount above zero.' };
  if (value > most) return { problem: `Up to ${tokenAmount(most, decimals)} is available.` };
  return { value };
}

function RouterNotice({ rwa, onChange }: { readonly rwa: RwaState; readonly onChange: () => void }) {
  const { address, system, writeContext } = useMandateScope();
  const { writeContractAsync } = useWriteContract();
  const unset = !routerSet(rwa.router);
  if (!unset && routerIsCurrent(rwa.router, rwa.lane)) return null;

  return (
    <div className="space-y-2">
      <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
        {unset
          ? 'Set the stock router once to turn on purchases and sales.'
          : 'This mandate trades through an earlier router. Switch to the current one to sell stocks and keep buying, then save both policies again: a policy lives on the router it was saved on.'}
      </p>
      <TxButton
        label={unset ? 'Set the stock router' : 'Switch to the current router'}
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
  );
}

function PolicyForm({ rwa, stocks, onChange }: { readonly rwa: RwaState; readonly stocks: readonly RwaAsset[]; readonly onChange: () => void }) {
  const band = stockBand(stocks);
  const { address, system, writeContext } = useMandateScope();
  const { writeContractAsync } = useWriteContract();
  const [slippageText, setSlippageText] = useState(rwa.slippageBps === undefined ? '' : String(rwa.slippageBps / 100));
  const [allowed, setAllowed] = useState<Readonly<Record<string, boolean>>>(
    Object.fromEntries(stocks.map((asset) => [asset.address, asset.allowed === true])),
  );
  const [sellable, setSellable] = useState<Readonly<Record<string, boolean>>>(
    Object.fromEntries(stocks.map((asset) => [asset.address, asset.saleAllowed === true])),
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
        <h3 className="text-sm font-semibold">Trading policy</h3>
        <p className="mt-0.5 text-detail text-[color:var(--color-muted)]">
          Choose which stocks the agent may buy, which it may sell, and how far from the feed price a trade may fill.
        </p>
      </div>

      <RouterNotice rwa={rwa} onChange={onChange} />

      <FieldGrid columns={3}>
        <TextField
          label="Slippage limit"
          value={slippageText}
          onChange={setSlippageText}
          suffix="%"
          {...(slippageProblem === undefined ? {} : { problem: slippageProblem })}
          help={`0 uses each stock’s own limit${band === undefined ? '' : `, ${bps(band)}`}. A wider limit is capped at it.`}
        />
        <Field label="May buy">
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
        <Field label="May sell">
          <div className="flex flex-wrap gap-4 pt-1">
            {stocks.map((asset) => (
              <label key={asset.address} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  aria-label={`May sell ${asset.symbol}`}
                  checked={sellable[asset.address] === true}
                  onChange={(event) => setSellable({ ...sellable, [asset.address]: event.target.checked })}
                />
                {asset.symbol}
              </label>
            ))}
          </div>
        </Field>
      </FieldGrid>

      <div className="flex flex-wrap gap-3">
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
        <TxButton
          label="Save the sale policy"
          tone="secondary"
          blockedBy={callGates(system)}
          context={writeContext}
          send={() =>
            writeContractAsync({
              address: rwa.lane.StockSpendRouter,
              abi: stockSpendRouterAbi as Abi,
              functionName: 'setSalePolicy',
              args: [address, stocks.map((asset) => asset.address), stocks.map((asset) => sellable[asset.address] === true)],
            })
          }
          onConfirmed={onChange}
        />
      </div>
    </div>
  );
}

/** The owner's way to make a holding sellable: part or all of it goes to the mandate's custody on the router. */
function ReleaseForm({ rwa, stocks, onChange }: { readonly rwa: RwaState; readonly stocks: readonly RwaAsset[]; readonly onChange: () => void }) {
  const { address, system, writeContext, refresh } = useMandateScope();
  const { writeContractAsync } = useWriteContract();
  const [pick, setPick] = useState('');
  const [amountText, setAmountText] = useState('');
  const asset = stocks.find((entry) => entry.symbol === pick) ?? stocks[0];
  if (asset === undefined || rwa.custody === undefined) return null;
  const held = asset.held ?? 0n;
  const amount = readTokenAmount(amountText, asset.config?.decimals, held);
  const releasing = amount.value ?? held;

  return (
    <div className="space-y-4 border border-[color:var(--color-line)] p-4">
      <div>
        <h3 className="text-sm font-semibold">Release for sale</h3>
        <p className="mt-0.5 text-detail text-[color:var(--color-muted)]">
          Moves a holding into the mandate’s sell custody, where the agent can sell it for USDG that lands back in the mandate. It stays the
          mandate’s: anything not sold can be returned.
        </p>
      </div>
      <FieldGrid columns={2}>
        <Field label="Holding">
          <select
            aria-label="Holding to release"
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
        <TextField
          label="Amount"
          value={amountText}
          onChange={setAmountText}
          suffix={asset.symbol}
          placeholder={tokenAmount(held, asset.config?.decimals)}
          {...(amount.problem === undefined ? {} : { problem: amount.problem })}
          help={`Leave empty to release all ${tokenAmount(held, asset.config?.decimals)} ${asset.symbol}.`}
        />
      </FieldGrid>
      <TxButton
        label={`Release ${tokenAmount(releasing, asset.config?.decimals)} ${asset.symbol} for sale`}
        tone="secondary"
        disabled={held === 0n || amount.problem !== undefined}
        blockedBy={transferGates(system)}
        context={writeContext}
        send={() =>
          writeContractAsync({
            address,
            abi: mandateAccountAbi as Abi,
            functionName: 'withdraw',
            args: [asset.address, rwa.custody as `0x${string}`, releasing],
          })
        }
        onConfirmed={() => {
          setAmountText('');
          onChange();
          refresh();
        }}
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
  if (!routerSet(rwa.router)) refusals.push('The stock router is not set. The owner sets it in the trading policy.');
  else if (!routerIsCurrent(rwa.router, rwa.lane)) refusals.push('This mandate trades through an earlier router. The owner switches it in the trading policy.');
  if (asset?.allowed === false) refusals.push(`The owner has not allowed ${symbol} for this mandate.`);
  if (config && !config.eligible) refusals.push(`${symbol} is not eligible for purchase right now.`);
  if (asset?.tradeRefusal) refusals.push(asset.tradeRefusal);
  if (config && amount.value !== undefined && amount.value > config.perTradeCap) {
    refusals.push(`${symbol} purchases are capped at ${usd(config.perTradeCap as Micro)} each.`);
  }
  if (amount.value !== undefined && amount.value > account.remaining.perCall) {
    refusals.push(`This mandate allows up to ${usd(account.remaining.perCall)} per payment right now.`);
  }
  // A purchase carries no approval, so at or above the threshold the contract refuses it. Said here,
  // the button stays off instead of the refusal arriving after the click.
  const threshold = account.limits.approvalThreshold;
  if (amount.value !== undefined && approvalModeOf(threshold, account.limits.perCallCap) !== 'never' && amount.value >= threshold) {
    refusals.push(
      `Purchases of ${usd(threshold)} or more wait for an approval, which a purchase cannot carry. Spend less, or raise the threshold in the limits.`,
    );
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
          Counts against the mandate’s limits like any payment, and a later sale credits nothing back to them.
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

/** A sale out of the custody the owner released to, by the agent or the owner, with the USDG landing in the mandate. */
function SellForm({ rwa, stocks, onChange }: { readonly rwa: RwaState; readonly stocks: readonly RwaAsset[]; readonly onChange: () => void }) {
  const { address, connected, system, writeContext, refresh } = useMandateScope();
  const { writeContractAsync } = useWriteContract();
  const [symbol, setSymbol] = useState(stocks.find((asset) => (asset.sellable ?? 0n) > 0n)?.symbol ?? stocks[0]?.symbol ?? '');
  const [amountText, setAmountText] = useState('');

  const asset = stocks.find((entry) => entry.symbol === symbol);
  const config = asset?.config;
  const released = asset?.sellable ?? 0n;
  const amount = readTokenAmount(amountText, config?.decimals, released);
  const selling = amount.value ?? released;

  const refusals: string[] = [];
  if (!routerSet(rwa.router)) refusals.push('The stock router is not set. The owner sets it in the trading policy.');
  else if (!routerIsCurrent(rwa.router, rwa.lane)) refusals.push('This mandate trades through an earlier router. The owner switches it in the trading policy.');
  if (asset?.saleAllowed === false) refusals.push(`The owner has not allowed sales of ${symbol} for this mandate.`);
  if (asset !== undefined && released === 0n) refusals.push(`The owner has not released any ${symbol} for sale.`);
  if (asset?.tradeRefusal) refusals.push(asset.tradeRefusal);
  const atFeed = asset?.priceE8 && config ? holdingValue(selling, asset.priceE8, config.decimals) : undefined;
  if (config && atFeed !== undefined && atFeed > config.perTradeCap) {
    refusals.push(`${symbol} sales are capped at ${usd(config.perTradeCap as Micro)} each, at the feed price.`);
  }

  const floor =
    selling > 0n && asset?.priceE8 && config ? minUsdgAt(selling, asset.priceE8, config.decimals, rwa.slippageBps ?? 0, config.bandBps) : undefined;

  return (
    <div className="space-y-4 border border-[color:var(--color-line)] p-4">
      <div>
        <h3 className="text-sm font-semibold">Sell a stock</h3>
        <p className="mt-0.5 text-detail text-[color:var(--color-muted)]">
          Sells what the owner released, through Uniswap at the feed price within the slippage limit. The USDG lands in the mandate.
        </p>
      </div>
      <FieldGrid columns={2}>
        <Field label="Stock">
          <select
            aria-label="Stock to sell"
            value={symbol}
            onChange={(event) => {
              setSymbol(event.target.value);
              setAmountText('');
            }}
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
        <TextField
          label="Sell"
          value={amountText}
          onChange={setAmountText}
          suffix={symbol}
          placeholder={tokenAmount(released, config?.decimals)}
          {...(amount.problem === undefined ? {} : { problem: amount.problem })}
          help={
            floor === undefined
              ? `Leave empty to sell all ${tokenAmount(released, config?.decimals)} ${symbol} released.`
              : `You receive at least ${usdFloor(floor)}, or the sale is refused.`
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

      <div className="flex flex-wrap gap-3">
        <TxButton
          label={`Sell ${symbol}`}
          disabled={asset === undefined || selling === 0n || amount.problem !== undefined || refusals.length > 0}
          blockedBy={transferGates(system)}
          context={writeContext}
          send={async () => {
            const target = asset as RwaAsset;
            const [minUsdg, exitPrice] = await Promise.all([readMinUsdg(rwa, address, target, selling), readExitPrice(rwa, address, target)]);
            const request = {
              address: rwa.lane.StockSpendRouter,
              abi: stockSpendRouterAbi as Abi,
              functionName: 'sell',
              args: [address, target.address, selling, minUsdg, exitPrice],
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
        {asset !== undefined && released > 0n && (
          <TxButton
            label={`Return the ${symbol} to the mandate`}
            tone="secondary"
            blockedBy={callGates(system)}
            context={writeContext}
            send={() =>
              writeContractAsync({
                address: rwa.lane.StockSpendRouter,
                abi: stockSpendRouterAbi as Abi,
                functionName: 'recall',
                args: [address, asset.address, released],
              })
            }
            onConfirmed={() => {
              onChange();
              refresh();
            }}
          />
        )}
      </div>
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

async function readMinUsdg(rwa: RwaState, mandate: `0x${string}`, asset: RwaAsset, raw: bigint): Promise<bigint> {
  try {
    return (await rhcClient().readContract({
      address: rwa.lane.StockSpendRouter,
      abi: stockSpendRouterAbi as Abi,
      functionName: 'minUsdgFor',
      args: [mandate, asset.address, raw],
    })) as bigint;
  } catch (error) {
    const reason = refusalInText(String(error));
    throw reason === undefined ? error : new Error(reason);
  }
}

/** The price the router holds a sale to: the exit price, which a delisted stock still has. */
async function readExitPrice(rwa: RwaState, mandate: `0x${string}`, asset: RwaAsset): Promise<bigint> {
  try {
    return (await rhcClient().readContract({
      address: rwa.lane.PriceGuard,
      abi: priceGuardAbi as Abi,
      functionName: 'exitPrice',
      args: [asset.address, mandate],
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
