'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { endowmentAbi, scanAgentUrl } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { getAddress, isAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { getContractEvents, readContract } from 'viem/actions';

import { settlementAssetAbi } from '@/chain/abi';
import { rhcClient } from '@/chain/client';
import { ENDOWMENTS, accruedAfter, agentName, readEndowment, sources } from '@/chain/endowments';
import type { EndowmentView } from '@/chain/endowments';
import { ADDRESSES, CHAIN_ID, explorerTx, sameAddress } from '@/chain/rhc';
import { Address as AddressView } from '@/components/address';
import { AmountInput } from '@/components/amount-input';
import { Badge, LevelBadge } from '@/components/badge';
import { Button } from '@/components/button';
import { TextField } from '@/components/fields';
import { Instant } from '@/components/instant';
import { Card, EmptyState, Field, FieldGrid, Section, Skeleton } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { Table } from '@/components/table';
import { TxButton } from '@/components/tx-button';
import { bps, usd, usdExact } from '@/money';
import { useSystemState } from '@/state';
import { useWalletAccount } from '@/wallet/account';
import { useWriteContract } from '@/wallet/write';

const REFETCH_MS = 20_000;

type Activity = {
  readonly key: string;
  readonly kind: string;
  readonly detail: string;
  readonly block: bigint;
  readonly hash: Hex;
};

type Patron = { readonly address: Address; readonly given: bigint; readonly first: bigint };

