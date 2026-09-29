'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { parseEventLogs } from 'viem';
import type { Address, Hex } from 'viem';
import { useSendTransaction, useSignMessage } from 'wagmi';
import { committedMandateFactoryAbi } from '@bursar/core';
import type { StealthMandatePlan, TermsDocument, TermsInput } from '@bursar/sdk';

import { rhcClient } from '@/chain/client';
import { randomSalt } from '@/chain/mandates';
import { privateContracts } from '@/chain/private';
import { CHAIN_ID } from '@/chain/rhc';
import { shieldedContracts, shieldedHref } from '@/chain/shielded';
import {
  SHIELDED_TIMING_LINE,
  STEALTH_LIMIT_LINE,
  STEALTH_STEP_LABEL,
  agentGasWei,
  agentKeyFile,
  createGasWei,
  downloadFile,
  formatEth,
  ownerKeysFrom,
  remainingSteps,
  sendEthFromStealth,
  sendFromStealth,
  spareForAgent,
} from '@/chain/stealth';
import type { OwnerKeys, StealthStep } from '@/chain/stealth';
import { Address as AddressView, TxHash } from '@/components/address';
import { Button } from '@/components/button';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { useWriteContract } from '@/wallet/write';

const POLL_MS = 4_000;

type Prepared = { readonly keys: OwnerKeys; readonly plan: StealthMandatePlan };
type Created = { readonly mandate: Address; readonly hash: Hex; readonly terms: TermsDocument; readonly fromBlock: bigint };

/** The switch inside private terms that puts the owner and the agent at fresh stealth addresses. */
export function StealthToggle({ on, onChange, disabled = false }: { readonly on: boolean; readonly onChange: (on: boolean) => void; readonly disabled?: boolean }) {
  return (
    <label className="flex items-start gap-2 text-detail">
      <input type="checkbox" checked={on} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-1" />
      <span>
        <span className="font-medium">Hide the owner and the agent.</span>
        <span className="block text-[color:var(--color-muted)]">
          The mandate is owned by a new address drawn from your wallet’s keys, and the agent gets one too. Nobody reading the
          chain can tell they belong to you. Your console finds them again from one signature.
        </span>
        <span className="block text-[color:var(--color-muted)]">{STEALTH_LIMIT_LINE}</span>
      </span>
    </label>
  );
}

/**
 * Creating a private mandate with a stealth owner and agent.
 *
 * One signature from the connected wallet derives the owner's keys. Two fresh stealth addresses are
 * drawn from them: the owner side sends the announcements and the create itself, signed in this
 * page, so the connected wallet never appears in those transactions. It needs gas first.
 */
