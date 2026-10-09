'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { ShieldedDeployment } from '@bursar/core';
import { relayFeeBpsFor } from '@bursar/sdk';
import type { AssociationSet, OwnedNote, ShieldedKeys } from '@bursar/sdk';
import type { Address, Hex } from 'viem';
import { useSignTypedData } from 'wagmi';

import { rhcClient } from '@/chain/client';
import { sameAddress } from '@/chain/rhc';
import {
  PURPOSES,
  depositPrecommitment,
  depositProblem,
  depositRoomLine,
  feeLine,
  fundsKeyContext,
  gasDropProblem,
  intentFromQuery,
  labelInSet,
  ownNotes,
  poolLimits,
  ragequitProof,
  readAssociationSet,
  readPool,
  readRoom,
  relayFee,
  setMatchesChain,
  shieldedContracts,
  shieldedKeysFrom,
  shieldedServices,
  usdgText,
  withdrawProblem,
  withdrawThroughRelayer,
} from '@/chain/shielded';
import type { PoolReading, WithdrawPurpose } from '@/chain/shielded';
import { Address as AddressView, TxHash } from '@/components/address';
import { AddressInput, readAddress } from '@/components/address-input';
import { AmountInput } from '@/components/amount-input';
import { Badge } from '@/components/badge';
import { Button } from '@/components/button';
import { Card, EmptyState, Field, FieldGrid, Section } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { TxButton } from '@/components/tx-button';
import { SHIELDED_TIMING_LINE } from '@/chain/stealth';
import { useWalletAccount } from '@/wallet/account';
import { ConnectButton } from '@/wallet/connect-button';
import { useWriteContract } from '@/wallet/write';

const erc20 = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;


type Unlocked = { readonly keys: ShieldedKeys };

/**
 * The shielded USDG pool.
 *
 * One signature derives the keys behind every deposit this wallet made: the funds key, a typed-data
 * request bound to the wallet and this chain that says in the wallet it controls funds. The viewing
 * key never reaches a deposit. The page finds the deposits in the pool's public events, shows what each
 * still holds, and proves withdrawals in the browser. The relayer submits them, so the connected
 * wallet never appears on a payout.
 */