export function EndowmentPage({ address }: { readonly address: Address }) {
  const endowment = useQuery({
    queryKey: ['bursar', 'endowment', address],
    queryFn: () => readEndowment(address),
    refetchInterval: REFETCH_MS,
  });
  const view = endowment.data;
  const name = useQuery({
    queryKey: ['bursar', 'endowment-agent', view?.state.agentId.toString(), view?.agentUri],
    queryFn: () => agentName(view!.state.agentId, view!.agentUri),
    enabled: view !== undefined,
    staleTime: 10 * 60_000,
  });
  const history = useQuery({
    queryKey: ['bursar', 'endowment-history', address],
    queryFn: () => readHistory(address),
    refetchInterval: REFETCH_MS * 3,
  });

  if (endowment.isError) {
    return (
      <EmptyState title="This endowment could not be read">
        The address may not be an endowment, or the network did not answer. <Link href="/endowments" className="underline underline-offset-2">See every endowment</Link>.
      </EmptyState>
    );
  }
  if (!view) {
    return (
      <div className="space-y-4">
        <Skeleton height={40} width="60%" />
        <Skeleton height={120} />
      </div>
    );
  }

  const title = name.data ?? `Agent #${view.state.agentId.toString()}`;
  const refresh = () => {
    void endowment.refetch();
    void history.refetch();
  };

  return (
    <div className="space-y-10">
      <Section
        title={`The endowment of ${title}`}
        description={statusLine(view)}
        actions={
          <Button size="sm" onClick={refresh} disabled={endowment.isFetching}>
            {endowment.isFetching ? 'Reading' : 'Read again'}
          </Button>
        }
      >
        <Card>
          <StatGrid columns={4}>
            <Stat
              label="Principal"
              value={usd(view.state.nav as Micro)}
              hint={view.state.navFresh ? 'Held in stocks and cash, at the feed price.' : 'A price behind this figure is older than its limit.'}
              level={view.state.navFresh ? 'ok' : 'attention'}
            />
            <Stat
              label="Draw a year"
              value={usd(view.state.drawPerYear as Micro)}
              hint={view.state.underwater ? 'Stopped while the principal is under 80% of what was put in.' : `Set each quarter at ${bps(view.drawBps)} of the average valuation, within 3% to 6% of the principal.`}
            />
            <DrawTicker view={view} />
            <Stat
              label="Patrons"
              value={view.state.patrons.toString()}
              hint={view.state.patrons === 0n ? 'Nobody has given a dollar yet.' : 'Each holds a patron mark.'}
            />
          </StatGrid>
        </Card>
      </Section>

      <Section title="Holdings" description="The principal stays invested. The agent spends only the draw.">
        <Card>
          <Table
            caption="Holdings"
            rows={[...view.holdings, undefined]}
            rowKey={(row) => row?.asset ?? 'cash'}
            columns={[
              { key: 'asset', header: 'Holding', cell: (row) => <span className="font-medium">{row?.symbol ?? 'USDG cash'}</span> },
              {
                key: 'amount',
                header: 'Amount',
                align: 'right',
                cell: (row) => <span className="tabular">{row ? `${shares(row.raw, row.decimals)} ${row.symbol}` : usdExact(view.state.cash as Micro)}</span>,
              },
              {
                key: 'value',
                header: 'Value',
                align: 'right',
                cell: (row) => <span className="tabular">{row ? (row.value === undefined ? 'Unpriced' : usd(row.value)) : usd(view.state.cash as Micro)}</span>,
              },
              {
                key: 'weight',
                header: 'Target',
                align: 'right',
                secondary: true,
                cell: (row) => (row ? bps(row.weightBps) : `${usd(view.state.sleeveTarget as Micro)} kept for draws`),
              },
            ]}
          />
        </Card>
      </Section>

      <Section title="Where the principal came from">
        <Card>
          <Sources view={view} />
        </Card>
      </Section>

      <GiveSection view={view} title={title} onChange={refresh} />
      <OwnerSection view={view} onChange={refresh} />

      <Section title="Patrons" description="Everyone who has given at least a dollar holds a patron mark. The first hundred are founding patrons.">
        <Card>
          <Table
            caption="Patrons"
            rows={history.data?.patrons ?? []}
            rowKey={(row) => row.address}
            empty={history.isLoading ? 'Reading the patrons.' : 'No patrons yet.'}
            columns={[
              { key: 'patron', header: 'Patron', cell: (row) => <AddressView value={row.address} /> },
              { key: 'given', header: 'Given', align: 'right', cell: (row) => <span className="tabular">{usd(row.given as Micro)}</span> },
              {
                key: 'founding',
                header: '',
                cell: (row, index) => (row.given >= 1_000_000n && index < 100 ? <Badge>Founding</Badge> : null),
              },
            ]}
          />
        </Card>
      </Section>

      <Section title="Activity" description="Gifts, draws, earnings and every trade the principal made.">
        <Card>
          <Table
            caption="Activity"
            rows={history.data?.activity ?? []}
            rowKey={(row) => row.key}
            empty={history.isLoading ? 'Reading the activity.' : 'Nothing has happened yet.'}
            columns={[
              { key: 'kind', header: 'What', cell: (row) => <span className="font-medium">{row.kind}</span> },
              { key: 'detail', header: 'Detail', cell: (row) => row.detail },
              {
                key: 'tx',
                header: 'Transaction',
                secondary: true,
                cell: (row) => (
                  <a href={explorerTx(row.hash)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    View
                  </a>
                ),
              },
            ]}
          />
        </Card>
      </Section>

      <Section title="Terms" description="Fixed when the endowment was created.">
        <Card>
          <FieldGrid columns={3}>
            <Field label="Agent" hint="Its ERC-8004 identity on Robinhood Chain.">
              <a href={scanAgentUrl(CHAIN_ID, view.state.agentId)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                #{view.state.agentId.toString()}
              </a>
            </Field>
            <Field label="Owner of the agent" hint="Accepts the endowment and draws from it.">
              {view.owner ? <AddressView value={view.owner} /> : 'Not read'}
            </Field>
            <Field label="Paid into" hint="The mandate whose limits govern what the agent spends.">
              {view.state.accepted ? <Link href={`/console/${view.state.mandate}`} className="underline underline-offset-2">Mandate {view.state.mandate.slice(0, 10)}</Link> : 'Not accepted yet'}
            </Field>
            <Field label="Draw rate" hint="A year, on the average of up to twelve quarterly valuations.">
              {bps(view.drawBps)}
            </Field>
            <Field label="Earnings kept" hint="The share of what the agent earns that joins the principal.">
              {bps(view.earnShareBps)}
            </Field>
            <Field label="Successor" hint="Receives the endowment if the agent stops drawing for 180 days.">
              {view.state.successorId === 0n ? 'None named' : `Agent #${view.state.successorId.toString()}`}
            </Field>
            <Field label="Started by">
              <AddressView value={view.settlor} />
            </Field>
            <Field label="Started">
              <Instant at={new Date(Number(view.state.createdAt) * 1000)} relative />
            </Field>
            <Field label="Protocol fee" hint="Of each draw, to the Bursar treasury.">
              {bps(view.feeBps)}
            </Field>
          </FieldGrid>
        </Card>
      </Section>
    </div>
  );
}

function statusLine(view: EndowmentView): string {
  const s = view.state;
  if (s.frozen) return 'The draw is paused. Holdings and gifts are untouched.';
  if (s.accepted) return `The agent draws ${bps(view.drawBps)} a year of the principal's average value. The principal stays invested.`;
  if (s.everAccepted) return 'Resting: the agent stopped drawing. Its owner can accept again, or the settlor can name a successor.';
  const opensAt = Number(s.createdAt) + 180 * 24 * 3600;
  if (Date.now() / 1000 >= opensAt) return 'Never accepted, so each patron can take back their share.';
  return 'Waiting for the agent’s owner to accept. Until then nothing is drawn, and gifts stay invested.';
}

/** The draw owed right now, counted up a second at a time from the last read. */
function DrawTicker({ view }: { readonly view: EndowmentView }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const live = view.state.accepted && !view.state.frozen;
  const owed = accruedAfter(view, (now - view.readAt) / 1000);
  return (
    <Stat
      label="Owed to the agent now"
      value={live ? usdExact(owed as Micro) : usd(0n as Micro)}
      hint={live ? 'Accrues every second. The agent pulls it into its mandate.' : 'Starts once the owner accepts.'}
      level={live ? 'ok' : 'unknown'}
    />
  );
}

function Sources({ view }: { readonly view: EndowmentView }) {
  const s = sources(view);
  const rows = [
    { label: 'Added by patrons', value: s.patrons },
    { label: 'Earned back by the agent', value: s.earnedBack },
    { label: 'Drawn by the agent', value: -s.paidOut },
    { label: 'Market change', value: s.market },
  ];
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-4 border-b border-[color:var(--color-line)] pb-2 text-sm">
          <span>{row.label}</span>
          <span className="tabular">{signed(row.value)}</span>
        </div>
      ))}
      <p className="pt-2 text-detail text-[color:var(--color-muted)]">
        The principal moves with the market and can lose value. The draw follows a three-year average and moves at most 5% a quarter, so a fall shows in it slowly. It stops while the principal is under 80% of what was put in.
      </p>
    </div>
  );
}

