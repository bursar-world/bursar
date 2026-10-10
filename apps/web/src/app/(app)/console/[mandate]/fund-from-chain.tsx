'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { erc20Abi, parseEventLogs } from 'viem';
import type { Address, Hex } from 'viem';
import { useBalance, useConfig, useReadContract, useSendTransaction, useSwitchChain } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';
import type { Micro } from '@bursar/core';
import { micro } from '@bursar/core';

import { rhcClient } from '@/chain/client';
import { ADDRESSES, CHAIN_ID } from '@/chain/rhc';
import { errorLine, isUserRejection } from '@/components/error-surface';
import { parseAmount } from '@/money';
import { RelayQuoteError, SOURCE_CHAINS, failureLine, isSettled, nextPoll, relayApi, relayBridgeLink, sourceChain } from '@/relay';
import type { FundingQuote, SourceChain, SourceKey } from '@/relay';
import { useWalletAccount } from '@/wallet/account';
import { FundFromChainView, formatSource } from './fund-from-chain-view';
import type { Carried, FundingPhase } from './fund-from-chain-view';
import { useMandateScope } from './mandate-scope';

/**
 * Funding from Base, Arc or Solana, through Relay.
 *
 * The console quotes as the amount is typed, signs the deposit in the connected wallet on the
 * source chain, then follows Relay's request until the USDG is in the mandate. Relay pays the
 * mandate directly, so the arrival is read the same way every balance here is read: from the
 * settlement asset's own ledger on Robinhood Chain.
 *
 * The request in flight is kept in session storage, so a reload mid-transfer picks it back up
 * rather than leaving the reader with a signed deposit and no screen following it.
 */
const QUOTE_DELAY_MS = 400;
const QUOTE_FRESH_MS = 45_000;
const BALANCE_WATCH_MS = 6_000;

