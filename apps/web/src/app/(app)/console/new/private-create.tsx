'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { parseEventLogs } from 'viem';
import type { Address, Hex, TransactionReceipt } from 'viem';
import { useSignMessage } from 'wagmi';
import { committedMandateFactoryAbi } from '@bursar/core';
import type { TermsDocument } from '@bursar/sdk';

import { randomSalt } from '@/chain/mandates';
import { EMPTY_PRIVATE_FORM, PERIODS, TERMS_FILE_TYPE, privateContracts, readPrivateForm, termsFileName } from '@/chain/private';
import type { PrivateForm } from '@/chain/private';
import { shortAddress } from '@/chain/rhc';
import { Address as AddressView, TxHash } from '@/components/address';
import { AddressInput, readAddress } from '@/components/address-input';
import { AmountInput } from '@/components/amount-input';
import { Button } from '@/components/button';
import { Card, EmptyState, Field, FieldGrid, Section } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { useWriteContract } from '@/wallet/write';
import { useWorkspace } from '@/workspace/context';
import { newDraft, upsert } from '@/workspace/model';
import { ChipList } from '../chip-list';
import { StealthCreate, StealthToggle } from './stealth-create';

export const PRIVATE_LIMIT_LINE =
  'The amount and the provider of each payment are visible on chain. The terms are not: the chain holds a commitment to them, and only your viewing key opens the readable copy. A private mandate can have a total budget of at most $25.00 for now.';

type Created = { readonly address: Address; readonly hash: Hex; readonly terms: TermsDocument; readonly saved: boolean };

/**
 * Creating a private mandate.
 *
 * The owner writes the terms here. At submit the wallet signs one fixed message, the viewing key is
 * derived from that signature in this page, and the terms are sealed to it before anything leaves
 * the browser. The factory receives a commitment, a starting counter and the sealed copy, and no
 * cap, class or provider in the clear.
 */
