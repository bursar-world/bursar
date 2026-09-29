'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import type { Address } from 'viem';
import { useSignMessage } from 'wagmi';
import { committedMandateAccountAbi, micro } from '@bursar/core';
import { LockStatus, TermsLockedError, deriveViewingKey, latestSealedTerms, openTerms, viewingKeyMessage } from '@bursar/sdk';
import type { TermsDocument } from '@bursar/sdk';

import { rhcClient } from '@/chain/client';
import { PERIODS, privateContracts, readProvenPayments } from '@/chain/private';
import type { CommittedRead } from '@/chain/private';
import { sameAddress, shortAddress } from '@/chain/rhc';
import { Address as AddressView, TxHash } from '@/components/address';
import { Badge } from '@/components/badge';
import { Button } from '@/components/button';
import { Card, EmptyState, Field, FieldGrid, Section, Skeleton } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { usd } from '@/money';
import { useWalletAccount } from '@/wallet/account';
import { ConnectButton } from '@/wallet/connect-button';
import { useWriteContract } from '@/wallet/write';
import { ShareWithResolver } from '../lib/share-with-resolver';
import { PRIVATE_LIMIT_LINE } from '../new/private-create';

const STATUS_WORD: Record<number, string> = {
  [LockStatus.Locked]: 'Held in escrow',
  [LockStatus.Released]: 'Paid',
  [LockStatus.TimedOut]: 'Returned',
  [LockStatus.Disputed]: 'Contested',
  [LockStatus.Cancelled]: 'Cancelled by the provider',
  [LockStatus.Resolved]: 'Ruled',
};

export function periodLabel(seconds: number): string {
  return PERIODS.find((period) => period.seconds === seconds)?.label.toLowerCase() ?? `${seconds} seconds`;
}

/** A private mandate: what the chain shows, and the terms once the owner's viewing key opens them. */
export function CommittedMandateView({ mandate, onRefresh }: { readonly mandate: CommittedRead; readonly onRefresh: () => void }) {
  const { address: connected } = useWalletAccount();
  const isOwner = sameAddress(connected, mandate.principal);
  const [terms, setTerms] = useState<TermsDocument | undefined>(undefined);
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

      <Section title="On chain" description="Everything anyone can read about this mandate.">
        <Card>
          <FieldGrid columns={2}>
            <Field label="Owner">
              <AddressView value={mandate.principal} />
            </Field>
            <Field label="Agent">
              <AddressView value={mandate.agent} />
            </Field>
            <Field label="Proven payments" hint="Each one carried a proof the verifier accepted before the escrow took the money.">
              <span className="tabular">{mandate.nonce.toString()}</span>
            </Field>
            <Field label="Terms commitment" hint={`Version ${mandate.version.toString()}. A hash of the terms, not the terms.`}>
              <span className="font-mono text-detail">{`0x${mandate.termsCommitment.toString(16).padStart(64, '0').slice(0, 16)}…`}</span>
            </Field>
          </FieldGrid>
        </Card>
      </Section>

      <Section title="Terms" description="Readable only with the viewing key of the wallet that created this mandate.">
        <Card>
          {terms ? <TermsView terms={terms} onLock={() => setTerms(undefined)} /> : <Unlock mandate={mandate} fromBlock={fromBlock} onOpen={setTerms} />}
        </Card>
      </Section>

      <Section title="Payments" description="The amount and the provider of each one are public, because the escrow holds them.">
        <Card>
          {payments.isLoading ? (
            <Skeleton height={18} />
          ) : payments.error ? (
            <p className="text-detail text-[color:var(--color-muted)]">The payments could not be read. Check again in a moment.</p>
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
            <p className="text-detail text-[color:var(--color-muted)]">No payment yet. Fund the account and your agent can start.</p>
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
  readonly onOpen: (terms: TermsDocument) => void;
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
        setProblem('No sealed terms were found for this mandate.');
        return;
      }
      const key = deriveViewingKey(await signMessageAsync({ message: viewingKeyMessage(connected) }));
      onOpen(await openTerms(key.termsKey, mandate.principal, sealed.ciphertext));
    } catch (error) {
      setProblem(
        error instanceof TermsLockedError
          ? 'This wallet’s viewing key does not open these terms. Connect the wallet that created the mandate.'
          : 'The terms could not be opened. The signature was declined or the network did not answer.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Terms are private.</p>
      <p className="text-detail text-[color:var(--color-muted)]">
        Your wallet signs a fixed message. The key that opens the terms is derived from that signature in this page and is
        forgotten when you leave it. Signing costs nothing and moves nothing.
      </p>
      {!sameAddress(connected, mandate.principal) && (
        <p className="text-detail text-[color:var(--color-muted)]">
          The connected wallet is not the owner address. If you created this mandate with a hidden owner, its key still opens
          the terms, and your{' '}
          <Link href="/console/private" className="underline underline-offset-2">
            private mandates
          </Link>{' '}
          page holds its controls.
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

export function TermsView({ terms, onLock }: { readonly terms: TermsDocument; readonly onLock?: () => void }) {
  const classes = terms.classes.map((id) => (id === 'service' ? 'Services' : 'Agent hires')).join(' and ');
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
        <Field label="Ends on">{new Date(terms.expiry * 1000).toISOString().slice(0, 10)}</Field>
        <Field label="Allowed payments">{classes}</Field>
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
      {onLock && (
        <Button size="sm" tone="quiet" onClick={onLock}>
          Hide the terms
        </Button>
      )}
    </div>
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