export function StealthCreate({
  owner,
  terms,
  label,
}: {
  readonly owner: Address;
  readonly terms: TermsInput | undefined;
  readonly label: string;
}) {
  const factory = privateContracts()?.CommittedMandateFactory;
  const { signMessageAsync } = useSignMessage();
  const [prepared, setPrepared] = useState<Prepared | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<ReadonlySet<StealthStep>>(new Set());
  const [hashes, setHashes] = useState<Partial<Record<StealthStep, Hex>>>({});
  const [created, setCreated] = useState<Created | undefined>(undefined);
  // Fixed at the first create attempt, so a retry after a failed step commits to the same terms.
  const sealed = useRef<{ terms: TermsDocument; ciphertext: Hex; salt: Hex } | undefined>(undefined);

  if (factory === undefined) return null;
  if (created && prepared) return <StealthCreated created={created} prepared={prepared} />;

  const prepare = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const { planStealthMandate, viewingKeyMessage } = await import('@bursar/sdk');
      const keys = await ownerKeysFrom(await signMessageAsync({ message: viewingKeyMessage(owner) }));
      setPrepared({ keys, plan: planStealthMandate(keys.stealth) });
    } catch {
      setProblem('The signature was declined, so no address was drawn.');
    } finally {
      setBusy(false);
    }
  };

  const run = async (current: Prepared) => {
    if (!terms) return;
    setBusy(true);
    setProblem(undefined);
    const { announceArgs, commit, createArgs, ERC5564_ANNOUNCER, erc5564AnnouncerAbi, sealTerms, writeTerms } = await import('@bursar/sdk');
    const { principal, agent } = current.plan;
    const finished = new Set(done);
    let step: StealthStep | undefined;
    try {
      for (step of remainingSteps(finished)) {
        if (step === 'create') {
          if (!sealed.current) {
            const doc = writeTerms({ ...terms, ...(label ? { label } : {}) });
            sealed.current = { terms: doc, ciphertext: await sealTerms(current.keys.termsKey, principal.address, doc), salt: randomSalt() };
          }
          const { terms: doc, ciphertext, salt } = sealed.current;
          const receipt = await sendFromStealth(principal.privateKey, {
            address: factory,
            abi: committedMandateFactoryAbi,
            functionName: 'create',
            args: createArgs({ principal: principal.address, agent: agent.address, salt, commitment: commit(doc), sealedTerms: ciphertext }),
          });
          const [event] = parseEventLogs({ abi: committedMandateFactoryAbi, eventName: 'Created', logs: receipt.logs });
          if (!event) throw new Error('The factory did not report the new account.');
          setCreated({ mandate: event.args.account, hash: receipt.transactionHash, terms: doc, fromBlock: receipt.blockNumber });
        } else {
          const identity = step === 'announce-owner' ? principal : agent;
          const receipt = await sendFromStealth(principal.privateKey, {
            address: ERC5564_ANNOUNCER,
            abi: erc5564AnnouncerAbi,
            functionName: 'announce',
            args: announceArgs(identity.announcement, identity.role),
          });
          setHashes((current) => ({ ...current, [step as StealthStep]: receipt.transactionHash }));
        }
        finished.add(step);
        setDone(new Set(finished));
      }
    } catch (error) {
      const name = step ? STEALTH_STEP_LABEL[step].toLowerCase() : 'send';
      setProblem(`Could not ${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}. Try again to pick up from this step.`);
    } finally {
      setBusy(false);
    }
  };

  if (!prepared) {
    return (
      <div className="space-y-3">
        <p className="text-detail text-[color:var(--color-muted)]">
          Your wallet signs one fixed message. The owner and agent addresses are drawn from the keys derived from it, in this
          page. Signing costs nothing and moves nothing.
        </p>
        <Button tone="primary" onClick={() => void prepare()} disabled={busy || terms === undefined}>
          {busy ? 'Waiting for the signature' : 'Draw the private addresses'}
        </Button>
        {problem && <Problem text={problem} />}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <FieldGrid columns={2}>
        <Field label="Owner address" hint="Controls the mandate. Sends the next three transactions itself.">
          <AddressView value={prepared.plan.principal.address} full />
        </Field>
        <Field label="Agent address" hint="Signs your agent’s payments. You download its key once the mandate exists.">
          <AddressView value={prepared.plan.agent.address} full />
        </Field>
      </FieldGrid>
      <GasFor address={prepared.plan.principal.address} need={createGasWei} purpose="announce both addresses and create the mandate">
        {(ready) => (
          <div className="space-y-3">
            <ol className="space-y-1 text-detail">
              {(['announce-owner', 'announce-agent', 'create'] as const).map((step) => (
                <li key={step} className="flex flex-wrap gap-2">
                  <span>{done.has(step) ? 'Done' : 'To do'}</span>
                  <span>{STEALTH_STEP_LABEL[step]}</span>
                  {hashes[step] && <TxHash hash={hashes[step] as Hex} />}
                </li>
              ))}
            </ol>
            <Button tone="primary" onClick={() => void run(prepared)} disabled={busy || !ready || terms === undefined}>
              {busy ? 'Sending from the owner address' : done.size > 0 ? 'Continue' : 'Create the private mandate'}
            </Button>
            {problem && <Problem text={problem} />}
          </div>
        )}
      </GasFor>
      <PublishMetaAddress owner={owner} metaAddress={prepared.keys.stealth.metaAddress} />
    </div>
  );
}

/**
 * The gas an address holds against what it needs, polled until it is enough. The top-up can come
 * from anywhere; the connected wallet is offered because it is the quickest, and the line above
 * says what that costs in privacy.
 */
function GasFor({
  address,
  need,
  purpose,
  children,
}: {
  readonly address: Address;
  readonly need: (gasPrice: bigint) => bigint;
  readonly purpose: string;
  readonly children: (ready: boolean) => ReactNode;
}) {
  const { sendTransactionAsync } = useSendTransaction();
  const reading = useQuery({
    queryKey: ['stealth', 'gas', address],
    queryFn: async () => {
      const client = rhcClient();
      const [balance, gasPrice] = await Promise.all([client.getBalance({ address }), client.getGasPrice()]);
      return { balance, required: need(gasPrice) };
    },
    refetchInterval: POLL_MS,
  });
  const balance = reading.data?.balance ?? 0n;
  const required = reading.data?.required ?? 0n;
  const ready = reading.data !== undefined && balance >= required;

  return (
    <div className="space-y-4">
      <Field label="Gas on the owner address" hint={`Needs about ${formatEth(required)} to ${purpose}.`}>
        <span className="tabular">{reading.data ? formatEth(balance) : 'Reading'}</span>
      </Field>
      {!ready && reading.data && (
        <div className="space-y-2">
          <p className="text-detail text-[color:var(--color-muted)]">
            Send {formatEth(required - balance)} or more to the owner address. Sending it from the connected wallet is quickest
            and links the two on chain. Sending it from your shielded funds leaves no such link: the relayer pays the gas along
            with a small USDG withdrawal.
          </p>
          {shieldedContracts() && (
            <Link href={shieldedHref('stealth-owner', address)} target="_blank" className="text-sm underline underline-offset-2">
              Send it from your shielded funds
            </Link>
          )}
          <TxButton
            label={`Send ${formatEth(required - balance)} from this wallet`}
            tone="secondary"
            send={() => sendTransactionAsync({ to: address, value: required - balance, chainId: CHAIN_ID })}
            onConfirmed={() => void reading.refetch()}
          />
        </div>
      )}
      {children(ready)}
    </div>
  );
}