/** A valid Solana address to price a route with, where the reader's own is not known. */
const SOLANA_QUOTE_USER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export function FundFromChain() {
  const { address: recipient, account, connected, refresh } = useMandateScope();
  const wallet = useWalletAccount();
  const config = useConfig();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const api = useMemo(() => relayApi({ base: '/api/relay' }), []);

  const [sourceKey, setSourceKey] = useState<SourceKey>('base');
  const [amountText, setAmountText] = useState('');
  const [phase, setPhase] = useState<FundingPhase>(IDLE);
  const [flowActive, setFlowActive] = useState(false);
  const quotedAt = useRef(0);
  const baseline = useRef<Micro | undefined>(undefined);

  const source = sourceChain(sourceKey) ?? (SOURCE_CHAINS[0] as SourceChain);
  const destination = useMemo(() => ({ chainId: CHAIN_ID, currency: ADDRESSES.usdg }), []);

  const sourceBalance = useReadContract({
    chainId: source.chainId,
    address: source.usdc.address as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: connected === undefined ? undefined : [connected],
    query: { enabled: source.vm === 'evm' && connected !== undefined, refetchInterval: 15_000 },
  });
  const gas = useBalance({
    chainId: source.chainId,
    address: connected,
    query: { enabled: source.vm === 'evm' && connected !== undefined, refetchInterval: 15_000 },
  });

  const amount = readAmount(amountText, source, sourceBalance.data);

  // A request left in flight by an earlier page load, or named in the address bar, is followed
  // from where it stands. Nothing is signed again.
  useEffect(() => {
    const carried = recall(recipient);
    if (carried === undefined) return;
    setSourceKey(carried.sourceKey);
    baseline.current = undefined;
    setFlowActive(true);
    setPhase({ kind: 'awaiting', carried, status: undefined });
  }, [recipient]);

  const quoteFor = useCallback(
    async (chain: SourceChain, value: bigint, signal: AbortSignal): Promise<FundingQuote> => {
      if (chain.vm === 'evm') {
        return api.quote({ user: connected ?? recipient, recipient, source: chain, amount: value, destination }, signal);
      }
      // A deposit address is the better Solana path and needs Relay's key on the server. Without
      // one Relay says so, and the route is priced for the reader to sign on Relay's own page.
      try {
        return await api.quote({ user: recipient, recipient, source: chain, amount: value, destination, depositAddress: true }, signal);
      } catch (error) {
        if (!(error instanceof RelayQuoteError) || !(error.code === 'UNAUTHORIZED' || error.code === 'UNAUTHORIZED_QUOTE')) throw error;
        return api.quote({ user: SOLANA_QUOTE_USER, recipient, source: chain, amount: value, destination }, signal);
      }
    },
    [api, connected, recipient, destination],
  );

  const quoteKey = amount.value === undefined ? undefined : `${source.key}:${amount.value.toString()}:${connected ?? ''}`;

  useEffect(() => {
    if (flowActive) return;
    if (quoteKey === undefined || amount.value === undefined) {
      setPhase(IDLE);
      return;
    }
    const value = amount.value;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPhase({ kind: 'quoting' });
      quoteFor(source, value, controller.signal).then(
        (quote) => {
          if (controller.signal.aborted) return;
          quotedAt.current = Date.now();
          setPhase({ kind: 'quoted', quote });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setPhase({ kind: 'refused', reason: error instanceof Error ? error.message : 'Relay did not answer.' });
        },
      );
    }, QUOTE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `amount.value` is carried by `quoteKey`; `source` by its key inside it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey, flowActive, quoteFor]);

  const fund = useCallback(async () => {
    if (phase.kind !== 'quoted') return;
    let quote = phase.quote;
    setFlowActive(true);

    if (source.vm === 'svm') {
      const carried: Carried = { requestId: quote.requestId, sourceKey: source.key, sends: quote.source.amount, expected: quote.arrives.expected, depositHash: undefined };
      baseline.current = account?.balance;
      remember(recipient, carried);
      setPhase({ kind: 'awaiting', carried, status: undefined });
      return;
    }

    try {
      if (Date.now() - quotedAt.current > QUOTE_FRESH_MS) {
        setPhase({ kind: 'quoting' });
        quote = await quoteFor(source, quote.source.amount, new AbortController().signal);
      }
      if (wallet.chainId !== source.chainId) {
        setPhase({ kind: 'signing', quote, step: 'switch' });
        await switchChainAsync({ chainId: source.chainId });
      }

      let depositHash: Hex | undefined;
      for (const step of quote.steps) {
        for (const call of step.calls) {
          setPhase({ kind: 'signing', quote, step: step.id });
          const hash = await sendTransactionAsync({
            chainId: call.chainId,
            to: call.to,
            data: call.data,
            value: call.value,
            ...(call.gas === undefined ? {} : { gas: call.gas }),
          });
          await waitForTransactionReceipt(config, { chainId: call.chainId, hash });
          depositHash = hash;
        }
      }

      const carried: Carried = { requestId: quote.requestId, sourceKey: source.key, sends: quote.source.amount, expected: quote.arrives.expected, depositHash };
      baseline.current = account?.balance;
      remember(recipient, carried);
      setPhase({ kind: 'awaiting', carried, status: undefined });
      // Back onto Robinhood Chain for the rest of the console. A wallet that declines stays where it is.
      switchChainAsync({ chainId: CHAIN_ID }).catch(() => undefined);
    } catch (error) {
      setFlowActive(false);
      if (isUserRejection(error)) {
        setPhase({ kind: 'quoted', quote, note: 'Your wallet did not sign, so nothing was sent.' });
        return;
      }
      setPhase({ kind: 'failed', carried: undefined, reason: errorLine(error, 'Sending the deposit'), refundHash: undefined });
    }
  }, [phase, source, account?.balance, recipient, wallet.chainId, switchChainAsync, sendTransactionAsync, config, quoteFor]);

  const requestId = phase.kind === 'awaiting' ? phase.carried.requestId : undefined;
  const status = useQuery({
    queryKey: ['relay', 'status', requestId],
    queryFn: () => api.status(requestId as Hex),
    enabled: requestId !== undefined,
    refetchInterval: (query) => (requestId === undefined ? false : nextPoll(query.state.data)),
    retry: 2,
  });

  const settle = useCallback(
    async (carried: Carried, fillHash: string | undefined) => {
      const landed = fillHash === undefined ? undefined : await landedAmount(fillHash as Hex, recipient).catch(() => undefined);
      forget(recipient);
      refresh();
      setPhase({ kind: 'arrived', carried, fillHash, landed: landed ?? carried.expected });
    },
    [recipient, refresh],
  );

  useEffect(() => {
    if (phase.kind !== 'awaiting' || status.data === undefined) return;
    const latest = status.data;
    if (!isSettled(latest)) {
      if (latest.phase !== phase.status?.phase) setPhase({ ...phase, status: latest });
      return;
    }
    if (latest.phase === 'success') {
      void settle(phase.carried, latest.txHashes[0]);
      return;
    }
    forget(recipient);
    setPhase({ kind: 'failed', carried: phase.carried, reason: failureLine(latest, source.name), refundHash: latest.txHashes[0] });
  }, [status.data, phase, settle, recipient, source.name]);

  // The ledger is the last word. A transfer the status check cannot see, which is the case for a
  // deposit signed on Relay's own page, still shows up as USDG in the account.
  useEffect(() => {
    if (phase.kind !== 'awaiting') return;
    const timer = setInterval(() => refresh(), BALANCE_WATCH_MS);
    return () => clearInterval(timer);
  }, [phase.kind, refresh]);

  useEffect(() => {
    if (phase.kind !== 'awaiting' || account === undefined) return;
    if (baseline.current === undefined) {
      baseline.current = account.balance;
      return;
    }
    if (account.balance <= baseline.current) return;
    if (source.vm === 'evm' && status.error === null) return;
    const landed = micro(account.balance - baseline.current);
    forget(recipient);
    setPhase({ kind: 'arrived', carried: phase.carried, fillHash: status.data?.txHashes[0], landed });
  }, [account, phase, source.vm, status.error, status.data, recipient]);

  const reset = useCallback(() => {
    forget(recipient);
    baseline.current = undefined;
    setFlowActive(false);
    setAmountText('');
    setPhase(IDLE);
  }, [recipient]);

  return (
    <FundFromChainView
      sources={SOURCE_CHAINS}
      source={source}
      recipient={recipient}
      amountText={amountText}
      amountProblem={amount.problem}
      phase={phase}
      connected={connected !== undefined}
      sourceBalance={sourceBalance.data}
      noGas={gas.data !== undefined && gas.data.value === 0n}
      relayLink={relayBridgeLink({ source, recipient, destinationCurrency: ADDRESSES.usdg, amount: amountText.trim() })}
      onSource={(key) => {
        setSourceKey(key);
      }}
      onAmount={setAmountText}
      onFund={() => void fund()}
      onReset={reset}
    />
  );
}

