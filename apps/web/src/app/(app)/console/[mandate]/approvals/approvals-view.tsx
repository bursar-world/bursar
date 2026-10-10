'use client';

import { classLabel, classOfLabel, toCapabilityId } from '@bursar/core';
import type { ContractSet, Micro } from '@bursar/core';
import { SPEND_APPROVAL_TYPES, mandateDomain } from '@bursar/sdk';
import type { SpendApproval } from '@bursar/sdk';
import { useEffect, useRef, useState } from 'react';
import { domainSeparator, hashTypedData } from 'viem';
import type { Address, Hex } from 'viem';
import { useBytecode, useReadContract, useSignTypedData } from 'wagmi';

import { CHAIN_ID, shortAddress } from '@/chain/rhc';
import { mandateAccountAbi } from '@/chain/abi';
import { randomSalt } from '@/chain/mandates';
import { Address as AddressView, CopyControl, TxHash } from '@/components/address';
import { Badge, LevelDot } from '@/components/badge';
import { Button } from '@/components/button';
import { AmountInput } from '@/components/amount-input';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { ErrorSurface } from '@/components/error-surface';
import { Instant } from '@/components/instant';
import { Table } from '@/components/table';
import { TxButton, preventNavigation } from '@/components/tx-button';
import { usd } from '@/money';
import { fromUnix } from '@/lib/time';
import { AddressInput, readAddress } from '@/components/address-input';
import { readUsdgAmount } from '../../lib/amount';
import { useCapabilityLabels } from '../../lib/capability-labels';
import { describeApproval } from '../../lib/format';
import { SAFE_THRESHOLD_ABI, readSafeMessage, safeAppHome, safeMessageHash } from '../../lib/safe-signing';
import { callGates } from '../../lib/write-gates';
import type { MandateEvent } from '../../lib/activity';
import { useApprovedCapabilities } from '../../lib/use-ledger';
import { useMandateScope } from '../mandate-scope';
import { useWriteContract } from '@/wallet/write';

const LIFETIMES: readonly { readonly seconds: number; readonly label: string }[] = [
  { seconds: 3_600, label: 'One hour' },
  { seconds: 24 * 3_600, label: 'One day' },
  { seconds: 7 * 24 * 3_600, label: 'Seven days' },
  { seconds: 30 * 24 * 3_600, label: 'Thirty days' },
];

type Granted = {
  readonly approvalId: Hex;
  readonly merchant: Address;
  readonly capabilityId: Hex | undefined;
  readonly amount: Micro;
  readonly expiry: bigint;
  readonly granted: MandateEvent | undefined;
  readonly registered: boolean;
  /** The account has burned this id, either by paying with it or by the owner withdrawing it. */
  readonly spent: boolean;
  readonly withdrawn: boolean;
  readonly used: boolean;
};

/**
 * Consent for the payments the mandate will not make on its own.
 *
 * Above the threshold the contract refuses the agent outright, and nothing settles until the owner
 * has said yes to that exact payment. There are two ways to say it. A signature is produced in the
 * wallet, costs nothing, and is handed to the agent. Registering it on chain is a transaction, and
 * it is the path for a wallet that cannot sign a typed message.
 *
 * A Safe signs too: the account checks its signature through ERC-1271, and the Safe app signs
 * typed messages for a Safe opened inside it. With one owner the signature comes straight back.
 * With more, the app hands back nothing until the other owners have confirmed, so the finished
 * bundle is read from the Safe transaction service, which holds the message and every signature
 * on it. A Safe connected any other way cannot sign here, and registers on chain instead.
 *
 * Either way the consent covers one payment, names the payee and the capability, carries a ceiling
 * the price has to land under, and is burned on use.
 */
