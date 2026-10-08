'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { parseEventLogs } from 'viem';
import type { Address, Hex, TransactionReceipt } from 'viem';

import { currentDeployment } from '@/chain/deployments';
import { ZERO_ADDRESS, explorerTx, shortAddress } from '@/chain/rhc';
import { mandateAccountAbi, mandateAccountFactoryAbi } from '@/chain/abi';
import { toLimitsTuple } from '@/chain/limits';
import { laneAvailable, laneParkOf, laneValue, newMandateFactory, predictMandateSlot, randomSalt } from '@/chain/mandates';
import type { FundingLane, PredictedMandate } from '@/chain/mandates';
import { Address as AddressView, TxHash } from '@/components/address';
import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { Card, EmptyState, Field, FieldGrid, Section, Skeleton } from '@/components/layout';
import { Blockers } from '@/components/status';
import { TxButton } from '@/components/tx-button';
import type { TxContext, TxPhase } from '@/components/tx-button';
import { ConnectButton } from '@/wallet/connect-button';
import { formatEth } from '@/money';
import { DEPLOY_FEE, useSystemState } from '@/state';
import type { AnyState } from '@/state';
import { AddressInput, readAddress } from '@/components/address-input';
import { useWalletAccount } from '@/wallet/account';
import { useCapabilityLabels } from '../lib/capability-labels';
import { describeApproval, describeLimits } from '../lib/format';
import { readLedgerState } from '../lib/reads';
import type { GateEntry } from '../lib/reads';
import { callGates } from '../lib/write-gates';
import { EMPTY_DRAFT, LimitsFields, readDraft } from '../limits-form';
import type { LimitsDraft } from '../limits-form';
import { ChipList } from '../chip-list';
import { SpendClassFields, chainLabel, classCapabilities } from '../spend-class-fields';
import type { ClassSelection, ClassedCapability } from '../spend-class-fields';
import { useWriteContract } from '@/wallet/write';
import { SPEND_CLASSES, classMaskOf, toCapabilityId } from '@bursar/core';
import { useWorkspace } from '@/workspace/context';
import { draftTitle } from '@/workspace/model';
import type { MandateDraft } from '@/workspace/model';
import { UnlockForm } from '../../workspace/passphrase';
import { PrivateCreate, PrivateToggle } from './private-create';
import { LANE_FOLLOW_UPS, LANE_NAME, LaneFields } from './lane-fields';
import { LaneGates } from './lane-gates';

type Created = { readonly address: Address; readonly hash: Hex };
type Capability = { readonly label: string; readonly id: Hex };
type CreateArgs = readonly [Address, Address, Hex, ReturnType<typeof toLimitsTuple>];

/** What was handed to the wallet, and where it said the account would land. */
type Submitted = { readonly args: CreateArgs; readonly slot: PredictedMandate; readonly factory: Address; readonly lane: FundingLane };

/**
 * Whether a create is in the air, or already landed.
 *
 * The form is the transaction's input. Editing it while the wallet is open or the receipt is due
 * would change the predicted address, drop the button that is waiting on the receipt, and put a
 * fresh "Create the mandate" in front of someone whose first one is about to confirm: two
 * deployments and two fees for one intent.
 */
export function holdsCreateForm(phase: TxPhase, created: boolean): boolean {
  return created || phase === 'signing' || phase === 'pending' || phase === 'confirmed';
}

/** Long enough that typing an amount is one read, short enough that the address feels immediate. */
const TYPING_PAUSE_MS = 300;

/** How often the gates are read back while this screen is open. One batched request each time. */
const GATE_REFETCH_MS = 15_000;

/**
 * Creating a mandate.
 *
 * The account's address is fixed by the owner, the agent, the salt and the limits together, so it
 * can be read before anything is deployed and funded before the agent exists. That is what the
 * factory is for, and this screen shows it working: change any field and the address changes with it.
 *
 * Payees and capabilities are written after the account exists, because the constructor takes the
 * limits alone. Nothing is unsafe in between: a mandate refuses every payee and every capability it
 * has not been told to allow, so a setup abandoned halfway spends nothing.
 */
