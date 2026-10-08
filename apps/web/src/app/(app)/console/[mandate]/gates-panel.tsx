'use client';

import { toCapabilityId } from '@bursar/core';
import { useState } from 'react';
import type { Address, Hex } from 'viem';
import { MerchantGate } from '@bursar/sdk';

import { mandateAccountAbi } from '@/chain/abi';
import { shortAddress } from '@/chain/rhc';
import { SPEND_CLASSES, SPEND_CLASS_INFO, classLabel } from '@/chain/capabilities';
import type { SpendClass } from '@/chain/capabilities';
import { Address as AddressView } from '@/components/address';
import { Badge, LevelDot } from '@/components/badge';
import { Card, Field, Section } from '@/components/layout';
import { Table } from '@/components/table';
import { TxButton, preventNavigation } from '@/components/tx-button';
import { AddressInput, readAddress } from '@/components/address-input';
import { useCapabilityLabels } from '../lib/capability-labels';
import { CapabilityName } from '../lib/capability-name';
import { GateEmpty } from '../lib/gate-empty';
import { listState, refusalOf, weaker } from '../lib/reading';
import { gateDetail, gateWord } from '../lib/format';
import { alreadyAllowed } from '../lib/reads';
import type { GateEntry } from '../lib/reads';
import { callGates } from '../lib/write-gates';
import { useMandateScope } from './mandate-scope';
import { useWriteContract } from '@/wallet/write';

/**
 * Who may be paid and what may be bought.
 *
 * Both gates default to deny, so this list is the whole of what the mandate will settle. An entry
 * that was allowed and then removed stays in the record and reads as not allowed, which is a
 * different and more useful thing than disappearing.
 */