export function ApprovalsView() {
  const { address, account, ledger, system, connected, isOwner, writeContext, refresh } = useMandateScope();
  const { labelFor, remember } = useCapabilityLabels();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const granted = useApprovedCapabilities(address);

  const [merchantText, setMerchantText] = useState('');
  const [capabilityText, setCapabilityText] = useState('');
  const [amountText, setAmountText] = useState('');
  const [lifetime, setLifetime] = useState(LIFETIMES[1]!.seconds);
  const [draft, setDraft] = useState<SpendApproval | undefined>(undefined);
  const [signed, setSigned] = useState<{ readonly bundle: string; readonly signature: Hex } | undefined>(undefined);
  const [signingError, setSigningError] = useState<unknown>(null);
  const [burnText, setBurnText] = useState('');
  const [registered, setRegistered] = useState<{ readonly id: Hex; readonly bundle: string } | undefined>(undefined);
  // A Safe with more than one owner: the message the owners confirm, and how many have.
  const [collecting, setCollecting] = useState<
    { readonly approval: SpendApproval; readonly messageHash: Hex; readonly confirmations: number; readonly problem?: string } | undefined
  >(undefined);

  // An owner with code is a contract wallet, a Safe in practice, and signs differently.
  const { data: ownerCode } = useBytecode({ address: connected, query: { enabled: isOwner && connected !== undefined } });
  const contractOwner = ownerCode !== undefined && ownerCode !== '0x';
  const { data: threshold } = useReadContract({
    address: connected,
    abi: SAFE_THRESHOLD_ABI,
    functionName: 'getThreshold',
    query: { enabled: contractOwner },
  });
  const owners = threshold === undefined ? undefined : Number(threshold);

  useEffect(() => {
    if (collecting === undefined) return undefined;
    let stopped = false;
    const { approval, messageHash } = collecting;
    const poll = async () => {
      try {
        const state = await readSafeMessage(messageHash);
        if (stopped || state === undefined) return;
        if (state.signature !== undefined && owners !== undefined && state.confirmations >= owners) {
          setSigned({ signature: state.signature, bundle: bundleOf(address, approval, state.signature) });
          setCollecting(undefined);
          return;
        }
        setCollecting((current) => (current?.messageHash === messageHash ? { ...current, confirmations: state.confirmations } : current));
      } catch (caught) {
        if (stopped) return;
        const problem = caught instanceof Error ? caught.message : String(caught);
        setCollecting((current) => (current?.messageHash === messageHash ? { ...current, problem } : current));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 6_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // The message hash names the approval being collected; the count and the problem change under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collecting?.messageHash, address, owners]);

  // The id of the approval the transaction in flight carries. The form clears itself when the
  // receipt lands, so the id has to be held somewhere the clearing does not reach.
  const sent = useRef<SpendApproval | undefined>(undefined);

  if (!account) return null;

  const merchant = readAddress(merchantText).value;
  const capability = chainCapability(capabilityText, account.contractSet);
  const capabilityId = capability.id;
  const reading = readUsdgAmount(amountText, { whenEmpty: 'Set the most this payment may cost.' });
  const amount = reading.value;

  // A ceiling above the per-payment cap is consent the contract will accept and no payment can
  // ever use, since the cap is read first. It is not refused here: the owner can raise the cap
  // later and the consent then works. It is named, where the buttons are, and it is the only one
  // of these conditions that leaves them pressable.
  const overCap = amount !== undefined && amount > account.limits.perCallCap;

  // The account hashes the expiry with everything else, so the draft cannot be re-dated once it
  // has been minted. One held past its own expiry is refused by approveSpend, and the way out is
  // a fresh one rather than a transaction that reverts.
  const stale = draft !== undefined && draft.expiry * 1000n <= BigInt(Date.now());
  const ready = merchant !== undefined && capabilityId !== undefined && amount !== undefined && !stale;
  const blockedBy = callGates(system);

  // Two dead buttons and three fields is not an answer. The consent names a payee, a kind of work
  // and a ceiling, and whichever of the three is still missing is what the reader is told.
  const missing = [
    merchant === undefined ? 'a payee' : undefined,
    capabilityId === undefined ? 'the kind of work' : undefined,
    amount === undefined ? 'a ceiling' : undefined,
  ].filter((part): part is string => part !== undefined);

  // The account computes its own domain. Signing against a guessed one produces a signature that
  // recovers to nobody and reports back as a bad signature, so the two are compared first. A slot
  // that did not answer is a reading nobody took, and a comparison against nothing is not a match.
  const domain = mandateDomain(address, CHAIN_ID);
  const domainUnread = ledger.domainSeparator === undefined;
  const domainMatches =
    ledger.domainSeparator !== undefined && ledger.domainSeparator.toLowerCase() === domainSeparator({ domain }).toLowerCase();

  const rows = grantedApprovals(ledger.events, ledger.approvals, granted.byApproval);
  // The hand-off card is for an approval the agent can still use. Once it is withdrawn or spent, the
  // table says so, and a card inviting the owner to hand it over would contradict it.
  const handOff = registered && !rows.some((row) => row.approvalId === registered.id && row.spent) ? registered : undefined;
  const burnId = /^0x[0-9a-fA-F]{64}$/.test(burnText.trim()) ? (burnText.trim() as Hex) : undefined;

  // The account hashes all five fields as one thing, so all five are minted at once and kept
  // together. An id that outlived the expiry it was drawn with would let a signature handed to the
  // agent and a later registration under that same id commit two different deadlines.
  const newApproval = (): SpendApproval => {
    if (draft) return draft;
    const fresh: SpendApproval = {
      approvalId: randomSalt(),
      merchant: merchant as Address,
      capabilityId: capabilityId as Hex,
      amount: amount as Micro,
      expiry: BigInt(Math.floor(Date.now() / 1000) + lifetime),
    };
    setDraft(fresh);
    return fresh;
  };

  const fieldChanged = () => {
    setDraft(undefined);
    setSigned(undefined);
    setRegistered(undefined);
    setCollecting(undefined);
  };

  const sign = async () => {
    setSigningError(null);
    const approval = newApproval();
    try {
      const signature = await signTypedDataAsync({
        domain,
        types: SPEND_APPROVAL_TYPES,
        primaryType: 'SpendApproval',
        message: approval,
      });
      remember(capability.label ?? capabilityText.trim());
      // The Safe app answers with nothing while other owners still have to confirm.
      if (signature === '0x' && connected !== undefined) {
        const digest = hashTypedData({ domain, types: SPEND_APPROVAL_TYPES, primaryType: 'SpendApproval', message: approval });
        setCollecting({ approval, messageHash: safeMessageHash(connected, CHAIN_ID, digest), confirmations: 1 });
        return;
      }
      setSigned({ signature, bundle: bundleOf(address, approval, signature) });
    } catch (caught) {
      setSigningError(caught);
    }
  };

  const clear = () => {
    setMerchantText('');
    setCapabilityText('');
    setAmountText('');
    setDraft(undefined);
    setSigned(undefined);
    setCollecting(undefined);
    setSigningError(null);
  };

  return (
    <div className="space-y-10">
      <Section title="Approvals" description="Payments at or above the threshold need your approval.">
        <Card>
          <FieldGrid columns={3}>
            <Field label="Threshold in force" hint="Set with the limits.">
              {describeApproval(account.limits.approvalThreshold, account.limits.perCallCap, isOwner ? 'owner' : 'visitor')}
            </Field>
            <Field label="How an approval works" hint="Good for one payment.">
              The agent presents it with the payment. The payee and the kind of work have to match.
            </Field>
            <Field label="The amount" hint="A payment at or under it goes through.">
              The amount you approve is a maximum, not an exact price.
            </Field>
          </FieldGrid>
        </Card>
      </Section>

      {isOwner && (
        <Section title="Approve a payment" description="Choose the payee, the kind of work and the most it may cost.">
          <Card>
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                void sign();
              }}
            >
              <FieldGrid columns={2}>
                <AddressInput
                  label="Payee"
                  value={merchantText}
                  onChange={(text) => {
                    setMerchantText(text);
                    fieldChanged();
                  }}
                  hint="Must already be an allowed payee."
                />
                <div className="space-y-1">
                  <label htmlFor="approval-capability" className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
                    Capability
                  </label>
                  <input
                    id="approval-capability"
                    value={capabilityText}
                    placeholder="doc.summarize:1"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      setCapabilityText(event.target.value);
                      fieldChanged();
                    }}
                    className="h-11 w-full border border-[color:var(--color-line)] bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
                  />
                  <p
                    className="break-all text-note"
                    style={{ color: capability.problem ? 'var(--color-state-blocked)' : 'var(--color-muted)' }}
                  >
                    {capability.problem ??
                      (capability.label !== undefined && capability.label !== capabilityText.trim()
                        ? `Approved as ${capability.label}.`
                        : 'The kind of work being bought, as the mandate lists it.')}
                  </p>
                </div>
              </FieldGrid>

              <FieldGrid columns={2}>
                <AmountInput
                  label="At most"
                  asset="USDG"
                  value={amountText}
                  onChange={(text) => {
                    setAmountText(text);
                    fieldChanged();
                  }}
                  {...(amountText.trim() === '' || reading.problem === undefined ? {} : { problem: reading.problem })}
                  hint={`The limits still apply: up to ${usd(account.limits.perCallCap)} per payment.`}
                />
                <div className="space-y-1">
                  <label htmlFor="approval-lifetime" className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
                    Good for
                  </label>
                  <select
                    id="approval-lifetime"
                    value={String(lifetime)}
                    onChange={(event) => {
                      setLifetime(Number(event.target.value));
                      fieldChanged();
                    }}
                    className="h-11 w-full border border-[color:var(--color-line)] bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
                  >
                    {LIFETIMES.map((entry) => (
                      <option key={entry.seconds} value={entry.seconds}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-note text-[color:var(--color-muted)]">
                    After this, the approval expires.
                  </p>
                </div>
              </FieldGrid>

              {domainUnread && (
                <p className="text-detail" style={{ color: 'var(--color-state-unknown)' }}>
                  {ledger.isLoading
                    ? 'Loading the mandate’s signing details. Signing opens in a moment.'
                    : 'The mandate’s signing details could not be read, so signing is off. Register the approval on chain instead; it works the same way.'}
                </p>
              )}

              {!domainUnread && !domainMatches && (
                <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
                  This mandate’s signing details do not match this console, so signing is off. Check that the address
                  is a mandate on Robinhood Chain.
                </p>
              )}

              {overCap && (
                <p className="text-detail" style={{ color: 'var(--color-state-attention)' }}>
                  This is above the {usd(account.limits.perCallCap)} per-payment limit, so no single payment can use all
                  of it unless you raise that limit.
                </p>
              )}

              {stale && (
                <div className="space-y-2">
                  <p className="text-detail" style={{ color: 'var(--color-state-attention)' }}>
                    This approval has expired. Renew it to create a fresh one with the same details.
                  </p>
                  <Button size="sm" tone="secondary" onClick={fieldChanged}>
                    Renew it
                  </Button>
                </div>
              )}

              {missing.length > 0 && (
                <p className="text-detail text-[color:var(--color-muted)]">
                  Add {list(missing)} to continue.
                </p>
              )}

              <div className="flex flex-wrap items-start gap-6">
                <div className="space-y-2">
                  <Button type="submit" tone="primary" disabled={!ready || !domainMatches}>
                    Sign it
                  </Button>
                  <p className="max-w-xs text-note text-[color:var(--color-muted)]">
                    {contractOwner
                      ? owners !== undefined && owners > 1
                        ? `Signed by your Safe. ${owners} owners confirm in Safe before the approval is complete.`
                        : 'Signed by your Safe, from inside the Safe app. Nothing is sent; give the result to the agent.'
                      : 'Signed in your wallet. Nothing is sent; give the result to the agent.'}
                  </p>
                </div>

                <div className="space-y-2">
                  <TxButton
                    label="Register it on chain"
                    tone="secondary"
                    disabled={!ready}
                    blockedBy={blockedBy}
                    context={{
                      ...writeContext,
                      ...(merchant === undefined ? {} : { merchant }),
                      ...(amount === undefined ? {} : { amount }),
                      ...(capabilityId === undefined ? {} : { capabilityId, capability: capability.label ?? capabilityText.trim() }),
                    }}
                    send={() => {
                      const approval = newApproval();
                      remember(capability.label ?? capabilityText.trim());
                      sent.current = approval;
                      return writeContractAsync({
                        address,
                        abi: mandateAccountAbi,
                        functionName: 'approveSpend',
                        args: [approval],
                      });
                    }}
                    onConfirmed={() => {
                      // The agent presents the registered approval itself, with no signature, so it
                      // is handed over the same way as a signed one.
                      if (sent.current) setRegistered({ id: sent.current.approvalId, bundle: bundleOf(address, sent.current) });
                      clear();
                      refresh();
                      // The capability is in the calldata of the grant that just landed, and
                      // without this the row it produces waits out the index's own interval
                      // before it can be named.
                      granted.refresh();
                    }}
                  />
                  <p className="max-w-xs text-note text-[color:var(--color-muted)]">
                    A transaction from your wallet. The agent then needs no signature, and contract wallets such as
                    Safe can approve this way.
                  </p>
                </div>
              </div>

              {signingError !== null && <ErrorSurface error={signingError} action="Signing the approval" />}
              {signingError !== null && contractOwner && (
                <p className="text-detail text-[color:var(--color-muted)]">
                  A Safe signs approvals from inside the Safe app. Connected any other way, register the approval on
                  chain instead; the agent then needs no signature.
                </p>
              )}

              {collecting && (
                <div className="space-y-2 rounded-md border border-[color:var(--color-line)] p-4">
                  <h3 className="text-sm font-semibold">Waiting for your Safe.</h3>
                  <p className="text-detail text-[color:var(--color-muted)]">
                    {collecting.confirmations} of {owners ?? '?'} owners have signed. The others confirm the message in{' '}
                    {connected === undefined ? (
                      'Safe'
                    ) : (
                      <a href={safeAppHome(connected)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                        Safe
                      </a>
                    )}
                    ; the finished approval appears here, ready for the agent. Registering it on chain works the same
                    way and needs no second step.
                  </p>
                  {collecting.problem !== undefined && (
                    <p className="text-detail" style={{ color: 'var(--color-state-attention)' }}>
                      The Safe transaction service could not be read: {collecting.problem} Checking again shortly.
                    </p>
                  )}
                </div>
              )}

              {handOff && (
                <div className="space-y-2 rounded-md border border-[color:var(--color-line)] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold">Registered. Give this to the agent.</h3>
                    <CopyControl value={handOff.bundle} label="Copy the approval" />
                  </div>
                  <p className="text-detail text-[color:var(--color-muted)]">
                    The mandate holds the approval, so the agent presents it without a signature. It is listed below,
                    where you can withdraw it.
                  </p>
                  <pre className="tabular whitespace-pre-wrap break-all bg-[color:var(--color-raised)] p-3 text-note">{handOff.bundle}</pre>
                </div>
              )}

              {signed && (
                <div className="space-y-2 rounded-md border border-[color:var(--color-line)] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold">Signed. Give this to the agent.</h3>
                    <CopyControl value={signed.bundle} label="Copy the approval" />
                  </div>
                  <p className="text-detail text-[color:var(--color-muted)]">
                    Nothing is sent or stored, so copy it now. Leaving this screen loses it.
                  </p>
                  <pre className="tabular whitespace-pre-wrap break-all bg-[color:var(--color-raised)] p-3 text-note">{signed.bundle}</pre>
                  <Button size="sm" tone="quiet" onClick={clear}>
                    Start another
                  </Button>
                </div>
              )}
            </form>
          </Card>
        </Section>
      )}

      <Section
        title="Registered approvals"
        description="Approvals registered by transaction, and whether each can still be used. Signed approvals are not listed here."
      >
        <Card>
          <Table
            rows={rows}
            rowKey={(row) => row.approvalId}
            caption="Approvals registered on this mandate"
            empty={
              <p className="text-detail text-[color:var(--color-muted)]">
                No approvals registered yet.
              </p>
            }
            columns={[
              {
                key: 'payee',
                header: 'Payee',
                cell: (row) => <AddressView value={row.merchant} />,
              },
              {
                key: 'id',
                header: 'Id',
                secondary: true,
                cell: (row) => (
                  <span className="inline-flex items-center gap-1">
                    <span className="tabular text-detail" title={row.approvalId}>
                      {shortAddress(row.approvalId, 10, 6)}
                    </span>
                    <CopyControl value={row.approvalId} label="Copy the approval id" />
                  </span>
                ),
              },
              {
                key: 'capability',
                header: 'For',
                secondary: true,
                cell: (row) =>
                  row.capabilityId === undefined ? (
                    <span className="text-detail text-[color:var(--color-muted)]">Set in the approval</span>
                  ) : (
                    <span className="text-detail">{labelFor(row.capabilityId) ?? shortAddress(row.capabilityId, 10, 6)}</span>
                  ),
              },
              {
                key: 'amount',
                header: 'At most',
                align: 'right',
                cell: (row) => <span className="tabular">{usd(row.amount)}</span>,
              },
              {
                key: 'state',
                header: 'Status',
                cell: (row) => <ApprovalState row={row} />,
              },
              {
                key: 'granted',
                header: 'Granted',
                secondary: true,
                cell: (row) =>
                  row.granted ? (
                    <span className="flex flex-col items-start gap-1 text-note text-[color:var(--color-muted)]">
                      <Instant at={row.granted.at} relative />
                      <TxHash hash={row.granted.transactionHash} />
                    </span>
                  ) : null,
              },
              {
                key: 'action',
                header: '',
                align: 'right',
                cell: (row) =>
                  isOwner && row.registered && !row.spent ? (
                    <TxButton
                      label="Withdraw"
                      tone="secondary"
                      blockedBy={blockedBy}
                      context={{ ...writeContext, merchant: row.merchant, amount: row.amount }}
                      send={() =>
                        writeContractAsync({
                          address,
                          abi: mandateAccountAbi,
                          functionName: 'revokeApproval',
                          args: [row.approvalId],
                        })
                      }
                      onContinue={refresh}
                    />
                  ) : null,
              },
            ]}
          />

          {isOwner && (
            <div className="mt-4 space-y-2 border-t border-[color:var(--color-line)] pt-4">
              <h3 className="text-sm font-semibold">Withdraw a signature you handed out</h3>
              <p className="text-detail text-[color:var(--color-muted)]">
                Signed approvals are not listed above. Enter the approval id to cancel one; the agent&rsquo;s copy stops
                working at once.
              </p>
              <form className="space-y-1.5" onSubmit={preventNavigation}>
                <label htmlFor="burn-approval" className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
                  Approval id
                </label>
                <div className="flex flex-wrap items-stretch gap-2">
                  <div className="min-w-0 flex-1 basis-60">
                    <input
                      id="burn-approval"
                      value={burnText}
                      placeholder="0x"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={burnText.trim() !== '' && burnId === undefined}
                      onChange={(event) => setBurnText(event.target.value)}
                      className="tabular h-11 w-full border bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
                      style={{ borderColor: burnText.trim() !== '' && burnId === undefined ? 'var(--color-state-blocked)' : 'var(--color-line)' }}
                    />
                  </div>
                  <TxButton
                    type="submit"
                    label="Withdraw"
                    tone="destructive"
                    disabled={burnId === undefined}
                    blockedBy={blockedBy}
                    context={writeContext}
                    confirmPhrase="WITHDRAW"
                    confirmTitle="Withdraw this approval"
                    confirmDescription="Any copy of the signature stops working, and the id cannot be used again."
                    send={() =>
                      writeContractAsync({
                        address,
                        abi: mandateAccountAbi,
                        functionName: 'revokeApproval',
                        args: [burnId as Hex],
                      })
                    }
                    onConfirmed={() => {
                      setBurnText('');
                      refresh();
                    }}
                  />
                </div>
                <p
                  className="tabular break-all text-note"
                  style={{ color: burnText.trim() !== '' && burnId === undefined ? 'var(--color-state-blocked)' : 'var(--color-muted)' }}
                >
                  {burnText.trim() === ''
                    ? 'The id shown when you signed the approval.'
                    : burnId === undefined
                      ? 'An approval id is 0x followed by 64 characters.'
                      : `Id: ${burnId}`}
                </p>
              </form>
            </div>
          )}
        </Card>
      </Section>
    </div>
  );
}

/** "a payee", "a payee and a ceiling", "a payee, the kind of work and a ceiling". */
function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function ApprovalState({ row }: { readonly row: Granted }) {
  if (row.used) return <Badge tone="quiet">Used</Badge>;
  if (row.withdrawn) return <Badge tone="quiet">Withdrawn</Badge>;
  if (row.spent) return <Badge tone="quiet">No longer usable</Badge>;
  if (!row.registered) return <Badge tone="quiet">Not on this mandate</Badge>;

  const expiresAt = fromUnix(row.expiry);
  if (expiresAt && expiresAt.getTime() < Date.now()) {
    return (
      <span className="inline-flex items-center gap-1.5 text-detail">
        <LevelDot level="attention" label="Expired" />
        Expired <Instant at={expiresAt} relative />
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-detail">
      <LevelDot level="ok" label="Ready" />
      Ready, expires <Instant at={expiresAt} relative />
    </span>
  );
}

/**
 * The approval as the account recorded it, with its current state read back from the mapping.
 *
 * The log says what was granted and what happened to it. The mapping says whether the id is still
 * usable. Both are needed: the account burns an id the same way whether it was paid with or
 * withdrawn, and those two are not the same news for the person reading this table.
 */
function grantedApprovals(
  events: readonly MandateEvent[],
  states: readonly { readonly approvalId: Hex; readonly registered: boolean | undefined; readonly spent: boolean | undefined }[],
  grantedFor: ReadonlyMap<string, Hex>,
): readonly Granted[] {
  const byId = new Map(states.map((state) => [state.approvalId.toLowerCase(), state]));
  const withdrawn = new Set<string>();
  const consumed = new Map<string, bigint>();

  for (const event of events) {
    if (event.kind === 'approval-revoked') withdrawn.add(event.approvalId.toLowerCase());
    if (event.kind === 'approval-consumed') consumed.set(event.approvalId.toLowerCase(), event.escrowId);
  }

  // The payment that used the consent names the capability it was spent on, which is the closest
  // thing to a receipt. An approval nobody has used yet has only the grant behind it, and that is
  // what `grantedFor` carries.
  const capabilityFor = (approvalId: string): Hex | undefined => {
    const escrowId = consumed.get(approvalId);
    if (escrowId === undefined) return grantedFor.get(approvalId);
    const spend = events.find((event) => event.kind === 'spent' && event.escrowId === escrowId);
    return spend?.kind === 'spent' ? spend.capabilityId : grantedFor.get(approvalId);
  };

  const seen = new Set<string>();
  const rows: Granted[] = [];

  for (const event of events) {
    if (event.kind !== 'approval-granted') continue;
    const key = event.approvalId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const state = byId.get(key);

    rows.push({
      approvalId: event.approvalId,
      merchant: event.merchant,
      // The event carries the payee, the ceiling and the expiry. The capability is hashed into the
      // approval, so it comes back from the payment that used it or from the grant that made it.
      capabilityId: capabilityFor(key),
      amount: event.amount,
      expiry: event.expiry,
      granted: event,
      registered: state?.registered ?? false,
      spent: state?.spent ?? false,
      withdrawn: withdrawn.has(key),
      used: consumed.has(key),
    });
  }

  return rows;
}

/**
 * The capability an approval names, under the rule a payment is made by: a bare name is a
 * service, a name already in a class stays in it, and a 32-byte id is the id it is. Hashing the
 * bare text instead named a capability no payment carries, so the approval could never be used.
 * A first-set account keeps no classes and takes the text as written.
 */
export function chainCapability(
  text: string,
  set: ContractSet,
): { readonly id: Hex | undefined; readonly label: string | undefined; readonly problem: string | undefined } {
  const written = text.trim();
  if (written === '') return { id: undefined, label: undefined, problem: undefined };
  if (/^0x[0-9a-fA-F]{64}$/u.test(written)) return { id: written as Hex, label: undefined, problem: undefined };
  if (set === 'v1') return { id: toCapabilityId(written), label: written, problem: undefined };
  try {
    const label = classOfLabel(written) === undefined ? classLabel('service', written) : written;
    return { id: toCapabilityId(label), label, problem: undefined };
  } catch (error) {
    return { id: undefined, label: undefined, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** What the agent is handed: the approval's terms, and the signature when there is one. */
function bundleOf(mandate: Address, approval: SpendApproval, signature?: Hex): string {
  return JSON.stringify(
    {
      mandate,
      chainId: CHAIN_ID,
      approval: {
        approvalId: approval.approvalId,
        merchant: approval.merchant,
        capabilityId: approval.capabilityId,
        amount: approval.amount.toString(),
        expiry: approval.expiry.toString(),
      },
      ...(signature === undefined ? {} : { signature }),
    },
    null,
    2,
  );
}