/** Publishing the meta-address lets others set up private mandates for this wallet. Optional. */
function PublishMetaAddress({ owner, metaAddress }: { readonly owner: Address; readonly metaAddress: Hex }) {
  const { writeContractAsync } = useWriteContract();
  const published = useQuery({
    queryKey: ['stealth', 'meta', owner],
    queryFn: async () => {
      const { ERC6538_REGISTRY, erc6538Abi } = await import('@bursar/sdk');
      return rhcClient().readContract({ address: ERC6538_REGISTRY, abi: erc6538Abi, functionName: 'stealthMetaAddressOf', args: [owner, 1n] });
    },
  });
  const current = published.data?.toLowerCase() === metaAddress.toLowerCase();

  return (
    <div className="space-y-2 border-t border-[color:var(--color-line)] pt-4">
      <p className="text-sm font-medium">Stealth meta-address</p>
      <p className="text-detail text-[color:var(--color-muted)]">
        Optional. Publishing it lets a service or a colleague set up private mandates for you without asking. It shows that this
        wallet uses stealth addresses and never which ones.
      </p>
      {current ? (
        <p className="text-detail">Published for this wallet.</p>
      ) : (
        <TxButton
          label="Publish the meta-address"
          tone="secondary"
          send={async () => {
            const { ERC6538_REGISTRY, erc6538Abi, registerKeysArgs } = await import('@bursar/sdk');
            return writeContractAsync({ address: ERC6538_REGISTRY, abi: erc6538Abi, functionName: 'registerKeys', args: registerKeysArgs(metaAddress) });
          }}
          onConfirmed={() => void published.refetch()}
        />
      )}
    </div>
  );
}

function StealthCreated({ created, prepared }: { readonly created: Created; readonly prepared: Prepared }) {
  const { principal, agent } = prepared.plan;
  const [sent, setSent] = useState<Hex | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const download = async () =>
    downloadFile(await agentKeyFile({ mandate: created.mandate, privateKey: agent.privateKey, terms: created.terms, fromBlock: created.fromBlock }));

  const fundAgent = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const client = rhcClient();
      const [balance, gasPrice] = await Promise.all([client.getBalance({ address: principal.address }), client.getGasPrice()]);
      const value = spareForAgent(balance, gasPrice, agentGasWei(gasPrice));
      if (value === 0n) throw new Error('The owner address has no gas to spare. Top it up first.');
      setSent((await sendEthFromStealth(principal.privateKey, agent.address, value)).transactionHash);
    } catch (error) {
      setProblem(error instanceof Error ? error.message.split('\n')[0] : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="The private mandate exists" description="Fund it with USDG, give the agent some gas, and hand it its key.">
      <Card>
        <div className="space-y-4">
          <FieldGrid columns={2}>
            <Field label="Mandate address" hint="Send USDG here to fund it, from your shielded funds to keep it unlinked.">
              <AddressView value={created.mandate} full />
            </Field>
            <Field label="Created in">
              <TxHash hash={created.hash} />
            </Field>
            <Field label="Owner address">
              <AddressView value={principal.address} />
            </Field>
            <Field label="Agent address">
              <AddressView value={agent.address} />
            </Field>
          </FieldGrid>
          <p className="text-detail text-[color:var(--color-muted)]">{STEALTH_LIMIT_LINE}</p>
          {shieldedContracts() && <p className="text-detail text-[color:var(--color-muted)]">{SHIELDED_TIMING_LINE}</p>}
          <p className="text-detail">
            The agent key file holds the agent’s private key and the readable terms. Give it to your agent runtime and to nobody
            else. You can download it again from your private mandates at any time.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button tone="primary" onClick={() => void download()}>
              Download the agent key
            </Button>
            <Button onClick={() => void fundAgent()} disabled={busy || sent !== undefined}>
              {sent ? 'Gas sent to the agent' : busy ? 'Sending' : 'Send the agent gas from the owner address'}
            </Button>
            {shieldedContracts() && (
              <Link href={shieldedHref('mandate', created.mandate)} className="self-center text-sm underline underline-offset-2">
                Fund it from your shielded funds
              </Link>
            )}
            <Link href="/console/private" className="self-center text-sm underline underline-offset-2">
              Your private mandates
            </Link>
            <Link href={`/console/${created.mandate}`} className="self-center text-sm underline underline-offset-2">
              Open the mandate
            </Link>
          </div>
          {sent && <TxHash hash={sent} />}
          {problem && <Problem text={problem} />}
        </div>
      </Card>
    </Section>
  );
}

function Problem({ text }: { readonly text: string }) {
  return (
    <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
      {text}
    </p>
  );
}