function GiveSection({ view, title, onChange }: { readonly view: EndowmentView; readonly title: string; readonly onChange: () => void }) {
  const { address: connected } = useWalletAccount();
  const system = useSystemState();
  const { writeContractAsync } = useWriteContract();
  const [text, setText] = useState('');
  const [amount, setAmount] = useState<bigint | undefined>(undefined);
  const [given, setGiven] = useState<Hex | undefined>(undefined);
  const blockedBy = [system.connectivity, system.asset];

  const wallet = useQuery({
    queryKey: ['bursar', 'endowment-wallet', view.address, connected],
    enabled: connected !== undefined,
    refetchInterval: REFETCH_MS,
    queryFn: async () => {
      const client = rhcClient();
      const [balance, allowance] = await Promise.all([
        readContract(client, { address: ADDRESSES.usdg, abi: settlementAssetAbi, functionName: 'balanceOf', args: [connected!] }),
        readContract(client, { address: ADDRESSES.usdg, abi: settlementAssetAbi, functionName: 'allowance', args: [connected!, view.address] }),
      ]);
      return { balance: balance as bigint, allowance: allowance as bigint };
    },
  });

  const balance = wallet.data?.balance;
  const problem =
    amount === undefined || text.trim() === ''
      ? undefined
      : amount <= 0n
        ? 'Enter an amount above zero.'
        : balance !== undefined && amount > balance
          ? `Your wallet holds ${usd(balance as Micro)}.`
          : undefined;
  const ready = amount !== undefined && amount > 0n && problem === undefined;
  const needsAllowance = ready && (wallet.data?.allowance ?? 0n) < amount;
  const share = shareUrl(title, view.address);

  return (
    <Section title="Add to this endowment" description="Your gift joins the principal and stays invested. A dollar or more earns a patron mark.">
      <Card>
        {given ? (
          <div className="space-y-3">
            <p className="text-sm">
              You are a patron of {title}.{' '}
              <a href={explorerTx(given)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                View the transaction
              </a>
              .
            </p>
            <div className="flex flex-wrap gap-3">
              <a href={share} target="_blank" rel="noreferrer">
                <Button tone="primary">Post it on X</Button>
              </a>
              <Button onClick={() => setGiven(undefined)}>Give again</Button>
            </div>
          </div>
        ) : connected === undefined ? (
          <p className="text-sm">Connect a wallet holding USDG on Robinhood Chain to give.</p>
        ) : (
          <div className="max-w-md space-y-3">
            <AmountInput
              label="Amount"
              asset="USDG"
              value={text}
              onChange={(next, atomic) => {
                setText(next);
                setAmount(atomic);
              }}
              {...(balance === undefined ? {} : { max: { atomic: balance, label: 'All of it' }, hint: `Your wallet holds ${usd(balance as Micro)}.` })}
              {...(problem === undefined ? {} : { problem })}
            />
            {needsAllowance ? (
              <TxButton
                label="Allow the endowment to take it"
                tone="secondary"
                blockedBy={blockedBy}
                send={() =>
                  writeContractAsync({ address: ADDRESSES.usdg, abi: settlementAssetAbi, functionName: 'approve', args: [view.address, amount as Micro] })
                }
                onConfirmed={() => void wallet.refetch()}
              />
            ) : (
              <TxButton
                label="Give"
                disabled={!ready}
                blockedBy={blockedBy}
                send={() => writeContractAsync({ address: view.address, abi: endowmentAbi, functionName: 'give', args: [amount as bigint] })}
                onConfirmed={(receipt) => {
                  setGiven(receipt.transactionHash);
                  setText('');
                  setAmount(undefined);
                  onChange();
                }}
              />
            )}
            <p className="text-detail text-[color:var(--color-muted)]">
              Gifts cannot be taken back once the agent&rsquo;s owner accepts. If the owner never accepts within 180 days, each patron can take
              back their share.
            </p>
          </div>
        )}
      </Card>
    </Section>
  );
}

function OwnerSection({ view, onChange }: { readonly view: EndowmentView; readonly onChange: () => void }) {
  const { address: connected } = useWalletAccount();
  const system = useSystemState();
  const { writeContractAsync } = useWriteContract();
  const [mandateText, setMandateText] = useState('');
  if (!sameAddress(connected, view.owner)) return null;

  const blockedBy = [system.connectivity, system.asset];
  const mandate = isAddress(mandateText.trim()) ? getAddress(mandateText.trim()) : undefined;
  const mandateProblem = mandateText.trim() !== '' && mandate === undefined ? 'Enter a mandate address.' : undefined;
  const accepted = view.state.accepted;

  return (
    <Section
      title="You own this agent"
      description={accepted ? 'Pull the draw into the mandate, or point the endowment at another mandate.' : 'Accept the endowment to start the draw.'}
    >
      <Card>
        <div className="grid gap-6 lg:grid-cols-2">
          {accepted && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Draw now</h3>
              <p className="text-detail text-[color:var(--color-muted)]">
                Moves what is owed into the mandate, less the {bps(view.feeBps)} protocol fee. Your agent can do the same through the Bursar MCP
                server.
              </p>
              <TxButton
                label="Draw"
                blockedBy={blockedBy}
                send={() => writeContractAsync({ address: view.address, abi: endowmentAbi, functionName: 'draw' })}
                onConfirmed={onChange}
              />
            </div>
          )}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{accepted ? 'Change the mandate' : 'Accept'}</h3>
            <TextField
              label="Mandate"
              mono
              value={mandateText}
              onChange={setMandateText}
              placeholder="0x…"
              help="A Bursar mandate that settles in USDG. Its limits decide what the agent may spend."
              {...(mandateProblem === undefined ? {} : { problem: mandateProblem })}
            />
            <TxButton
              label={accepted ? 'Pay into this mandate' : 'Accept and start the draw'}
              disabled={mandate === undefined}
              blockedBy={blockedBy}
              send={() =>
                writeContractAsync({
                  address: view.address,
                  abi: endowmentAbi,
                  functionName: accepted ? 'setMandate' : 'accept',
                  args: [mandate as Address],
                })
              }
              onConfirmed={() => {
                setMandateText('');
                onChange();
              }}
            />
          </div>
        </div>
        {view.state.frozen && (
          <p className="mt-4 text-detail">
            <LevelBadge level="attention">Paused</LevelBadge> The draw is paused by the Bursar guardian. Nothing has moved.
          </p>
        )}
      </Card>
    </Section>
  );
}