const CREATE_DESCRIPTION = 'One account for one agent. Its limits are set when it is created, so it never holds funds without them.';

export function CreateMandateView({ draftId, lane: askedLane }: { readonly draftId?: string; readonly lane?: FundingLane } = {}) {
  const { address: owner, isConnected } = useWalletAccount();
  const { writeContractAsync } = useWriteContract();
  const { remember } = useCapabilityLabels();
  const workspace = useWorkspace();

  const [draft, setDraft] = useState<LimitsDraft>(EMPTY_DRAFT);
  const [agentText, setAgentText] = useState('');
  const [seatLater, setSeatLater] = useState(false);
  const [payeeText, setPayeeText] = useState('');
  const [payees, setPayees] = useState<readonly Address[]>([]);
  const [classes, setClasses] = useState<ClassSelection>({ service: true, hire: false, rwa: false });
  const [classed, setClassed] = useState<readonly ClassedCapability[]>([]);
  const [lane, setLane] = useState<FundingLane>(askedLane !== undefined && laneAvailable(askedLane) ? askedLane : 'prefund');
  const [salt, setSalt] = useState<Hex | undefined>(undefined);
  const [created, setCreated] = useState<Created | undefined>(undefined);
  const [phase, setPhase] = useState<TxPhase>('idle');
  const [submitted, setSubmitted] = useState<Submitted | undefined>(undefined);
  const frozen = holdsCreateForm(phase, created !== undefined);

  // The capabilities the class toggles write: each one allowed under its class namespace, which is
  // the id the SDK's pay and hire spend under.
  const capabilities: readonly Capability[] = classCapabilities(classes, classed).map((entry) => ({
    label: chainLabel(entry),
    id: toCapabilityId(chainLabel(entry)),
  }));

  // A draft from the workspace fills the form once, the first time it can be read. Everything after
  // that is this screen's own state, so an edit here never writes back into the draft.
  const source: MandateDraft | undefined =
    draftId !== undefined && workspace.view.status === 'unlocked'
      ? workspace.view.workspace.drafts.find((entry) => entry.id === draftId)
      : undefined;
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || source === undefined) return;
    seeded.current = true;
    setDraft(source.limits);
    setAgentText(source.agent);
    setPayees(source.payees.map((entry) => readAddress(entry).value).filter((entry): entry is Address => entry !== undefined));
    setClasses(source.classes);
    setClassed(source.capabilities);
    if (source.lane !== undefined && laneAvailable(source.lane)) setLane(source.lane);
  }, [source]);

  // The receipt and the reader are two different events. The account exists the moment the receipt
  // lands, and this screen stays on it until the reader presses on, because a form that swaps
  // itself out on the receipt never paints the confirmation for the deployment just paid for.
  const [opened, setOpened] = useState(false);
  const [privateMode, setPrivateMode] = useState(false);
  // Once a private mandate exists the toggle above it has nothing left to switch.
  const [privateCreated, setPrivateCreated] = useState(false);

  // Stopped the moment the account exists. The screen below this point is `OpenTheGates`, which
  // reads the same five states scoped to the new address; leaving this one running would poll the
  // chain every twelve seconds for a reading nothing on screen is showing.
  const system = useSystemState({ enabled: created === undefined });

  // The salt is random, so it is drawn in the browser. Drawing it during render would give the
  // server one value and the reader another, and the address on screen would change on hydration.
  useEffect(() => setSalt(randomSalt()), []);

  // The classes go into the account itself as a bit mask, which the contract checks on every spend.
  const classMask = classMaskOf(SPEND_CLASSES.filter((id) => classes[id]));
  const reading = readDraft(draft, Date.now(), { contractSet: currentDeployment().contractSet, classMask, lane: laneValue(lane) });
  const factory = newMandateFactory();
  const followUps = LANE_FOLLOW_UPS[lane];
  const agentReading = readAddress(agentText);
  const agent: Address | undefined = seatLater ? ZERO_ADDRESS : agentReading.value;
  const ready = owner !== undefined && agent !== undefined && reading.limits !== undefined && salt !== undefined;

  // Every keystroke in the limits is a different set of inputs and so a different address, and
  // asking the factory about each one sends seven calls to spell out a daily cap. The address is
  // read once the typing stops.
  const inputs = `${factory}|${owner ?? ''}|${agent ?? ''}|${salt ?? ''}|${JSON.stringify(reading.limits, replacer)}`;
  const settled = useSettled(inputs, TYPING_PAUSE_MS) === inputs;

  const predicted = useQuery({
    queryKey: ['console', 'predict', inputs],
    queryFn: () =>
      predictMandateSlot({
        principal: owner as Address,
        agent: agent as Address,
        salt: salt as Hex,
        limits: reading.limits!,
        factory,
      }),
    enabled: ready && settled,
    // The factory computes the address from the inputs, so the same inputs always give the same
    // answer. Whether something stands there can change, which is why this is not held forever.
    staleTime: 30_000,
  });

  // While a create is out, the screen shows the address that was sent, not whatever the form
  // would predict now. The wallet account can change under it even with every field locked.
  const slot = frozen && submitted !== undefined ? submitted.slot : predicted.data;
  // The factory refuses a salt whose address already holds code, and that refusal is the only way
  // a create can fail on what this form collects. Drawing another address is the fix, and it is
  // one press away.
  const taken = slot?.deployed === true;
  const canCreate = ready && slot !== undefined && !taken;
  // The one blocker that does stop the deploy: the owner's own wallet pays its fee in ETH.
  const feeBalance = system.funding.facts.gasBalance;
  const shortOfFee = feeBalance !== undefined && feeBalance < DEPLOY_FEE;

  const submit = () => {
    if (slot === undefined || !ready) return Promise.reject(new Error('The mandate address has not been read yet.'));
    // The factory takes a create only from the principal it names, which is the connected wallet.
    const sent: Submitted = { slot, factory, lane, args: [owner, agent, salt, toLimitsTuple(reading.limits!)] };
    setSubmitted(sent);
    // Kept now so the gate rows after the deploy read names, not hashes.
    for (const capability of capabilities) remember(capability.label);
    return writeContractAsync({
      address: sent.factory,
      abi: mandateAccountFactoryAbi,
      functionName: 'create',
      args: sent.args,
    });
  };

  const addPayee = () => {
    const value = readAddress(payeeText).value;
    if (!value || payees.some((entry) => entry.toLowerCase() === value.toLowerCase())) return;
    setPayees([...payees, value]);
    setPayeeText('');
  };


  // A create already out keeps its screen even if the wallet drops, so the receipt it is waiting
  // on still lands somewhere the reader can see it.
  const shownOwner = owner ?? submitted?.args[0];
  if (shownOwner === undefined || (!isConnected && !frozen)) {
    return (
      <Section
        title={askedLane !== undefined && laneAvailable(askedLane) ? `Create a mandate · ${LANE_NAME[askedLane]} lane` : 'Create a mandate'}
        description="A mandate is owned by the wallet that creates it."
      >
        <EmptyState title="Connect the wallet that will own this mandate." action={<ConnectButton />}>
          The owner sets the limits and can take the funds back at any time.
          {askedLane !== undefined && laneAvailable(askedLane) && ` The ${LANE_NAME[askedLane]} funding lane is selected for you.`}
        </EmptyState>
      </Section>
    );
  }

  if (draftId !== undefined && (workspace.view.status === 'locked' || workspace.view.status === 'loading')) {
    return (
      <Section title="Create a mandate" description="Opened from a draft in your workspace.">
        {workspace.view.status === 'locked' ? (
          <UnlockForm title="Unlock your workspace to load the draft" description="Enter your passphrase and the form fills in from the draft." />
        ) : (
          <Skeleton width="16rem" height={20} />
        )}
      </Section>
    );
  }

  if (privateMode && owner !== undefined) {
    return (
      <div className="space-y-8">
        {!privateCreated && (
          <Section title="Create a mandate" description={CREATE_DESCRIPTION}>
            <PrivateToggle on onChange={setPrivateMode} />
          </Section>
        )}
        <PrivateCreate owner={owner} onCreated={() => setPrivateCreated(true)} />
      </div>
    );
  }

  if (created && opened) {
    return (
      <OpenTheGates created={created} payees={payees} capabilities={capabilities} lane={submitted?.lane ?? lane} />
    );
  }

  return (
    <div className="space-y-8">
      <fieldset disabled={frozen} className="min-w-0 space-y-8">
        <Section title="Create a mandate" description={CREATE_DESCRIPTION}>
          {created === undefined && <PrivateToggle on={false} onChange={setPrivateMode} disabled={frozen} />}
          <Card title="Who spends" description="Your agent signs with this address. It can only pay through the escrow.">
            <div className="space-y-3">
              <FieldGrid columns={2}>
                <AddressInput
                  label="Agent address"
                  value={agentText}
                  disabled={seatLater}
                  onChange={setAgentText}
                  hint="The agent spends inside the limits below and can do nothing else."
                />
                <Field label="Owner" hint="The connected wallet. It owns the mandate and can pause or revoke it.">
                  <AddressView value={shownOwner} />
                </Field>
              </FieldGrid>
              <label className="flex items-start gap-2 text-detail">
                <input type="checkbox" checked={seatLater} onChange={(event) => setSeatLater(event.target.checked)} className="mt-1" />
                <span>
                  <span className="font-medium">Seat the agent later.</span>
                  <span className="block text-[color:var(--color-muted)]">
                    It spends nothing until you seat one. The address below stays the same.
                  </span>
                </span>
              </label>
            </div>
          </Card>
          <Card
            title="How it is funded"
            description="Choose now. It cannot be changed once the mandate is created."
          >
            <LaneFields lane={lane} onChange={setLane} disabled={frozen} />
          </Card>
        </Section>

        {draftId !== undefined && (
          <p className="border border-[color:var(--color-line)] bg-[color:var(--color-raised)] px-5 py-3 text-detail">
            {source === undefined ? (
              <>That draft is not in this browser's workspace, so the form starts empty.</>
            ) : (
              <>
                Filled in from your draft <span className="font-medium">{draftTitle(source)}</span>. Edits here do not
                change the draft.
              </>
            )}
          </p>
        )}

        <Section title="What it may spend" description="The period cap refills each period. The total budget never refills.">
          <Card>
            <LimitsFields draft={draft} onChange={setDraft} problems={reading.problems} />
          </Card>
        </Section>

        <Section title="Who it may pay" description="Only the providers you list can be paid.">
          <Card>
            <div className="space-y-3">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  addPayee();
                }}
              >
                <AddressInput
                  label="Provider address"
                  value={payeeText}
                  onChange={setPayeeText}
                  action={
                    <Button type="submit" disabled={readAddress(payeeText).value === undefined}>
                      Add
                    </Button>
                  }
                />
              </form>
              <ChipList
                items={payees.map((payee) => ({ key: payee, label: shortAddress(payee) }))}
                onRemove={(key) => setPayees(payees.filter((entry) => entry !== key))}
                empty="No payees yet. Each one you add is allowed right after the mandate is created."
              />
            </div>
          </Card>
        </Section>

        <Section
          title="What it may buy"
          description="Choose the kinds of work this mandate can pay for."
        >
          <Card>
            <SpendClassFields
              classes={classes}
              capabilities={classed}
              onChange={(nextClasses, nextCapabilities) => {
                setClasses(nextClasses);
                setClassed(nextCapabilities);
              }}
            />
          </Card>
        </Section>
      </fieldset>

      <Section title="Review" description="The address follows from what you entered. Change a field and the address changes.">
        <Card>
          <div className="space-y-4">
            <FieldGrid columns={2}>
              <Field
                label="Mandate address"
                hint={
                  created
                    ? 'The mandate is live at this address. Send USDG to fund it.'
                    : 'You can fund it now. Nothing can spend from it until it is created.'
                }
              >
                {!ready ? (
                  <span className="text-[color:var(--color-muted)]">Fill in the agent and the limits.</span>
                ) : !settled || predicted.isLoading ? (
                  <Skeleton width="12rem" />
                ) : slot ? (
                  <>
                    <AddressView value={created?.address ?? slot.address} full />
                    {/* After the deploy the code at this address is this account's own, so the
                        warning is only true of an address that was taken before it was asked for. */}
                    {taken && created === undefined && (
                      <span className="block text-note" style={{ color: 'var(--color-state-blocked)' }}>
                        This address is already in use. Pick a different one below.
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-[color:var(--color-muted)]">Could not read the address.</span>
                )}
              </Field>
              <Field label="Limits">
                {reading.limits ? describeLimits(reading.limits) : 'Set the limits above'}
              </Field>
              <Field label="Approvals">
                {reading.limits ? describeApproval(reading.limits.approvalThreshold, reading.limits.perCallCap) : 'Set the limits above'}
              </Field>
              <Field label="Funding" hint="Cannot be changed later.">
                {LANE_NAME[lane]}
              </Field>
              <Field
                label="After it is created"
                hint={
                  payees.length + capabilities.length + followUps.length > 0
                    ? 'One transaction each.'
                    : 'It pays nobody until a payee and a capability are allowed.'
                }
              >
                {afterCreation(payees.length, capabilities.length, followUps)}
              </Field>
              <Field label="Creating it costs" hint="The network fee, paid from your wallet.">
                <span className="tabular">{formatEth(DEPLOY_FEE)}</span>
              </Field>
            </FieldGrid>

            {created === undefined && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  tone="quiet"
                  onClick={() => setSalt(randomSalt())}
                  disabled={!ready || frozen}
                >
                  Use a different address
                </Button>
                {predicted.error !== null && predicted.error !== undefined && (
                  <span className="text-detail text-[color:var(--color-muted)]">The address could not be read.</span>
                )}
              </div>
            )}

            {shortOfFee && (
              <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
                Your wallet holds {formatEth(feeBalance)}, and creating the mandate costs about {formatEth(DEPLOY_FEE)} in
                network fees. Add ETH to this wallet first.
              </p>
            )}

            {!shortOfFee && system.blockers.length > 0 && (
              <div className="space-y-1 rounded-md border border-[color:var(--color-line)] p-3">
                <p className="text-detail font-medium">None of these stops the mandate being created.</p>
                <p className="text-detail text-[color:var(--color-muted)]">They would stop its payments later.</p>
                <Blockers system={system} />
              </div>
            )}

            {slot === undefined ? (
              <p className="text-detail text-[color:var(--color-muted)]">
                {ready
                  ? "Reading the mandate's address."
                  : 'Fill in the agent and the limits above to see the address.'}
              </p>
            ) : (
              <TxButton
                label="Create the mandate"
                disabled={!frozen && (!canCreate || shortOfFee)}
                // Deploying an account moves no USDG, so the token's own state does not stand in
                // the way of creating one. Connectivity does: an endpoint that does not answer
                // takes no transaction at all.
                blockedBy={callGates(system)}
                context={{ mandate: slot.address, funding: system.funding.facts }}
                send={submit}
                onPhaseChange={setPhase}
                onConfirmed={(receipt) => {
                  const address = addressFrom(receipt, slot.address);
                  setCreated({ address, hash: receipt.transactionHash });
                  if (source !== undefined && workspace.view.status === 'unlocked') {
                    const activated = { address, hash: receipt.transactionHash, at: new Date().toISOString() };
                    void workspace.actions.update((current) => ({
                      ...current,
                      drafts: current.drafts.map((entry) => (entry.id === source.id ? { ...entry, activated } : entry)),
                    }));
                  }
                }}
                continueLabel="Open the gates"
                onContinue={() => setOpened(true)}
              />
            )}

            {reading.problems.length > 0 && (
              <ul className="space-y-1 text-detail" style={{ color: 'var(--color-state-blocked)' }}>
                {reading.problems.map((problem) => (
                  <li key={`${problem.field}:${problem.problem}`}>{problem.problem}</li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </Section>
    </div>
  );
}

/**
 * The second half of creating a mandate.
 *
 * The account exists and pays nobody. Each payee and each capability is one transaction, all of
 * them listed here so the count is visible up front and nobody meets them one at a time.
 *
 * What each row says is read back off the account, not remembered from the transaction that
 * confirmed. A receipt says a call was mined; the mapping says what the mandate will settle, and
 * that is the only one of the two worth putting on a screen next to the word "Allowed".
 */
function OpenTheGates({
  created,
  payees,
  capabilities,
  lane,
}: {
  readonly created: Created;
  readonly payees: readonly Address[];
  readonly capabilities: readonly Capability[];
  readonly lane: FundingLane;
}) {
  const { writeContractAsync } = useWriteContract();
  const system = useSystemState({ mandate: created.address });
  const ids = capabilities.map((capability) => capability.id);

  const gates = useQuery({
    queryKey: ['console', 'new-gates', created.address, payees.join(','), ids.join(',')],
    queryFn: () =>
      readLedgerState({ mandate: created.address, lockIds: [], merchants: payees, capabilities: ids, approvals: [] }),
    refetchInterval: GATE_REFETCH_MS,
  });

  const allowed = (entries: readonly GateEntry<string>[] | undefined, key: string): boolean | undefined =>
    entries?.find((entry) => entry.key.toLowerCase() === key.toLowerCase())?.allowed;

  const open = [
    ...payees.map((payee) => allowed(gates.data?.merchants, payee)),
    ...ids.map((id) => allowed(gates.data?.capabilities, id)),
  ];
  const remaining = open.filter((state) => state !== true).length;
  const unread = gates.data === undefined;
  const blockedBy = callGates(system);
  const refresh = () => {
    void gates.refetch();
  };

  return (
    <div className="space-y-8">
      <Section title="Mandate created" description="It holds nothing and pays nobody yet.">
        <Card>
          <div className="space-y-4">
            <Field label="Mandate address" hint="Send USDG here to fund it. The owner can take it back at any time.">
              <AddressView value={created.address} full />
            </Field>
            <Field label="Created in" hint="On the block explorer.">
              <TxHash hash={created.hash} />
            </Field>
          </div>
        </Card>
      </Section>

      <Section
        title="Open the gates"
        description={
          unread
            ? 'Checking what the mandate already allows.'
            : remaining === 0
              ? 'Everything you listed is allowed.'
              : `${remaining} step${remaining === 1 ? '' : 's'} left. The mandate refuses each payee or capability until its step is sent.`
        }
      >
        <Card>
          <div className="space-y-4">
            {payees.length === 0 && capabilities.length === 0 && lane === 'prefund' && (
              <p className="text-detail text-[color:var(--color-muted)]">
                You listed no payees or capabilities. Allow them from the mandate's page before it can pay.
              </p>
            )}

            {payees.map((payee) => (
              <GateRow
                key={payee}
                title={`Allow ${shortAddress(payee)}`}
                detail="Lets this mandate pay this provider."
                allowed={allowed(gates.data?.merchants, payee)}
                send={() =>
                  writeContractAsync({
                    address: created.address,
                    abi: mandateAccountAbi,
                    functionName: 'setMerchant',
                    args: [payee, true],
                  })
                }
                onDone={refresh}
                blockedBy={blockedBy}
                context={{ mandate: created.address, funding: system.funding.facts, merchant: payee }}
              />
            ))}

            {capabilities.map((capability) => (
              <GateRow
                key={capability.id}
                title={`Allow ${capability.label}`}
                detail="Lets this mandate pay for this kind of work."
                allowed={allowed(gates.data?.capabilities, capability.id)}
                send={() =>
                  writeContractAsync({
                    address: created.address,
                    abi: mandateAccountAbi,
                    functionName: 'setCapability',
                    args: [capability.id, true],
                  })
                }
                onDone={refresh}
                blockedBy={blockedBy}
                context={{ mandate: created.address, funding: system.funding.facts, capabilityId: capability.id, capability: capability.label }}
              />
            ))}

            {laneParkOf(lane) !== undefined && (
              <LaneGates mandate={created.address} lane={lane} blockedBy={blockedBy} context={{ mandate: created.address, funding: system.funding.facts }} />
            )}

            {gates.error !== null && gates.error !== undefined && (
              <ErrorSurface
                error={gates.error}
                action="Reading what this mandate already allows"
                onRetry={refresh}
                retryLabel="Read again"
              />
            )}
          </div>
        </Card>
      </Section>

      <Section title="Next" description="Fund the mandate and your agent can start paying.">
        <Card>
          <Link href={`/console/${created.address}`} className="text-sm underline underline-offset-2">
            Open the mandate
          </Link>
        </Card>
      </Section>
    </div>
  );
}

function GateRow({
  title,
  detail,
  allowed,
  send,
  onDone,
  blockedBy,
  context,
}: {
  readonly title: string;
  readonly detail: string;
  /** What the account says. Undefined is a reading nobody has taken, which is not "not allowed". */
  readonly allowed: boolean | undefined;
  readonly send: () => Promise<Hex>;
  readonly onDone: () => void;
  readonly blockedBy: readonly AnyState[];
  readonly context: TxContext;
}) {
  // A successful receipt for the allow call is the chain saying yes, so the row flips on it rather
  // than waiting for the next read, and keeps the transaction as the evidence.
  const [landed, setLanded] = useState<Hex | undefined>(undefined);

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--color-line)] pb-4 last:border-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-detail text-[color:var(--color-muted)]">{detail}</p>
      </div>
      {allowed === true || landed !== undefined ? (
        <span className="text-detail" style={{ color: 'var(--color-state-ok)' }}>
          Allowed
          {landed !== undefined && (
            <>
              .{' '}
              <a href={explorerTx(landed)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                View the transaction
              </a>
            </>
          )}
        </span>
      ) : (
        <div className="space-y-1 text-right">
          <TxButton
            label="Allow"
            tone="secondary"
            send={send}
            onConfirmed={(receipt) => {
              setLanded(receipt.transactionHash);
              onDone();
            }}
            blockedBy={blockedBy}
            context={context}
          />
          {allowed === undefined && (
            <p className="text-note text-[color:var(--color-muted)]">Checking the mandate.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The factory names the account in its own event. A node that pruned the logs from the receipt
 * still deployed it at the address the same inputs predicted, so that is the fallback.
 */
function addressFrom(receipt: TransactionReceipt, predictedAddress: Address): Address {
  const [created] = parseEventLogs({
    abi: mandateAccountFactoryAbi,
    eventName: 'Created',
    logs: receipt.logs,
  });
  return created?.args.account ?? predictedAddress;
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** The value as it stood once it had stopped changing for `pauseMs`. */
function useSettled(value: string, pauseMs: number): string {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), pauseMs);
    return () => clearTimeout(timer);
  }, [value, pauseMs]);

  return settled;
}

/** The transactions that follow the deploy, as one line: what gets allowed, then the lane's own steps. */
function afterCreation(payees: number, capabilities: number, followUps: readonly string[]): string {
  const allowed = [
    payees > 0 ? `${payees} payee${payees === 1 ? '' : 's'}` : undefined,
    capabilities > 0 ? `${capabilities} ${capabilities === 1 ? 'capability' : 'capabilities'}` : undefined,
  ].filter((entry) => entry !== undefined);
  const steps = [...(allowed.length > 0 ? [`allow ${allowed.join(' and ')}`] : []), ...followUps];
  if (steps.length === 0) return 'Nothing to allow';
  const line = steps.join(', then ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}