export function PrivateCreate({ owner }: { readonly owner: Address }) {
  const contracts = privateContracts();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const workspace = useWorkspace();

  const [form, setForm] = useState<PrivateForm>(EMPTY_PRIVATE_FORM);
  const [name, setName] = useState('');
  const [agentText, setAgentText] = useState('');
  const [providerText, setProviderText] = useState('');
  const [stealth, setStealth] = useState(false);
  // Written in the send and read on the receipt, which can land before a re-render.
  const prepared = useRef<TermsDocument | undefined>(undefined);
  const [created, setCreated] = useState<Created | undefined>(undefined);

  if (contracts === undefined) {
    return (
      <Section title="Private terms" description="Terms held behind a commitment, readable only with your viewing key.">
        <EmptyState title="Private mandates are not available on this deployment yet.">
          The contracts that check each payment against committed terms are not recorded for this network. Turn private
          terms off to create a mandate with public limits.
        </EmptyState>
      </Section>
    );
  }

  if (created) return <PrivateCreated created={created} />;

  const reading = readPrivateForm(form);
  const agent = readAddress(agentText).value;
  const ready = reading.terms !== undefined && (stealth || agent !== undefined);
  const set = (patch: Partial<PrivateForm>) => setForm({ ...form, ...patch });

  const addProvider = () => {
    const value = readAddress(providerText).value;
    if (!value || form.counterparties.some((entry) => entry.toLowerCase() === value.toLowerCase())) return;
    set({ counterparties: [...form.counterparties, value] });
    setProviderText('');
  };

  const send = async (): Promise<Hex> => {
    if (!reading.terms || !agent) throw new Error('Fill in the agent and the terms first.');
    // The commitment code carries the Poseidon constants, so it loads only when a private mandate is sent.
    const { commit, createArgs, deriveViewingKey, sealTerms, viewingKeyMessage, writeTerms } = await import('@bursar/sdk');
    const signature = await signMessageAsync({ message: viewingKeyMessage(owner) });
    const key = deriveViewingKey(signature);
    const terms = writeTerms({ ...reading.terms, ...(name.trim() ? { label: name.trim() } : {}) });
    const sealedTerms = await sealTerms(key.termsKey, owner, terms);
    prepared.current = terms;
    return writeContractAsync({
      address: contracts.CommittedMandateFactory,
      abi: committedMandateFactoryAbi,
      functionName: 'create',
      args: createArgs({ principal: owner, agent, salt: randomSalt(), commitment: commit(terms), sealedTerms }),
    });
  };

  const onConfirmed = async (receipt: TransactionReceipt) => {
    const [event] = parseEventLogs({ abi: committedMandateFactoryAbi, eventName: 'Created', logs: receipt.logs });
    const terms = prepared.current;
    if (!event || !terms) return;
    const address = event.args.account;
    let saved = false;
    if (workspace.view.status === 'unlocked') {
      const at = new Date().toISOString();
      const draft = {
        ...newDraft(),
        name: name.trim() || `Private mandate ${shortAddress(address)}`,
        agent: agentText,
        payees: form.counterparties,
        privateTerms: terms,
        activated: { address, hash: receipt.transactionHash, at },
      };
      await workspace.actions.update((current) => ({ ...current, drafts: upsert(current.drafts, draft) }));
      saved = true;
    }
    setCreated({ address, hash: receipt.transactionHash, terms, saved });
  };

  return (
    <div className="space-y-8">
      <Section title="Private terms" description={PRIVATE_LIMIT_LINE}>
        <Card title="Who spends" description="The agent proves each payment against the terms below. It needs a copy of them, which you download after creating the mandate.">
          <div className="mb-4">
            <StealthToggle on={stealth} onChange={setStealth} />
          </div>
          <FieldGrid columns={2}>
            {!stealth && (
              <AddressInput label="Agent address" value={agentText} onChange={setAgentText} hint="The address your agent signs with." />
            )}
            <Field label="Name" hint="Kept inside the sealed terms. Nobody else reads it.">
              <input
                className="w-full rounded-md border border-[color:var(--color-line)] bg-transparent px-3 py-2 text-sm"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Render budget"
              />
            </Field>
          </FieldGrid>
        </Card>
      </Section>

      <Section title="What it may spend" description="The period cap refills each period. The total budget never refills.">
        <Card>
          <FieldGrid columns={2}>
            <AmountInput asset="USDG" label="Per payment" value={form.perCall} onChange={(perCall) => set({ perCall })} />
            <AmountInput asset="USDG" label="Total budget" value={form.total} onChange={(total) => set({ total })} />
            <AmountInput asset="USDG" label="Per period" value={form.periodCap} onChange={(periodCap) => set({ periodCap })} />
            <Field label="Period" hint="How often the period cap refills.">
              <select
                className="w-full rounded-md border border-[color:var(--color-line)] bg-transparent px-3 py-2 text-sm"
                value={form.periodLen}
                onChange={(event) => set({ periodLen: Number(event.target.value) })}
              >
                {PERIODS.map((period) => (
                  <option key={period.seconds} value={period.seconds}>
                    {period.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Ends on" hint="After this date the agent cannot prove a payment.">
              <input
                type="date"
                className="w-full rounded-md border border-[color:var(--color-line)] bg-transparent px-3 py-2 text-sm"
                value={form.expiry}
                onChange={(event) => set({ expiry: event.target.value })}
              />
            </Field>
            <Field label="Allowed payments">
              <div className="flex gap-4 text-sm">
                {(['service', 'hire'] as const).map((id) => (
                  <label key={id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={form.classes[id]}
                      onChange={(event) => set({ classes: { ...form.classes, [id]: event.target.checked } })}
                    />
                    {id === 'service' ? 'Services' : 'Agent hires'}
                  </label>
                ))}
              </div>
            </Field>
          </FieldGrid>
        </Card>
      </Section>

      <Section title="Who it may pay" description="The list is sealed with the terms. Each payment proves its provider is on it without showing the rest.">
        <Card>
          <div className="space-y-3">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                addProvider();
              }}
            >
              <AddressInput
                label="Provider address"
                value={providerText}
                onChange={setProviderText}
                action={
                  <Button type="submit" disabled={readAddress(providerText).value === undefined}>
                    Add
                  </Button>
                }
              />
            </form>
            <ChipList
              items={form.counterparties.map((entry) => ({ key: entry, label: shortAddress(entry) }))}
              onRemove={(key) => set({ counterparties: form.counterparties.filter((entry) => entry !== key) })}
              empty="No provider yet. A private mandate pays only the providers on this list."
            />
          </div>
        </Card>
      </Section>

      <Section
        title="Review"
        description={
          stealth
            ? 'Your wallet signs once. The owner address then sends the announcements and the create itself, once it holds a little gas.'
            : 'Creating it asks your wallet for two things: a signature that derives your viewing key, then the transaction.'
        }
      >
        <Card>
          <div className="space-y-4">
            <p className="text-detail text-[color:var(--color-muted)]">
              The signature costs nothing and moves nothing. Sign the same message from the same wallet later and the terms
              open again on any device.
            </p>
            {workspace.view.status !== 'unlocked' && (
              <p className="text-detail text-[color:var(--color-muted)]">
                Your workspace is locked, so the terms will not be saved in it. You can still download them once the mandate
                exists.
              </p>
            )}
            {stealth ? (
              <StealthCreate owner={owner} terms={reading.terms} label={name.trim()} />
            ) : (
              <TxButton label="Create the private mandate" disabled={!ready} send={send} onConfirmed={(receipt) => void onConfirmed(receipt)} />
            )}
            {reading.problems.length > 0 && (
              <ul className="space-y-1 text-detail" style={{ color: 'var(--color-state-blocked)' }}>
                {reading.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </Section>
    </div>
  );
}

function PrivateCreated({ created }: { readonly created: Created }) {
  const download = () => {
    const blob = new Blob([JSON.stringify(created.terms, null, 2)], { type: TERMS_FILE_TYPE });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = termsFileName(created.address);
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Section title="The private mandate exists" description="Fund it with USDG and hand the terms to your agent.">
      <Card>
        <div className="space-y-4">
          <Field label="Mandate address" hint="Send USDG here to fund it.">
            <AddressView value={created.address} full />
          </Field>
          <Field label="Created in">
            <TxHash hash={created.hash} />
          </Field>
          <p className="text-detail">
            {created.saved
              ? 'The terms are saved in your workspace.'
              : 'The terms are not in your workspace. Download them now: your agent needs this file to prove each payment.'}
          </p>
          <p className="text-detail text-[color:var(--color-muted)]">
            The file is the readable terms and the secret that hides them. Give it to your agent and to nobody else.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={download}>Download the terms for your agent</Button>
            <Link href={`/console/${created.address}`} className="self-center text-sm underline underline-offset-2">
              Open the mandate
            </Link>
          </div>
        </div>
      </Card>
    </Section>
  );
}

/** The switch between public limits and private terms, at the top of the create screen. */
export function PrivateToggle({
  on,
  onChange,
  disabled = false,
}: {
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
  readonly disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2 border border-[color:var(--color-line)] bg-[color:var(--color-raised)] px-5 py-3 text-detail">
      <input type="checkbox" checked={on} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-1" />
      <span>
        <span className="font-medium">Private terms.</span>
        <span className="block text-[color:var(--color-muted)]">
          The caps, the allowed payments and the provider list stay off chain. Each payment carries a proof that it fits them.
        </span>
      </span>
    </label>
  );
}