async function readHistory(address: Address): Promise<{ readonly activity: readonly Activity[]; readonly patrons: readonly Patron[] }> {
  const events = await getContractEvents(rhcClient(), {
    address,
    abi: endowmentAbi,
    fromBlock: BigInt(ENDOWMENTS?.fromBlock ?? 0),
  });
  const activity: Activity[] = [];
  const patrons = new Map<string, Patron>();
  for (const event of events) {
    const args = (event as unknown as { args: Record<string, unknown> }).args;
    const name = (event as unknown as { eventName: string }).eventName;
    const block = event.blockNumber ?? 0n;
    const hash = event.transactionHash as Hex;
    const key = `${hash}:${event.logIndex}`;
    const amount = (k: string) => usdExact((args[k] as bigint) as Micro);
    switch (name) {
      case 'Given': {
        const patron = args['patron'] as Address;
        const value = args['value'] as bigint;
        const prior = patrons.get(patron.toLowerCase());
        patrons.set(patron.toLowerCase(), { address: patron, given: (prior?.given ?? 0n) + value, first: prior?.first ?? block });
        activity.push({ key, kind: 'Gift', detail: `${amount('value')} from ${patron.slice(0, 8)}`, block, hash });
        break;
      }
      case 'Unattributed':
        activity.push({ key, kind: 'Gift', detail: `${amount('amount')} from a private sender`, block, hash });
        break;
      case 'Earned':
        activity.push({ key, kind: 'Earned', detail: `${amount('amount')}, ${amount('toPrincipal')} kept in the principal`, block, hash });
        break;
      case 'Drawn':
        activity.push({ key, kind: 'Draw', detail: `${amount('amount')} into the mandate`, block, hash });
        break;
      case 'Invested':
        activity.push({ key, kind: 'Bought', detail: `${amount('usdgIn')} of stock`, block, hash });
        break;
      case 'Refilled':
        activity.push({ key, kind: 'Sold', detail: `${amount('usdgOut')} back to cash for draws`, block, hash });
        break;
      case 'Accepted':
        activity.push({ key, kind: 'Accepted', detail: 'The agent’s owner accepted the endowment', block, hash });
        break;
      case 'Snapshot':
        activity.push({ key, kind: 'Valued', detail: `Quarterly valuation ${amount('nav')}`, block, hash });
        break;
      case 'Lapsed':
        activity.push({ key, kind: 'Passed on', detail: 'The agent stopped drawing', block, hash });
        break;
      default:
        break;
    }
  }
  activity.sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1));
  const ranked = [...patrons.values()].sort((a, b) => (a.first === b.first ? 0 : a.first < b.first ? -1 : 1));
  return { activity: activity.slice(0, 50), patrons: ranked };
}

function shares(raw: bigint, decimals: number): string {
  const scale = 10 ** Math.min(decimals, 18);
  const whole = Number(raw) / scale;
  return whole === 0 ? '0' : whole < 0.0001 ? whole.toExponential(2) : whole.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function signed(value: bigint): string {
  // Under half a cent either way reads as nothing, not as a signed zero.
  if (value > -5_000n && value < 5_000n) return usd(0n as Micro);
  return value < 0n ? `−${usd(-value as Micro)}` : `+${usd(value as Micro)}`;
}

function shareUrl(title: string, endowment: Address): string {
  const url = `https://app.bursar.world/endowments/${endowment}`;
  const text = `I'm a patron of ${title} on Bursar. Its principal stays invested in US stocks on Robinhood Chain, and the agent spends a yearly draw from it.`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}
