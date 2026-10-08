'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { erc20Abi } from 'viem';
import type { Address, Hex } from 'viem';
import { useSignMessage } from 'wagmi';
import { committedMandateAccountAbi, micro } from '@bursar/core';
import { escrowAbi } from '@/chain/abi';
import {
  LockStatus,
  amendArgs,
  carriedState,
  deriveViewingKey,
  latestSealedTerms,
  openTerms,
  recoverState,
  sealTerms,
  viewingKeyMessage,
  writeTerms,
} from '@bursar/sdk';
import type { TermsDocument } from '@bursar/sdk';

import { rhcClient } from '@/chain/client';
import {
  PERIODS,
  PRIVATE_CLASSES,
  downloadTerms,
  formFromTerms,
  privateContracts,
  readPrivateForm,
  readProvenPayments,
  returnable,
  termsProblem,
} from '@/chain/private';
import type { CommittedRead, PrivateForm } from '@/chain/private';
import { ADDRESSES, sameAddress, shortAddress } from '@/chain/rhc';
import { AmountInput } from '@/components/amount-input';
import { Address as AddressView, TxHash } from '@/components/address';
import { Badge } from '@/components/badge';
import { Button } from '@/components/button';
import { ClaimOwedButton, owedExplanation } from '@/components/claim-owed';
import { Instant } from '@/components/instant';
import { Card, EmptyState, Field, FieldGrid, Section, Skeleton } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { usd, usdExact } from '@/money';
import { useWalletAccount } from '@/wallet/account';
import { ConnectButton } from '@/wallet/connect-button';
import { useWriteContract } from '@/wallet/write';
import { readUsdgAmount } from '../lib/amount';
import { ShareWithResolver } from '../lib/share-with-resolver';
import { PRIVATE_LIMIT_LINE } from '../new/private-create';

const STATUS_WORD: Record<number, string> = {
  [LockStatus.Locked]: 'Held in escrow',
  [LockStatus.Released]: 'Paid',
  [LockStatus.TimedOut]: 'Returned',
  [LockStatus.Disputed]: 'Contested',
  [LockStatus.Cancelled]: 'Cancelled by the provider',
  [LockStatus.Resolved]: 'Ruled on',
};

export function periodLabel(seconds: number): string {
  return PERIODS.find((period) => period.seconds === seconds)?.label.toLowerCase() ?? `${seconds} seconds`;
}

/** Terms the viewing key opened and checked against the commitment, with the key that sealed them. */
export type OpenedTerms = { readonly terms: TermsDocument; readonly termsKey: Uint8Array };