const IDLE: FundingPhase = { kind: 'idle' };

function readAmount(text: string, source: SourceChain, held: bigint | undefined): { readonly value: bigint | undefined; readonly problem: string | undefined } {
  if (text.trim() === '') return { value: undefined, problem: undefined };
  const parsed = parseAmount(text, source.usdc.decimals);
  if (!parsed.ok) return { value: undefined, problem: parsed.problem };
  if (parsed.value <= 0n) return { value: undefined, problem: 'Enter a positive amount.' };
  if (held !== undefined && parsed.value > held) return { value: undefined, problem: `Your wallet holds ${formatSource(held, source)} on ${source.name}.` };
  return { value: parsed.value, problem: undefined };
}

/** USDG the fill moved into the mandate, read from the receipt on Robinhood Chain. */
async function landedAmount(hash: Hex, recipient: Address): Promise<Micro | undefined> {
  const receipt = await rhcClient().getTransactionReceipt({ hash });
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs });
  const landed = transfers
    .filter((log) => log.address.toLowerCase() === ADDRESSES.usdg.toLowerCase() && log.args.to.toLowerCase() === recipient.toLowerCase())
    .reduce((total, log) => total + log.args.value, 0n);
  return landed === 0n ? undefined : micro(landed);
}

const STORAGE = 'bursar.relay-funding';

type Stored = { readonly requestId: Hex; readonly sourceKey: SourceKey; readonly sends?: string; readonly expected?: string; readonly depositHash?: string };

function remember(mandate: Address, carried: Carried): void {
  if (typeof window === 'undefined') return;
  const stored: Stored = {
    requestId: carried.requestId,
    sourceKey: carried.sourceKey,
    ...(carried.sends === undefined ? {} : { sends: carried.sends.toString() }),
    ...(carried.expected === undefined ? {} : { expected: carried.expected.toString() }),
    ...(carried.depositHash === undefined ? {} : { depositHash: carried.depositHash }),
  };
  try {
    window.sessionStorage.setItem(`${STORAGE}.${mandate.toLowerCase()}`, JSON.stringify(stored));
  } catch {
    // Storage that refuses costs the reader a reload's worth of tracking and nothing else.
  }
}

function forget(mandate: Address): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(`${STORAGE}.${mandate.toLowerCase()}`);
  } catch {
    // As above.
  }
}

/** The request to follow: one named in the address bar first, then one this session left in flight. */
function recall(mandate: Address): Carried | undefined {
  if (typeof window === 'undefined') return undefined;
  const asked = new URLSearchParams(window.location.search);
  const named = asked.get('relay');
  const from = asked.get('from');
  if (named !== null && /^0x[0-9a-fA-F]{64}$/.test(named) && (from === null || sourceChain(from) !== undefined)) {
    return { requestId: named as Hex, sourceKey: (from ?? 'base') as SourceKey, sends: undefined, expected: undefined, depositHash: undefined };
  }
  try {
    const raw = window.sessionStorage.getItem(`${STORAGE}.${mandate.toLowerCase()}`);
    if (raw === null) return undefined;
    const stored = JSON.parse(raw) as Stored;
    if (sourceChain(stored.sourceKey) === undefined) return undefined;
    return {
      requestId: stored.requestId,
      sourceKey: stored.sourceKey,
      sends: stored.sends === undefined ? undefined : BigInt(stored.sends),
      expected: stored.expected === undefined ? undefined : micro(BigInt(stored.expected)),
      depositHash: stored.depositHash,
    };
  } catch {
    return undefined;
  }
}
