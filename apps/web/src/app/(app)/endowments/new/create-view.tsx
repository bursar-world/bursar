'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { endowmentFactoryAbi, identityRegistryAbi, scanAgentUrl } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { parseEventLogs } from 'viem';
import type { Address } from 'viem';
import { readContract } from 'viem/actions';

import { settlementAssetAbi } from '@/chain/abi';
import { rhcClient } from '@/chain/client';
import { ENDOWMENTS, listedStocks } from '@/chain/endowments';
import { ADDRESSES, CHAIN_ID } from '@/chain/rhc';
import { Address as AddressView } from '@/components/address';
import { AmountInput } from '@/components/amount-input';
import { SelectField, TextField } from '@/components/fields';
import { Card, EmptyState, Field, FieldGrid, Section } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { usd } from '@/money';
import { useSystemState } from '@/state';
import { useWalletAccount } from '@/wallet/account';
import { useWriteContract } from '@/wallet/write';

const DRAW_OPTIONS = [100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600].map((b) => ({ value: String(b), label: `${b / 100}% a year` }));
/** A principal mostly in one company draws at most this: a single name falls further than an index. */
const CONCENTRATED_MAX_BPS = 350;
const KEEP_OPTIONS = [0, 25, 50, 75, 100].map((p) => ({ value: String(p * 100), label: `${p}% of what it earns` }));

type Pick = { readonly symbol: string; readonly weight: string };