/** A private mandate: what the chain shows, and the terms once the owner's viewing key opens them. */
export function CommittedMandateView({ mandate, onRefresh }: { readonly mandate: CommittedRead; readonly onRefresh: () => void }) {
  const { address: connected } = useWalletAccount();
  const isOwner = sameAddress(connected, mandate.principal);
  const [opened, setOpened] = useState<OpenedTerms | undefined>(undefined);
  const { writeContractAsync } = useWriteContract();
  const terms = opened?.terms;
  const fromBlock = BigInt(privateContracts()?.fromBlock ?? 0);

  const payments = useQuery({
    queryKey: ['console', 'proven-payments', mandate.address, mandate.nonce.toString()],
    queryFn: () => readProvenPayments(mandate, fromBlock),
  });

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <Link href="/console" className="font-mono text-label uppercase tracking-wide text-[color:var(--color-muted)] transition-colors hover:text-[color:var(--color-ink)]">
              All mandates
            </Link>
            <h1 className="page-title">Private mandate</h1>
            <AddressView value={mandate.address} full />
          </div>
          <div className="flex items-center gap-2">
            <span className="tabular text-sm">{usd(micro(mandate.balance))}</span>
            <Button size="sm" onClick={onRefresh}>
              Check again
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="quiet">Private terms</Badge>
          {mandate.paused && <Badge>Paused</Badge>}
          {mandate.revoked && <Badge>Revoked</Badge>}
        </div>
        <p className="max-w-3xl text-detail text-[color:var(--color-muted)]">{PRIVATE_LIMIT_LINE}</p>
      </div>

      <Section title="On chain" description="What anyone can see about this mandate.">
        <Card>
          <FieldGrid columns={2}>
            <Field label="Owner">
              <AddressView value={mandate.principal} />
            </Field>
            <Field label="Agent">
              <AddressView value={mandate.agent} />
            </Field>
            <Field label="Balance" hint="USDG the agent can spend, only within the private terms.">
              <span className="tabular">{usd(micro(mandate.balance))}</span>
            </Field>
            <Field label="Proven payments" hint="Each payment proves it meets the private terms before any money moves.">
              <span className="tabular">{mandate.nonce.toString()}</span>
            </Field>
            <Field label="Terms commitment" hint={`Version ${mandate.version.toString()}. A fingerprint of the terms, which stay private.`}>
              <span className="font-mono text-detail">{`0x${mandate.termsCommitment.toString(16).padStart(64, '0').slice(0, 16)}…`}</span>
            </Field>
          </FieldGrid>
        </Card>
      </Section>

      {mandate.owed !== undefined && mandate.owed > 0n && (
        <Section title="Held for this mandate" description="A payout the escrow could not deliver when a payment settled.">
          <Card>
            <div className="space-y-4">
              <p className="max-w-3xl text-sm">
                The escrow is holding <span className="tabular font-medium">{usdExact(micro(mandate.owed))}</span> for this
                mandate. {owedExplanation('this mandate')}
              </p>
              {connected === undefined ? (
                <p className="text-detail text-[color:var(--color-muted)]">Connect a wallet to claim it. Any wallet can.</p>
              ) : (
                <ClaimOwedButton
                  escrow={mandate.escrow}
                  party={mandate.address}
                  label="Claim it for this mandate"
                  blockedBy={[]}
                  onClaimed={onRefresh}
                />
              )}
            </div>
          </Card>
        </Section>
      )}

      {connected !== undefined && !mandate.revoked && <Fund mandate={mandate} onDone={onRefresh} />}

      <Section title="Terms" description="The limits, capabilities and providers, sealed on chain.">
        <Card>
          {opened ? (
            <div className="space-y-4">
              <TermsView
                terms={opened.terms}
                onLock={() => setOpened(undefined)}
                {...(isOwner
                  ? {
                      actions: (
                        <Button size="sm" onClick={() => downloadTerms(mandate.address, opened.terms)}>
                          Download the terms for your agent
                        </Button>
                      ),
                    }
                  : {})}
              />
              {isOwner && !mandate.revoked && (
                <AmendTerms
                  mandate={mandate.address}
                  opened={opened}
                  version={mandate.version}
                  fromBlock={fromBlock}
                  send={async (args) => {
                    const hash = await writeContractAsync({ address: mandate.address, abi: committedMandateAccountAbi, functionName: 'amend', args });
                    const receipt = await rhcClient().waitForTransactionReceipt({ hash });
                    if (receipt.status !== 'success') throw new Error(`the transaction was refused (${hash})`);
                  }}
                  onAmended={(next) => {
                    setOpened({ terms: next, termsKey: opened.termsKey });
                    onRefresh();
                  }}
                />
              )}
            </div>
          ) : (
            <Unlock mandate={mandate} fromBlock={fromBlock} onOpen={setOpened} />
          )}
        </Card>
      </Section>

      <Section title="Payments" description="Each payment waits in escrow, where its amount and provider are public.">
        <Card>
          {payments.isLoading ? (
            <Skeleton height={18} />
          ) : payments.error ? (
            <p className="text-detail text-[color:var(--color-muted)]">Payments could not be loaded. Use Check again at the top of the page.</p>
          ) : payments.data && payments.data.length > 0 ? (
            <ul className="divide-y divide-[color:var(--color-line)]">
              {payments.data.map((payment) => (
                <li key={payment.escrowId.toString()} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm">
                      <span className="tabular">{usd(micro(payment.amount))}</span> to {shortAddress(payment.payee)}
                    </p>
                    <p className="text-detail text-[color:var(--color-muted)]">
                      Payment {payment.escrowId.toString()} · {STATUS_WORD[payment.status] ?? 'Unknown'} · <TxHash hash={payment.hash} />
                    </p>
                  </div>
                  {isOwner && (
                    <PaymentAction mandate={mandate} payment={payment} terms={terms} onDone={onRefresh} />
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-detail text-[color:var(--color-muted)]">
              {mandate.balance > 0n ? 'No payments yet.' : 'No payments yet. Add funds and your agent can start.'}
            </p>
          )}
        </Card>
      </Section>

      {isOwner && <Controls mandate={mandate} onDone={onRefresh} />}
    </div>
  );
}

function PaymentAction({
  mandate,
  payment,
  terms,
  onDone,
}: {
  readonly mandate: CommittedRead;
  readonly payment: Awaited<ReturnType<typeof readProvenPayments>>[number];
  readonly terms: TermsDocument | undefined;
  readonly onDone: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  if (payment.status === LockStatus.Disputed) {
    return (
      <ShareWithResolver
        escrow={mandate.escrow}
        lockId={payment.escrowId}
        inputURI={payment.inputURI}
        payee={payment.payee}
        {...(terms ? { terms } : {})}
      />
    );
  }
  if (payment.status !== LockStatus.Locked) return null;
  if (returnable(payment, BigInt(Math.floor(Date.now() / 1000)))) {
    return (
      <TxButton
        label="Return the money"
        tone="secondary"
        send={() => writeContractAsync({ address: mandate.escrow, abi: escrowAbi, functionName: 'timeout', args: [payment.escrowId] })}
        onContinue={onDone}
      />
    );
  }
  return (
    <TxButton
      label="Contest"
      tone="secondary"
      send={() =>
        writeContractAsync({ address: mandate.address, abi: committedMandateAccountAbi, functionName: 'disputeSpend', args: [payment.escrowId] })
      }
      onContinue={onDone}
    />
  );
}

function Unlock({
  mandate,
  fromBlock,
  onOpen,
}: {
  readonly mandate: CommittedRead;
  readonly fromBlock: bigint;
  readonly onOpen: (opened: OpenedTerms) => void;
}) {
  const { address: connected, isConnected } = useWalletAccount();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  if (!isConnected || connected === undefined) {
    return (
      <EmptyState title="Terms are private." action={<ConnectButton />}>
        Connect the wallet that created this mandate to open them.
      </EmptyState>
    );
  }

  const unlock = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const sealed = await latestSealedTerms(rhcClient(), mandate.address, fromBlock);
      if (sealed === null) {
        setProblem('No private terms were found for this mandate.');
        return;
      }
      const key = deriveViewingKey(await signMessageAsync({ message: viewingKeyMessage(connected) }));
      const terms = await openTerms(key.termsKey, {
        account: mandate.address,
        version: sealed.version,
        termsCommitment: mandate.termsCommitment,
        ciphertext: sealed.ciphertext,
      });
      onOpen({ terms, termsKey: key.termsKey });
    } catch (error) {
      setProblem(termsProblem(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Terms are private.</p>
      <p className="text-detail text-[color:var(--color-muted)]">
        Your wallet signs a message to open them. Signing is free and moves no funds.
      </p>
      {!sameAddress(connected, mandate.principal) && (
        <p className="text-detail text-[color:var(--color-muted)]">
          This wallet is not the owner. If you created this mandate with a hidden owner, your wallet still opens the terms,
          and its controls are on your{' '}
          <Link href="/console/private" className="underline underline-offset-2">
            private mandates
          </Link>{' '}
          page.
        </p>
      )}
      <Button onClick={() => void unlock()} disabled={busy}>
        {busy ? 'Waiting for the signature' : 'Unlock with viewing key'}
      </Button>
      {problem && (
        <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
          {problem}
        </p>
      )}
    </div>
  );
}

export function TermsView({
  terms,
  onLock,
  actions,
}: {
  readonly terms: TermsDocument;
  readonly onLock?: () => void;
  readonly actions?: ReactNode;
}) {
  const classes = PRIVATE_CLASSES.filter((id) => terms.capabilities.some((label) => label.startsWith(`${id}:`)))
    .map((id) => (id === 'service' ? 'Services' : 'Agent hires'))
    .join(' and ');
  return (
    <div className="space-y-4">
      {terms.label && <p className="text-sm font-medium">{terms.label}</p>}
      <FieldGrid columns={2}>
        <Field label="Per payment">
          <span className="tabular">{usd(micro(BigInt(terms.perCallCap)))}</span>
        </Field>
        <Field label={`Per ${periodLabel(terms.periodLen)}`}>
          <span className="tabular">{usd(micro(BigInt(terms.periodCap)))}</span>
        </Field>
        <Field label="Total budget">
          <span className="tabular">{usd(micro(BigInt(terms.totalCap)))}</span>
        </Field>
        <Field label="Ends on">
          <Instant at={new Date(terms.expiry * 1000)} />
        </Field>
        <Field label="Allowed payments">{classes}</Field>
        <Field label="Capabilities" hint="Each payment proves its work is one of these.">
          <ul className="space-y-1">
            {terms.capabilities.map((label) => (
              <li key={label}>
                <code className="font-mono text-detail">{label}</code>
              </li>
            ))}
          </ul>
        </Field>
        <Field label="Providers">
          <ul className="space-y-1">
            {terms.counterparties.map((entry: Address) => (
              <li key={entry}>
                <AddressView value={entry} />
              </li>
            ))}
          </ul>
        </Field>
      </FieldGrid>
      {(actions || onLock) && (
        <div className="flex flex-wrap items-center gap-3">
          {actions}
          {onLock && (
            <Button size="sm" tone="quiet" onClick={onLock}>
              Hide the terms
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Replaces the caps and the end date of terms that are open. The capabilities and providers stay.
 *
 * The counters carry over, read back from the chain against the terms in force, so the new caps
 * count what the agent has already spent. The new copy is sealed for the next version and the
 * amendment sets the counter it starts from. The agent proves against its own copy of the terms,
 * so it cannot pay again until it has the new one.
 */
export function AmendTerms({
  mandate,
  opened,
  version,
  fromBlock,
  send,
  onAmended,
}: {
  readonly mandate: Address;
  readonly opened: OpenedTerms;
  readonly version: bigint;
  readonly fromBlock: bigint;
  readonly send: (args: readonly [bigint, bigint, bigint, Hex]) => Promise<void>;
  readonly onAmended: (terms: TermsDocument) => void;
}) {
  const [form, setForm] = useState<PrivateForm>(() => formFromTerms(opened.terms));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);
  const reading = readPrivateForm(form);
  const set = (patch: Partial<PrivateForm>) => setForm({ ...form, ...patch });

  const amend = async () => {
    if (!reading.terms) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const state = await recoverState(rhcClient(), mandate, opened.terms, fromBlock);
      const next = writeTerms(
        { ...reading.terms, ...(opened.terms.label ? { label: opened.terms.label } : {}) },
        carriedState(state, opened.terms, reading.terms.periodLen),
      );
      await send(amendArgs(next, await sealTerms(opened.termsKey, { account: mandate, version: version + 1n }, next)));
      setDone(true);
      onAmended(next);
    } catch (error) {
      setProblem(`The terms were not amended: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-[color:var(--color-line)] pt-4">
      <p className="text-sm font-medium">Amend the terms</p>
      <p className="text-detail text-[color:var(--color-muted)]">
        New limits and the end date apply from the next payment, and spending so far still counts. Your agent proves each
        payment against its own copy of the terms, so give it the new ones once this confirms.
      </p>
      <FieldGrid columns={2}>
        <AmountInput asset="USDG" label="Per payment" value={form.perCall} onChange={(perCall) => set({ perCall })} />
        <AmountInput asset="USDG" label="Total budget" value={form.total} onChange={(total) => set({ total })} />
        <AmountInput asset="USDG" label={`Per ${periodLabel(form.periodLen)}`} value={form.periodCap} onChange={(periodCap) => set({ periodCap })} />
        <Field label="Ends on">
          <input
            type="date"
            aria-label="Ends on"
            className="w-full rounded-md border border-[color:var(--color-line)] bg-transparent px-3 py-2 text-sm"
            value={form.expiry}
            onChange={(event) => set({ expiry: event.target.value })}
          />
        </Field>
      </FieldGrid>
      <Button onClick={() => void amend()} disabled={busy || reading.terms === undefined}>
        {busy ? 'Amending' : 'Amend the terms'}
      </Button>
      {done && <p className="text-detail">The new terms apply now. Give your agent the new copy.</p>}
      {[...reading.problems, ...(problem ? [problem] : [])].map((line) => (
        <p key={line} className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
          {line}
        </p>
      ))}
    </div>
  );
}

/**
 * A private mandate is funded by a plain USDG transfer, so any wallet can send it. One transaction,
 * no allowance. What it sends shows on chain, which is the funding link the page states above.
 */
function Fund({ mandate, onDone }: { readonly mandate: CommittedRead; readonly onDone: () => void }) {
  const { address: connected } = useWalletAccount();
  const { writeContractAsync } = useWriteContract();
  const [text, setText] = useState('');
  const amount = readUsdgAmount(text);
  const wallet = useQuery({
    queryKey: ['console', 'wallet-usdg', connected],
    enabled: connected !== undefined,
    queryFn: () =>
      rhcClient().readContract({ address: ADDRESSES.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [connected as Address] }),
  });

  return (
    <Section title="Add funds" description="Send USDG from your wallet. The agent can spend it only within the private terms.">
      <Card>
        <div className="max-w-md space-y-3">
          <AmountInput
            label="Amount"
            asset="USDG"
            value={text}
            onChange={setText}
            {...(wallet.data === undefined ? {} : { hint: `Your wallet holds ${usd(micro(wallet.data))}.` })}
            {...(amount.problem === undefined ? {} : { problem: amount.problem })}
          />
          <TxButton
            label="Send it to the mandate"
            disabled={amount.value === undefined || amount.value <= 0n}
            send={() =>
              writeContractAsync({ address: ADDRESSES.usdg, abi: erc20Abi, functionName: 'transfer', args: [mandate.address, amount.value as bigint] })
            }
            onConfirmed={() => {
              setText('');
              onDone();
              void wallet.refetch();
            }}
          />
        </div>
      </Card>
    </Section>
  );
}

function Controls({ mandate, onDone }: { readonly mandate: CommittedRead; readonly onDone: () => void }) {
  const { writeContractAsync } = useWriteContract();
  return (
    <Section title="Controls" description="Only the owner can use these.">
      <Card>
        <div className="flex flex-wrap gap-3">
          <TxButton
            label={mandate.paused ? 'Resume spending' : 'Pause spending'}
            tone="secondary"
            send={() =>
              writeContractAsync({ address: mandate.address, abi: committedMandateAccountAbi, functionName: 'setPaused', args: [!mandate.paused] })
            }
            onContinue={onDone}
          />
        </div>
      </Card>
    </Section>
  );
}