export function ShieldedView() {
  const contracts = shieldedContracts();
  const { address: wallet, isConnected } = useWalletAccount();

  const header = (
    <div className="space-y-2">
      <Link href="/console" className="font-mono text-label uppercase tracking-wide text-[color:var(--color-muted)] transition-colors hover:text-[color:var(--color-ink)]">
        All mandates
      </Link>
      <h1 className="page-title">Shielded funds</h1>
      <p className="max-w-3xl text-detail text-[color:var(--color-muted)]">
        Deposit USDG into a shared pool, then fund mandates, hidden owners and providers from it. Payouts come from the pool,
        so they do not name the wallet that deposited.
      </p>
      <p className="max-w-3xl text-detail" style={{ color: 'var(--color-state-attention)' }}>
        {SHIELDED_TIMING_LINE}
      </p>
    </div>
  );

  if (contracts === undefined) {
    return (
      <div className="space-y-8">
        {header}
        <EmptyState title="The shielded pool is not available on this network yet." />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {header}
      {!isConnected || wallet === undefined ? (
        <>
          <PoolPanel contracts={contracts} />
          <EmptyState title="Connect the wallet you deposit from." action={<ConnectButton />}>
            Your wallet’s signature finds your deposits.
          </EmptyState>
        </>
      ) : (
        <Connected contracts={contracts} wallet={wallet} />
      )}
    </div>
  );
}

function usePool(contracts: ShieldedDeployment) {
  return useQuery({ queryKey: ['shielded', 'pool', contracts.ShieldedPool], queryFn: () => readPool(contracts), refetchInterval: 30_000 });
}

function useSet(contracts: ShieldedDeployment, reading: PoolReading | undefined) {
  const { asp } = shieldedServices();
  return useQuery({
    queryKey: ['shielded', 'set', contracts.ShieldedPool, reading?.events.toBlock.toString(), asp ?? 'local'],
    queryFn: () => readAssociationSet(contracts, reading as PoolReading, asp),
    enabled: reading !== undefined,
    placeholderData: keepPreviousData,
  });
}

function PoolPanel({ contracts }: { readonly contracts: ShieldedDeployment }) {
  const pool = usePool(contracts);
  const set = useSet(contracts, pool.data);
  const limits = poolLimits(contracts);
  const ready = setMatchesChain(set.data, pool.data?.latestRoot);
  // The set poster answers no_root until it has posted a list, which is an answer, not a failure.
  const unposted = (set.error as { code?: unknown } | null)?.code === 'no_root';

  return (
    <Section title="The pool" description="USDG only. These limits apply while the pool is new.">
      <Card>
        <StatGrid columns={3}>
          <Stat
            label="Held in the pool"
            value={pool.data ? `${usdgText(pool.data.poolBalance)} USDG` : 'Loading'}
            hint={`The pool holds at most ${usdgText(limits.maxTotal)} USDG.`}
            level={pool.data ? 'ok' : 'unknown'}
          />
          <Stat
            label="One deposit"
            value={`${usdgText(limits.minimumDeposit)} to ${usdgText(limits.maxDeposit)} USDG`}
            hint="Larger amounts go in as several deposits."
            numeric={false}
          />
          <Stat
            label="Approved deposits"
            value={set.data ? `${set.data.labels.length} of ${pool.data?.events.deposits.length ?? 0}` : unposted ? 'None yet' : set.isError ? 'Not read' : 'Loading'}
            hint={
              set.data === undefined
                ? unposted
                  ? 'No approved list has been posted yet. The first one follows the first deposit within a few minutes.'
                  : set.isError
                    ? 'The approved list could not be read. Read the page again.'
                    : 'Loading approved deposits.'
                : ready
                  ? 'Every deposit from a wallet the Robinhood access registry does not block. A withdrawal proves its deposit is on this list.'
                  : 'The newest deposits are waiting for approval. They can be withdrawn once the next approved list is posted.'
            }
            level={set.data === undefined ? (unposted ? 'attention' : 'unknown') : ready ? 'ok' : 'attention'}
          />
        </StatGrid>
      </Card>
    </Section>
  );
}

function Connected({ contracts, wallet }: { readonly contracts: ShieldedDeployment; readonly wallet: Address }) {
  const { signTypedDataAsync } = useSignTypedData();
  const [unlocked, setUnlocked] = useState<Unlocked | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const pool = usePool(contracts);
  const set = useSet(contracts, pool.data);
  const notes = useQuery({
    queryKey: ['shielded', 'notes', wallet, pool.data?.events.toBlock.toString()],
    queryFn: () => ownNotes((unlocked as Unlocked).keys, contracts, (pool.data as PoolReading).events),
    enabled: unlocked !== undefined && pool.data !== undefined,
    // The pool is read again every thirty seconds and the notes with it. Without the last answer held
    // while the next one loads, the forms below unmount on every read and lose what was typed.
    placeholderData: keepPreviousData,
  });

  const unlock = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const { fundsKeyTypedData } = await import('@bursar/sdk');
      const context = fundsKeyContext(wallet);
      setUnlocked({ keys: await shieldedKeysFrom(await signTypedDataAsync(fundsKeyTypedData(context)), context) });
    } catch (error) {
      setProblem(
        error instanceof Error && error.name === 'FundsKeySignatureError'
          ? 'That signature did not come from this wallet, so your deposits stay locked. Smart contract wallets cannot unlock deposits here.'
          : 'The signature was declined, so your deposits stay locked.',
      );
    } finally {
      setBusy(false);
    }
  };

  const refresh = () => void pool.refetch();

  return (
    <>
      <PoolPanel contracts={contracts} />
      <Section
        title="Your deposits"
        description="Your wallet signs a request it shows as controlling funds, and this page uses it to unlock your deposits. Signing is free. Sign it only here, because anyone with that signature can spend your deposits."
      >
        <Card>
          <div className="space-y-4">
            {!unlocked ? (
              <Button tone="primary" onClick={() => void unlock()} disabled={busy}>
                {busy ? 'Waiting for the signature' : 'Unlock your deposits'}
              </Button>
            ) : notes.data === undefined ? (
              <p className="text-detail text-[color:var(--color-muted)]">Loading the pool.</p>
            ) : (
              <DepositForm contracts={contracts} wallet={wallet} keys={unlocked.keys} nextIndex={notes.data.nextDepositIndex} poolBalance={pool.data?.poolBalance} onDone={refresh} />
            )}
            {problem && <Problem text={problem} />}
          </div>
        </Card>
      </Section>
      {unlocked && notes.data && pool.data && (
        <NoteList
          contracts={contracts}
          wallet={wallet}
          keys={unlocked.keys}
          notes={notes.data.notes}
          reading={pool.data}
          set={set.data}
          onDone={refresh}
        />
      )}
    </>
  );
}