export function CreateEndowment({ initialAgent }: { readonly initialAgent: string | undefined }) {
  const router = useRouter();
  const system = useSystemState();
  const { address: connected } = useWalletAccount();
  const { writeContractAsync } = useWriteContract();
  const stocks = listedStocks();

  const [agentText, setAgentText] = useState(initialAgent ?? '');
  const [picks, setPicks] = useState<readonly Pick[]>([{ symbol: 'SPY', weight: '100' }]);
  const [drawBps, setDrawBps] = useState('450');
  const [keepBps, setKeepBps] = useState('5000');
  const [successorText, setSuccessorText] = useState('');
  const [giftText, setGiftText] = useState('');
  const [gift, setGift] = useState<bigint | undefined>(undefined);

  const agentId = /^\d+$/.test(agentText.trim()) ? BigInt(agentText.trim()) : undefined;
  const successorId = successorText.trim() === '' ? 0n : /^\d+$/.test(successorText.trim()) ? BigInt(successorText.trim()) : undefined;

  const agent = useQuery({
    queryKey: ['bursar', 'endow-agent', agentId?.toString()],
    enabled: agentId !== undefined && ENDOWMENTS !== undefined,
    retry: false,
    queryFn: async () =>
      (await readContract(rhcClient(), {
        address: ENDOWMENTS!.IdentityRegistry,
        abi: identityRegistryAbi,
        functionName: 'ownerOf',
        args: [agentId!],
      })) as Address,
  });
  const wallet = useQuery({
    queryKey: ['bursar', 'endow-wallet', connected],
    enabled: connected !== undefined && ENDOWMENTS !== undefined,
    refetchInterval: 20_000,
    queryFn: async () => {
      const client = rhcClient();
      const [balance, allowance] = await Promise.all([
        readContract(client, { address: ADDRESSES.usdg, abi: settlementAssetAbi, functionName: 'balanceOf', args: [connected!] }),
        readContract(client, {
          address: ADDRESSES.usdg,
          abi: settlementAssetAbi,
          functionName: 'allowance',
          args: [connected!, ENDOWMENTS!.EndowmentFactory],
        }),
      ]);
      return { balance: balance as bigint, allowance: allowance as bigint };
    },
  });

  if (ENDOWMENTS === undefined) {
    return <EmptyState title="Endowments are not on this network">They run on Robinhood Chain.</EmptyState>;
  }
  const factory = ENDOWMENTS.EndowmentFactory;

  const weights = picks.map((p) => Math.round(Number(p.weight) * 100));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const symbols = picks.map((p) => p.symbol);
  const duplicate = new Set(symbols).size !== symbols.length;
  const holdingsProblem = duplicate
    ? 'Each stock can appear once.'
    : weights.some((w) => !Number.isFinite(w) || w <= 0)
      ? 'Give every stock a share above zero.'
      : weightSum !== 10_000
        ? `The shares add up to ${weightSum / 100}%. They need to add up to 100%.`
        : undefined;
  const concentrated = picks.some((p, i) => p.symbol !== 'SPY' && (weights[i] ?? 0) > 5_000);
  const drawProblem =
    concentrated && Number(drawBps) > CONCENTRATED_MAX_BPS
      ? 'More than half of this principal is one company, so it draws at most 3.5% a year.'
      : undefined;
  const balance = wallet.data?.balance;
  const giftProblem = gift !== undefined && balance !== undefined && gift > balance ? `Your wallet holds ${usd(balance as Micro)}.` : undefined;
  const agentProblem = agentText.trim() === '' ? undefined : agentId === undefined ? 'Enter the agent’s number.' : agent.isError ? 'No agent has this number.' : undefined;
  const ready =
    agentId !== undefined &&
    agent.data !== undefined &&
    holdingsProblem === undefined &&
    drawProblem === undefined &&
    successorId !== undefined &&
    giftProblem === undefined;
  const giftAmount = gift ?? 0n;
  const needsAllowance = ready && giftAmount > 0n && (wallet.data?.allowance ?? 0n) < giftAmount;
  const blockedBy = [system.connectivity, system.asset];

  const terms = () => ({
    agentId: agentId as bigint,
    successorId: successorId as bigint,
    assets: picks.map((p) => stocks.find((s) => s.symbol === p.symbol)!.address),
    weightsBps: weights,
    drawBps: Number(drawBps),
    earnShareBps: Number(keepBps),
  });

  return (
    <div className="space-y-10">
      <Section
        title="Endow an agent"
        description="Choose an agent, what its principal holds and how much it draws. The principal stays invested; the agent spends only the draw."
      >
        <Card title="The agent">
          <FieldGrid columns={2}>
            <TextField
              label="Agent number"
              value={agentText}
              onChange={setAgentText}
              placeholder="8756"
              help="Its ERC-8004 identity on Robinhood Chain. Its owner accepts the endowment before anything is drawn."
              {...(agentProblem === undefined ? {} : { problem: agentProblem })}
            />
            <Field label="Owned by">
              {agent.data ? (
                <span className="space-y-1">
                  <AddressView value={agent.data} />
                  <a href={scanAgentUrl(CHAIN_ID, agentId!)} target="_blank" rel="noreferrer" className="block text-detail underline underline-offset-2">
                    See the agent on 8004scan
                  </a>
                </span>
              ) : (
                <span className="text-[color:var(--color-muted)]">{agentId === undefined ? 'Enter a number' : agent.isLoading ? 'Reading' : 'Not found'}</span>
              )}
            </Field>
          </FieldGrid>
        </Card>
      </Section>

      <Section title="What the principal holds" description="Up to four listed stocks. Every purchase is held to the Chainlink feed price.">
        <Card>
          <div className="space-y-3">
            {picks.map((pick, i) => (
              <FieldGrid key={i} columns={3}>
                <SelectField
                  label="Stock"
                  value={pick.symbol}
                  options={stocks.map((s) => ({ value: s.symbol, label: s.symbol }))}
                  onChange={(symbol) => setPicks(picks.map((p, j) => (j === i ? { ...p, symbol } : p)))}
                />
                <TextField
                  label="Share"
                  value={pick.weight}
                  suffix="%"
                  onChange={(weight) => setPicks(picks.map((p, j) => (j === i ? { ...p, weight } : p)))}
                />
                {picks.length > 1 && (
                  <Field label=" ">
                    <button type="button" className="cursor-pointer text-sm underline underline-offset-2" onClick={() => setPicks(picks.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </Field>
                )}
              </FieldGrid>
            ))}
            {picks.length < 4 && (
              <button
                type="button"
                className="cursor-pointer text-sm underline underline-offset-2"
                onClick={() => setPicks([...picks, { symbol: stocks.find((s) => !symbols.includes(s.symbol))?.symbol ?? 'NVDA', weight: '0' }])}
              >
                Add a stock
              </button>
            )}
            {holdingsProblem && <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>{holdingsProblem}</p>}
          </div>
        </Card>
      </Section>

      <Section title="The draw">
        <Card>
          <FieldGrid columns={3}>
            <SelectField
              label="Draw rate"
              value={drawBps}
              options={DRAW_OPTIONS}
              onChange={setDrawBps}
              {...(drawProblem === undefined ? {} : { problem: drawProblem })}
              help="Of the average of the last twelve quarterly valuations, kept between 3% and 6% of the principal and moved at most 5% a quarter. Year one draws at most 4%."
            />
            <SelectField
              label="Earnings kept"
              value={keepBps}
              options={KEEP_OPTIONS}
              onChange={setKeepBps}
              help="When the agent earns, this share joins the principal and the rest goes to its mandate."
            />
            <TextField
              label="Successor (optional)"
              value={successorText}
              onChange={setSuccessorText}
              placeholder="Agent number"
              help="Receives the endowment if the agent stops drawing for 180 days."
              {...(successorId === undefined ? { problem: 'Enter an agent number or leave it empty.' } : {})}
            />
          </FieldGrid>
        </Card>
      </Section>

      <Section title="Your first gift" description="Optional. It makes you the first patron and is invested straight away.">
        <Card>
          <div className="max-w-md space-y-3">
            <AmountInput
              label="Amount"
              asset="USDG"
              value={giftText}
              onChange={(text, atomic) => {
                setGiftText(text);
                setGift(atomic);
              }}
              {...(balance === undefined ? {} : { hint: `Your wallet holds ${usd(balance as Micro)}.` })}
              {...(giftProblem === undefined ? {} : { problem: giftProblem })}
            />
            {connected === undefined ? (
              <p className="text-sm">Connect a wallet on Robinhood Chain to create the endowment.</p>
            ) : needsAllowance ? (
              <TxButton
                label="Allow the gift"
                tone="secondary"
                blockedBy={blockedBy}
                send={() =>
                  writeContractAsync({
                    address: ADDRESSES.usdg,
                    abi: settlementAssetAbi,
                    functionName: 'approve',
                    args: [factory, giftAmount as Micro],
                  })
                }
                onConfirmed={() => void wallet.refetch()}
              />
            ) : (
              <TxButton
                label="Create the endowment"
                disabled={!ready}
                blockedBy={blockedBy}
                send={() =>
                  writeContractAsync({
                    address: factory,
                    abi: endowmentFactoryAbi,
                    functionName: 'create',
                    args: [terms(), giftAmount],
                  })
                }
                onConfirmed={(receipt) => {
                  const created = parseEventLogs({ abi: endowmentFactoryAbi, logs: receipt.logs, eventName: 'Created' })[0];
                  const address = (created as { args?: { endowment?: Address } } | undefined)?.args?.endowment;
                  router.push(address ? `/endowments/${address}` : '/endowments');
                }}
              />
            )}
            <p className="text-detail text-[color:var(--color-muted)]">
              The principal is held in stocks and can lose value. The terms cannot be changed after creation, except the successor.
            </p>
          </div>
        </Card>
      </Section>
    </div>
  );
}
