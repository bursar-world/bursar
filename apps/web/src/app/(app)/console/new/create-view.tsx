'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { parseEventLogs } from 'viem';
import type { Address, Hex, TransactionReceipt } from 'viem';

import { ZERO_ADDRESS, shortAddress } from '@/chain/rhc';
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
import { describeApproval } from '../lib/format';
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

  // Stopped the moment the account exists. The screen below this point is `OpenTheGates`, which
  // reads the same five states scoped to the new address; leaving this one running would poll the
  // chain every twelve seconds for a reading nothing on screen is showing.
  const system = useSystemState({ enabled: created === undefined });

  // The salt is random, so it is drawn in the browser. Drawing it during render would give the
  // server one value and the reader another, and the address on screen would change on hydration.
  useEffect(() => setSalt(randomSalt()), []);

  // The classes go into the account itself as a bit mask, which the contract checks on every spend.
  const classMask = classMaskOf(SPEND_CLASSES.filter((id) => classes[id]));
  const reading = readDraft(draft, Date.now(), { contractSet: 'v2', classMask, lane: laneValue(lane) });
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
          The owner sets the limits, funds the account, approves the payments above the threshold, and can take the
          funds back at any time.
          {askedLane !== undefined && laneAvailable(askedLane) && ` The ${LANE_NAME[askedLane]} funding lane is chosen for you once the wallet connects.`}
        </EmptyState>
      </Section>
    );
  }

  if (draftId !== undefined && (workspace.view.status === 'locked' || workspace.view.status === 'loading')) {
    return (
      <Section title="Create a mandate" description="This screen was opened from a draft in your workspace.">
        {workspace.view.status === 'locked' ? (
          <UnlockForm title="Unlock your workspace to load the draft" description="The draft is encrypted in this browser. Enter the passphrase and the form fills in." />
        ) : (
          <Skeleton width="16rem" height={20} />
        )}
      </Section>
    );
  }

  if (privateMode && owner !== undefined) {
    return (
      <div className="space-y-8">
        <PrivateToggle on onChange={setPrivateMode} />
        <PrivateCreate owner={owner} />
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
      {created === undefined && <PrivateToggle on={false} onChange={setPrivateMode} disabled={frozen} />}
      <fieldset disabled={frozen} className="min-w-0 space-y-8">
        <Section
          title="Create a mandate"
          description="A spending mandate is one account with one agent inside it. The limits are written into the account when it is created, so it is never funded without a bound."
        >
          <Card title="Who spends" description="The address your agent signs with. It can never move funds anywhere except through the escrow.">
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
                    The account is created with no agent and spends nothing until one is seated. The address below does
                    not change when you seat it.
                  </span>
                </span>
              </label>
            </div>
          </Card>
          <Card
            title="How it is funded"
            description="The funding lane is written into the account when it is created. Pick the one you mean to use; it cannot be switched into later."
          >
            <LaneFields lane={lane} onChange={setLane} disabled={frozen} />
          </Card>
        </Section>

        {draftId !== undefined && (
          <p className="border border-[color:var(--color-line)] bg-[color:var(--color-raised)] px-5 py-3 text-detail">
            {source === undefined ? (
              <>That draft is not in the workspace open in this browser, so the form starts empty.</>
            ) : (
              <>
                Filled in from your draft <span className="font-medium">{draftTitle(source)}</span>. Review it here: creating
                the mandate below is a wallet transaction that deploys it. Edits on this screen do not change the draft.
              </>
            )}
          </p>
        )}

        <Section title="What it may spend" description="The period cap refills each period. The total budget never refills, so it bounds the whole mandate.">
          <Card>
            <LimitsFields draft={draft} onChange={setDraft} problems={reading.problems} />
          </Card>
        </Section>

        <Section title="Who it may pay" description="A mandate pays nobody until you say who. Everything else is refused by the contract.">
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
                empty="No payee yet. Each one is allowed in its own transaction after the account is created."
              />
            </div>
          </Card>
        </Section>

        <Section
          title="What it may buy"
          description="Choose the spend classes this mandate allows. Each capability is allowed under its class, and each is its own transaction after the account exists."
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
            <p className="mt-3 text-note text-[color:var(--color-muted)]">
              The chain holds the hash of each label, never the words themselves. The label is kept in this browser so later
              screens can show it back to you.
            </p>
          </Card>
        </Section>
      </fieldset>

      <Section title="Review" description="The address is fixed by the owner, the agent, the limits and the salt together. Change any of them and it is a different account.">
        <Card>
          <div className="space-y-4">
            <FieldGrid columns={2}>
              <Field
                label={created ? 'Mandate address' : 'Address before it exists'}
                hint={
                  created
                    ? 'The account stands here now. Send USDG to it to fund it.'
                    : 'Fund it now if you want to. Nothing can spend from it until it is created.'
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
                        An account already stands at this address, so the factory will not deploy a second one there.
                        Draw a different address below.
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-[color:var(--color-muted)]">The factory did not answer.</span>
                )}
              </Field>
              <Field label="Approvals" hint="Set under the limits above.">
                {reading.limits ? describeApproval(reading.limits.approvalThreshold, reading.limits.perCallCap) : 'Set the limits above'}
              </Field>
              <Field label="Creating it costs" hint="Paid in ETH by the connected wallet, at the fee this chain has been charging.">
                <span className="tabular">{formatEth(DEPLOY_FEE)}</span>
              </Field>
              <Field label="Then" hint="Each payee, each capability and each lane step is a separate transaction, and each is cheap.">
                {payees.length} payee{payees.length === 1 ? '' : 's'}, {capabilities.length} capabilit
                {capabilities.length === 1 ? 'y' : 'ies'}
                {followUps.length > 0 && `, then ${followUps.join(' and ')}`}
              </Field>
              <Field label="Funding lane" hint="Written into the account.">
                {LANE_NAME[lane]}
              </Field>
            </FieldGrid>

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

            {system.blockers.length > 0 && (
              <div className="space-y-1 rounded-md border border-[color:var(--color-line)] p-3">
                <p className="text-detail font-medium">None of these stops this account being created.</p>
                <p className="text-detail text-[color:var(--color-muted)]">
                  A deployment moves no USDG and its fee is paid in ETH. Each of these would stop a payment the mandate
                  makes later, and each has its own owner.
                </p>
                <Blockers system={system} />
              </div>
            )}

            {slot === undefined ? (
              <p className="text-detail text-[color:var(--color-muted)]">
                {ready
                  ? 'Reading the address this mandate would deploy at. Creating it opens once the factory answers.'
                  : 'Fill in the agent and the limits above. The address appears here, with the button that creates the account at it.'}
              </p>
            ) : (
              <TxButton
                label="Create the mandate"
                disabled={!frozen && !canCreate}
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
      <Section title="The mandate exists" description="It holds nothing and pays nobody yet.">
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
            ? 'Reading the account for what it already allows.'
            : remaining === 0
              ? 'Everything you listed is allowed, read back off the account itself.'
              : `${remaining} transaction${remaining === 1 ? '' : 's'} left. Until each one is sent the mandate refuses that payee or that capability.`
        }
      >
        <Card>
          <div className="space-y-4">
            {payees.length === 0 && capabilities.length === 0 && lane === 'prefund' && (
              <p className="text-detail text-[color:var(--color-muted)]">
                You listed no payee and no capability. The mandate refuses every payment until you allow at least one of
                each, which you can do from its own screen.
              </p>
            )}

            {payees.map((payee) => (
              <GateRow
                key={payee}
                title={`Allow ${shortAddress(payee)}`}
                detail="This provider becomes payable from this mandate."
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
                detail="Work of this kind becomes payable from this mandate."
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

      <Section title="Next" description="Fund the account and the agent can start work.">
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
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--color-line)] pb-4 last:border-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-detail text-[color:var(--color-muted)]">{detail}</p>
      </div>
      {allowed === true ? (
        <span className="text-detail" style={{ color: 'var(--color-state-ok)' }}>
          Allowed
        </span>
      ) : (
        <div className="space-y-1 text-right">
          <TxButton label="Send" tone="secondary" send={send} onContinue={onDone} blockedBy={blockedBy} context={context} />
          {allowed === undefined && (
            <p className="text-note text-[color:var(--color-muted)]">Reading the account for this one.</p>
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