function DepositForm({
  contracts,
  wallet,
  keys,
  nextIndex,
  poolBalance,
  onDone,
}: {
  readonly contracts: ShieldedDeployment;
  readonly wallet: Address;
  readonly keys: ShieldedKeys;
  readonly nextIndex: bigint;
  readonly poolBalance: bigint | undefined;
  readonly onDone: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const [text, setText] = useState('');
  const [amount, setAmount] = useState<bigint | undefined>(undefined);
  const holdings = useQuery({
    queryKey: ['shielded', 'wallet', wallet],
    queryFn: async () => {
      const client = rhcClient();
      const [balance, allowance, room] = await Promise.all([
        client.readContract({ address: contracts.asset, abi: erc20, functionName: 'balanceOf', args: [wallet] }),
        client.readContract({ address: contracts.asset, abi: erc20, functionName: 'allowance', args: [wallet, contracts.Entrypoint] }),
        readRoom(contracts, wallet),
      ]);
      return { balance, allowance, room };
    },
  });
  const problem = depositProblem({
    amount,
    limits: poolLimits(contracts),
    poolBalance,
    walletBalance: holdings.data?.balance,
    room: holdings.data?.room,
  });
  const roomLine = depositRoomLine(holdings.data?.room);
  const ready = amount !== undefined && amount > 0n && problem === undefined && holdings.data !== undefined;
  const needsAllowance = ready && (holdings.data?.allowance ?? 0n) < amount;

  return (
    <div className="space-y-3">
      <AmountInput
        label="Deposit from this wallet"
        asset="USDG"
        value={text}
        onChange={(next, atomic) => {
          setText(next);
          setAmount(atomic);
        }}
        {...(problem ? { problem } : {})}
        hint={`Deposits are public: anyone can see this wallet put the amount in. What you withdraw later is not tied to it.${roomLine === undefined ? '' : ` ${roomLine}`}`}
      />
      <div className="flex flex-wrap gap-3">
        {/* Keyed apart: the two buttons share a slot, and a confirmed allowance would otherwise leave its
            "Done" face where the deposit button belongs. */}
        {needsAllowance ? (
          <TxButton
            key="allow"
            label={`Allow the pool to take ${usdgText(amount)} USDG`}
            tone="secondary"
            send={() => writeContractAsync({ address: contracts.asset, abi: erc20, functionName: 'approve', args: [contracts.Entrypoint, amount] })}
            onConfirmed={() => void holdings.refetch()}
          />
        ) : (
          <TxButton
            key="deposit"
            label={ready ? `Deposit ${usdgText(amount)} USDG` : 'Deposit'}
            tone="primary"
            disabled={!ready}
            send={async () => {
              const { shieldedEntrypointAbi } = await import('@bursar/sdk');
              const precommitment = await depositPrecommitment(keys, contracts, nextIndex);
              return writeContractAsync({
                address: contracts.Entrypoint,
                abi: shieldedEntrypointAbi,
                functionName: 'deposit',
                args: [contracts.asset, amount as bigint, precommitment],
              });
            }}
            onConfirmed={() => {
              setText('');
              setAmount(undefined);
              void holdings.refetch();
              onDone();
            }}
          />
        )}
      </div>
    </div>
  );
}

function NoteList({
  contracts,
  wallet,
  keys,
  notes,
  reading,
  set,
  onDone,
}: {
  readonly contracts: ShieldedDeployment;
  readonly wallet: Address;
  readonly keys: ShieldedKeys;
  readonly notes: readonly OwnedNote[];
  readonly reading: PoolReading;
  readonly set: AssociationSet | undefined;
  readonly onDone: () => void;
}) {
  const open = notes.filter((note) => note.status === 'spendable');
  const setReady = setMatchesChain(set, reading.latestRoot);
  // Held here, not in the form: a withdrawal that empties a deposit removes its card on the refresh
  // that follows, and the receipt would go with it.
  const [last, setLast] = useState<Withdrawn | undefined>(undefined);

  return (
    <Section title={open.length === 1 ? 'One deposit to spend from' : `${open.length} deposits to spend from`} description="Each deposit this wallet made, and what it still holds.">
      {last && (
        <Card>
          <div className="space-y-1 text-detail" role="status">
            <p>
              {usdgText(last.amount - last.fee)} USDG arrived at <AddressView value={last.recipient} />, sent by the relayer
              {last.fee > 0n ? ` after its ${usdgText(last.fee)} USDG fee` : ''}.
            </p>
            <TxHash hash={last.hash} />
          </div>
        </Card>
      )}
      {open.length === 0 ? (
        <Card>
          {notes.length === 0 ? (
            <EmptyState title="No deposits from this wallet yet.">Deposit above, then spend from it here.</EmptyState>
          ) : (
            <EmptyState title="Everything this wallet deposited has been spent or returned.">Deposit above to spend from the pool again.</EmptyState>
          )}
        </Card>
      ) : (
        <div className="space-y-4">
          {open.map((note) => (
            <NoteCard
              key={note.label.toString()}
              contracts={contracts}
              wallet={wallet}
              keys={keys}
              note={note}
              reading={reading}
              set={set}
              inSet={setReady && labelInSet(set, note.label)}
              onDone={onDone}
              onSent={setLast}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function NoteCard({
  contracts,
  wallet,
  keys,
  note,
  reading,
  set,
  inSet,
  onDone,
  onSent,
}: {
  readonly contracts: ShieldedDeployment;
  readonly wallet: Address;
  readonly keys: ShieldedKeys;
  readonly note: OwnedNote;
  readonly reading: PoolReading;
  readonly set: AssociationSet | undefined;
  readonly inSet: boolean;
  readonly onDone: () => void;
  readonly onSent: (withdrawn: Withdrawn) => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const depositedHere = sameAddress(note.deposit.depositor, wallet);

  return (
    <Card>
      <div className="space-y-4">
        <FieldGrid columns={3}>
          <Field label="Holds">
            <span className="tabular">{usdgText(note.value)} USDG</span>
          </Field>
          <Field label="Deposited in">
            <TxHash hash={note.deposit.transactionHash} />
          </Field>
          <Field label="Status">{inSet ? <Badge>Ready to spend</Badge> : <Badge tone="quiet">Waiting for approval</Badge>}</Field>
        </FieldGrid>
        <WithdrawForm contracts={contracts} keys={keys} note={note} reading={reading} set={set} inSet={inSet} onDone={onDone} onSent={onSent} />
        {depositedHere && (
          <div className="space-y-2 border-t border-[color:var(--color-line)] pt-4">
            <p className="text-sm font-medium">Take it back publicly</p>
            <p className="text-detail text-[color:var(--color-muted)]">
              Returns all {usdgText(note.value)} USDG to the wallet that deposited it. Anyone can see the return. This works even
              before the deposit is approved.
            </p>
            <TxButton
              label="Return it to this wallet"
              tone="secondary"
              send={async () => {
                const { shieldedPoolAbi } = await import('@bursar/sdk');
                const proof = await ragequitProof(note);
                return writeContractAsync({ address: contracts.ShieldedPool, abi: shieldedPoolAbi, functionName: 'ragequit', args: [proofArgs(proof)] });
              }}
              onConfirmed={onDone}
            />
          </div>
        )}
      </div>
    </Card>
  );
}

function proofArgs(proof: { pA: readonly bigint[]; pB: readonly (readonly bigint[])[]; pC: readonly bigint[]; pubSignals: readonly bigint[] }) {
  return {
    pA: [proof.pA[0], proof.pA[1]],
    pB: [
      [proof.pB[0]?.[0], proof.pB[0]?.[1]],
      [proof.pB[1]?.[0], proof.pB[1]?.[1]],
    ],
    pC: [proof.pC[0], proof.pC[1]],
    pubSignals: [proof.pubSignals[0], proof.pubSignals[1], proof.pubSignals[2], proof.pubSignals[3]],
  } as {
    pA: readonly [bigint, bigint];
    pB: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
    pC: readonly [bigint, bigint];
    pubSignals: readonly [bigint, bigint, bigint, bigint];
  };
}

function WithdrawForm({
  contracts,
  keys,
  note,
  reading,
  set,
  inSet,
  onDone,
  onSent,
}: {
  readonly contracts: ShieldedDeployment;
  readonly keys: ShieldedKeys;
  readonly note: OwnedNote;
  readonly reading: PoolReading;
  readonly set: AssociationSet | undefined;
  readonly inSet: boolean;
  readonly onDone: () => void;
  readonly onSent: (withdrawn: Withdrawn) => void;
}) {
  const params = useSearchParams();
  const intent = intentFromQuery(params);
  const { relayer, asp } = shieldedServices();
  const [purpose, setPurpose] = useState<WithdrawPurpose>(intent.purpose);
  const [recipientText, setRecipientText] = useState(intent.recipient ?? '');
  const [text, setText] = useState('');
  const [amount, setAmount] = useState<bigint | undefined>(undefined);
  const [phase, setPhase] = useState<'idle' | 'proving'>('idle');
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const quote = useQuery({
    queryKey: ['shielded', 'quote', relayer],
    queryFn: async () => (await import('@bursar/sdk')).fetchRelayQuote(relayer as string),
    enabled: relayer !== undefined,
  });
  const recipient = readAddress(recipientText);
  const gasDrop = PURPOSES[purpose].gasDrop;
  const amountProblem =
    withdrawProblem({ amount, note, inSet }) ?? (gasDrop ? gasDropProblem({ amount, quote: quote.data, maxRelayFeeBps: contracts.maxRelayFeeBps }) : undefined);
  const ready = relayer !== undefined && quote.data !== undefined && set !== undefined && recipient.value !== undefined && amount !== undefined && amount > 0n && amountProblem === undefined && phase === 'idle';

  const send = async () => {
    if (!ready || relayer === undefined || quote.data === undefined || set === undefined || recipient.value === undefined || amount === undefined) return;
    setProblem(undefined);
    setPhase('proving');
    try {
      const result = await withdrawThroughRelayer({
        keys,
        contracts,
        note,
        amount,
        recipient: recipient.value,
        gasDrop,
        relayerUrl: relayer,
        aspUrl: asp,
        quote: quote.data,
        events: reading.events,
        set,
      });
      onSent({ hash: result.transactionHash, recipient: recipient.value, amount, fee: relayFee(amount, relayFeeBpsFor(quote.data, amount, gasDrop)) });
      onDone();
    } catch (error) {
      setProblem(`Nothing was sent: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    } finally {
      setPhase('idle');
    }
  };

  return (
    <div className="space-y-3 border-t border-[color:var(--color-line)] pt-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="What the withdrawal is for">
        {(Object.keys(PURPOSES) as WithdrawPurpose[]).map((key) => (
          <Button key={key} size="sm" tone={key === purpose ? 'primary' : 'secondary'} onClick={() => setPurpose(key)} aria-pressed={key === purpose}>
            {PURPOSES[key].label}
          </Button>
        ))}
      </div>
      <p className="text-detail text-[color:var(--color-muted)]">{PURPOSES[purpose].hint}</p>
      <AddressInput
        label={purpose === 'mandate' ? 'Mandate address' : purpose === 'stealth-owner' ? 'Hidden owner address' : 'Provider address'}
        value={recipientText}
        onChange={setRecipientText}
        {...(recipient.problem ? { problem: recipient.problem } : {})}
      />
      <AmountInput
        label="Amount"
        asset="USDG"
        value={text}
        onChange={(next, atomic) => {
          setText(next);
          setAmount(atomic);
        }}
        {...(amountProblem ? { problem: amountProblem } : {})}
        hint={feeLine(amount, quote.data, gasDrop)}
      />
      {relayer === undefined ? (
        <p className="text-detail">Withdrawals are not available in this console yet.</p>
      ) : quote.error ? (
        <p className="text-detail">The relayer did not answer. Try again shortly.</p>
      ) : null}
      <Button tone="primary" onClick={() => void send()} disabled={!ready}>
        {phase === 'proving' ? 'Proving in this page' : 'Prove and send'}
      </Button>
      {problem && <Problem text={problem} />}
    </div>
  );
}

/** `fee` is what the relayer kept, so the confirmation can say what arrived rather than what left the pool. */
type Withdrawn = { readonly hash: Hex; readonly recipient: Address; readonly amount: bigint; readonly fee: bigint };

function Problem({ text }: { readonly text: string }) {
  return (
    <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
      {text}
    </p>
  );
}