export function GatesPanel() {
  const { address, account, ledger, system, isOwner, writeContext, refresh } = useMandateScope();
  const { writeContractAsync } = useWriteContract();
  const { labelFor, remember } = useCapabilityLabels();

  const [payeeText, setPayeeText] = useState('');
  const [capabilityText, setCapabilityText] = useState('');
  const [capabilityClass, setCapabilityClass] = useState<SpendClass>('service');

  if (!account) return null;

  const merkle = account.merchantGate === MerchantGate.MerkleRoot;
  // Both lists are assembled from what the account has published about itself, so a reading that
  // did not answer produces the same empty table as a mandate that has allowed nobody. Saying
  // "this mandate pays nobody" in that case would be a permission claim built on a network fault.
  // It takes two readings to fill either table: the index supplies the candidates and the chain
  // says which of them are allowed today, so either one failing leaves the table unknown.
  const source = weaker(ledger.timeline, ledger.chain);
  // Named where the index stated its own reason, so neither table reports a 402 as an outage.
  const refused = refusalOf(source.error);
  const payees = [...ledger.merchants].sort(allowedFirst);
  const capabilities = [...ledger.capabilities].sort(allowedFirst);
  // A capability is allowed under a spend class: the label is hashed with the class namespace in
  // front, which is what the SDK's pay and hire spend under. A label naming another class is an
  // error the form shows rather than a hash it quietly writes.
  const classed = readClassLabel(capabilityClass, capabilityText);
  const typed = classed.label === undefined ? undefined : toCapabilityId(classed.label);
  // Writing a gate moves no USDG, so a paused token does not stand in its way. Connectivity does.
  const blockedBy = callGates(system);

  // A gate already in the state being asked for is a transaction that changes nothing and still
  // costs the fee, so both forms say so instead of sending it. An entry the chain has not answered
  // for is neither allowed nor not allowed, and its row offers no control at all.
  const pendingPayee = readAddress(payeeText).value;
  const payeeAlready = alreadyAllowed(ledger.merchants, pendingPayee);
  const capabilityAlready = alreadyAllowed(ledger.capabilities, typed);

  const setMerchant = (merchant: Address, allowed: boolean) =>
    writeContractAsync({ address, abi: mandateAccountAbi, functionName: 'setMerchant', args: [merchant, allowed] });

  const setCapability = (capabilityId: Hex, allowed: boolean) =>
    writeContractAsync({ address, abi: mandateAccountAbi, functionName: 'setCapability', args: [capabilityId, allowed] });

  return (
    <div className="space-y-8">
      <Section title="Who may be paid" description="Payments to anyone not on this list are refused.">
        <Card>
          <div className="space-y-4">
            <Field label="Payee list in force" hint={gateDetail(account.merchantGate)}>
              {gateWord(account.merchantGate)}
              {merkle && (
                <span className="tabular ml-2 text-note text-[color:var(--color-muted)]">{shortAddress(account.merchantRoot, 10, 8)}</span>
              )}
            </Field>

            <Table
              rows={payees}
              rowKey={(row) => row.key}
              caption="Payees on this mandate"
              empty={<GateEmpty state={listState(source, payees.length)} subject="payees" refusal={refused} onRetry={refresh} />}
              columns={[
                {
                  key: 'address',
                  header: 'Provider',
                  cell: (row) => <AddressView value={row.key} />,
                },
                {
                  key: 'state',
                  header: 'Status',
                  cell: (row) => <GateState allowed={row.allowed} />,
                },
                {
                  key: 'action',
                  header: '',
                  align: 'right',
                  cell: (row) =>
                    isOwner && !merkle && row.allowed !== undefined ? (
                      <TxButton
                        label={row.allowed ? 'Remove' : 'Allow'}
                        tone="secondary"
                        blockedBy={blockedBy}
                        context={{ ...writeContext, merchant: row.key }}
                        send={() => setMerchant(row.key, !row.allowed)}
                        onConfirmed={refresh}
                        {...(row.allowed
                          ? {
                              confirmPhrase: 'REMOVE',
                              confirmTitle: `Stop paying ${shortAddress(row.key)}`,
                              confirmDescription: 'New payments to this address are refused at once. Payments already in escrow are unaffected.',
                            }
                          : {})}
                      />
                    ) : null,
                },
              ]}
            />

            {isOwner && !merkle && (
              <form className="border-t border-[color:var(--color-line)] pt-4" onSubmit={preventNavigation}>
                <AddressInput
                  label="Allow another provider"
                  value={payeeText}
                  onChange={setPayeeText}
                  {...(payeeAlready ? { problem: 'This address is already allowed.' } : {})}
                  action={
                    <TxButton
                      type="submit"
                      label="Allow"
                      disabled={pendingPayee === undefined || payeeAlready}
                      blockedBy={blockedBy}
                      context={{ ...writeContext, ...(pendingPayee === undefined ? {} : { merchant: pendingPayee }) }}
                      send={() => setMerchant(pendingPayee as Address, true)}
                      onConfirmed={() => {
                        setPayeeText('');
                        refresh();
                      }}
                    />
                  }
                />
              </form>
            )}

            {merkle && (
              <p className="text-detail text-[color:var(--color-muted)]">
                This mandate uses a published payee list, so payees cannot be edited one by one here.
              </p>
            )}
          </div>
        </Card>
      </Section>

      <Section
        title="What may be bought"
        description="The kinds of work this mandate pays for. A name this console does not recognise shows as a code."
      >
        <Card>
          <div className="space-y-4">
            <Table
              rows={capabilities}
              rowKey={(row) => row.key}
              caption="Kinds of work on this mandate"
              empty={<GateEmpty state={listState(source, capabilities.length)} subject="capabilities" refusal={refused} onRetry={refresh} />}
              columns={[
                {
                  key: 'capability',
                  header: 'Capability',
                  cell: (row) => <CapabilityName id={row.key} />,
                },
                { key: 'state', header: 'Status', cell: (row) => <GateState allowed={row.allowed} /> },
                {
                  key: 'action',
                  header: '',
                  align: 'right',
                  cell: (row) =>
                    isOwner && row.allowed !== undefined ? (
                      <TxButton
                        label={row.allowed ? 'Remove' : 'Allow'}
                        tone="secondary"
                        blockedBy={blockedBy}
                        context={{ ...writeContext, capabilityId: row.key }}
                        send={() => setCapability(row.key, !row.allowed)}
                        onConfirmed={refresh}
                        // Removing a payee asks for the word and removing a capability did not,
                        // though both take a permission away and both refuse the same payment
                        // from the moment they land. The friction belongs on the side that stops
                        // an agent working, so the capability asks for it too.
                        {...(row.allowed
                          ? {
                              confirmPhrase: 'REMOVE',
                              confirmTitle: `Stop paying for ${labelFor(row.key) ?? shortAddress(row.key, 8, 6)}`,
                              confirmDescription: 'New payments for this kind of work are refused at once, to any payee. Payments already in escrow are unaffected.',
                            }
                          : {})}
                      />
                    ) : null,
                },
              ]}
            />

            {isOwner && (
              <form className="space-y-1.5 border-t border-[color:var(--color-line)] pt-4" onSubmit={preventNavigation}>
                <label htmlFor="allow-capability" className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
                  Allow another capability
                </label>
                <div className="flex flex-wrap items-stretch gap-2">
                  <select
                    aria-label="Spend class"
                    value={capabilityClass}
                    onChange={(event) => setCapabilityClass(event.target.value as SpendClass)}
                    className="h-11 border border-[color:var(--color-line)] bg-surface px-3 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
                  >
                    {SPEND_CLASSES.map((id) => (
                      <option key={id} value={id}>
                        {SPEND_CLASS_INFO[id].name}
                      </option>
                    ))}
                  </select>
                  <div className="min-w-0 flex-1 basis-60">
                    <input
                      id="allow-capability"
                      value={capabilityText}
                      placeholder="doc.summarize:1"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setCapabilityText(event.target.value)}
                      className="h-11 w-full border border-[color:var(--color-line)] bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
                    />
                  </div>
                  <TxButton
                    type="submit"
                    label="Allow"
                    disabled={typed === undefined || capabilityAlready}
                    blockedBy={blockedBy}
                    context={{ ...writeContext, ...(typed === undefined || classed.label === undefined ? {} : { capabilityId: typed, capability: classed.label }) }}
                    // The name is kept at submit, not at confirmation. The table under this form
                    // reads names, and a reader who leaves during the confirmation would come back to
                    // the hash of a capability they had just named.
                    send={() => {
                      remember(classed.label as string);
                      return setCapability(typed as Hex, true);
                    }}
                    onConfirmed={() => {
                      setCapabilityText('');
                      refresh();
                    }}
                  />
                </div>
                <p
                  className="tabular break-all text-note"
                  style={{ color: capabilityAlready || classed.problem ? 'var(--color-state-blocked)' : 'var(--color-muted)' }}
                >
                  {classed.problem !== undefined
                    ? classed.problem
                    : capabilityAlready
                      ? 'This kind of work is already allowed.'
                      : typed === undefined
                        ? `Saved as ${SPEND_CLASS_INFO[capabilityClass].prefix}<name>. The class is part of the name.`
                        : `Saved as ${classed.label}.`}
                </p>
              </form>
            )}
          </div>
        </Card>
      </Section>
    </div>
  );
}

/** The label a capability is allowed under in `spendClass`, or why the typed text cannot be one. */
export function readClassLabel(spendClass: SpendClass, text: string): { readonly label?: string; readonly problem?: string } {
  if (text.trim() === '') return {};
  try {
    return { label: classLabel(spendClass, text) };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

function GateState({ allowed }: { readonly allowed: boolean | undefined }) {
  if (allowed === undefined) {
    return (
      <span className="inline-flex items-center gap-1.5 text-detail text-[color:var(--color-muted)]">
        <LevelDot level="unknown" label="Unknown" />
        Unread
      </span>
    );
  }
  return allowed ? <Badge>Allowed</Badge> : <Badge tone="quiet">Not allowed</Badge>;
}

function allowedFirst<Key>(a: GateEntry<Key>, b: GateEntry<Key>): number {
  return Number(b.allowed ?? false) - Number(a.allowed ?? false);
}
