'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';

import { SPEND_CLASSES, SPEND_CLASS_INFO } from '@/chain/capabilities';
import type { SpendClass } from '@/chain/capabilities';
import { AddressInput, readAddress } from '@/components/address-input';
import { AmountInput } from '@/components/amount-input';
import { Badge } from '@/components/badge';
import { Button } from '@/components/button';
import { SelectField, TextField } from '@/components/fields';
import { Card, EmptyState, Field, FieldGrid, Section } from '@/components/layout';
import { Modal } from '@/components/modal';
import { useWorkspace } from '@/workspace/context';
import { draftTitle } from '@/workspace/model';
import type { MandateDraft, Workspace } from '@/workspace/model';
import { EMPTY_SPEND, checkDraftSpend } from '@/workspace/rule-check';
import type { PlannedSpend, RuleCheckResult } from '@/workspace/rule-check';
import { ChipList } from '../../../console/chip-list';
import { LimitsFields, readDraft } from '../../../console/limits-form';
import { SpendClassFields } from '../../../console/spend-class-fields';
import { WorkspaceGate } from '../../gate';

export function DraftView({ draftId }: { readonly draftId: string }) {
  return (
    <WorkspaceGate>
      {(workspace) => {
        const draft = workspace.drafts.find((entry) => entry.id === draftId);
        if (!draft) {
          return (
            <EmptyState title="This draft is not in your workspace." action={<Link href="/workspace" className="text-sm underline underline-offset-2">Back to the workspace</Link>}>
              It may have been removed, or it belongs to a workspace in another browser.
            </EmptyState>
          );
        }
        return <DraftEditor key={draft.id} saved={draft} workspace={workspace} />;
      }}
    </WorkspaceGate>
  );
}

function DraftEditor({ saved, workspace }: { readonly saved: MandateDraft; readonly workspace: Workspace }) {
  const { actions } = useWorkspace();
  const router = useRouter();
  const [draft, setDraft] = useState<MandateDraft>(saved);
  const [payeeText, setPayeeText] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [removeOpen, setRemoveOpen] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const reading = readDraft(draft.limits);
  const agent = readAddress(draft.agent);
  const agentOptions = [
    { value: '', label: 'Choose a saved agent' },
    ...workspace.agents.map((entry) => ({ value: entry.address, label: `${entry.name} · ${entry.address.slice(0, 8)}…` })),
  ];

  useEffect(() => {
    if (status !== 'saved') return;
    const timer = setTimeout(() => setStatus('idle'), 2_500);
    return () => clearTimeout(timer);
  }, [status]);

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    setStatus('saving');
    const next = { ...draft, updatedAt: new Date().toISOString() };
    await actions.update((current) => ({ ...current, drafts: current.drafts.map((entry) => (entry.id === next.id ? next : entry)) }));
    setDraft(next);
    setStatus('saved');
  };

  const addPayee = () => {
    const value = readAddress(payeeText).value;
    if (!value || draft.payees.some((entry) => entry.toLowerCase() === value.toLowerCase())) return;
    setDraft({ ...draft, payees: [...draft.payees, value] });
    setPayeeText('');
  };

  const remove = async () => {
    await actions.update((current) => ({ ...current, drafts: current.drafts.filter((entry) => entry.id !== draft.id) }));
    router.push('/workspace');
  };

  return (
    <div className="space-y-10">
      <nav aria-label="Breadcrumb" className="text-detail text-[color:var(--color-muted)]">
        <Link href="/workspace" className="underline-offset-2 hover:underline">
          Workspace
        </Link>{' '}
        / {draftTitle(saved)}
      </nav>

      <form onSubmit={save} className="space-y-10">
        <Section
          title={draftTitle(draft)}
          description="A draft lives only in this workspace, encrypted. Saving it sends no transaction, deploys nothing and moves no funds."
          actions={
            <div className="flex items-center gap-3">
              <span aria-live="polite" className="text-detail text-[color:var(--color-muted)]">
                {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : dirty ? 'Unsaved changes' : ''}
              </span>
              <Button type="submit" tone="primary" size="sm" disabled={!dirty || status === 'saving'}>
                Save draft
              </Button>
            </div>
          }
        >
          {saved.activated && (
            <p className="border border-[color:var(--color-line)] bg-[color:var(--color-raised)] px-5 py-3 text-detail">
              Activated {new Date(saved.activated.at).toLocaleDateString()} as{' '}
              <Link href={`/console/${saved.activated.address}`} className="tabular underline underline-offset-2">
                {saved.activated.address}
              </Link>
              . Edits here change the draft, not the deployed mandate.
            </p>
          )}
          <Card title="About this draft">
            <div className="space-y-4">
              <TextField label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} placeholder="Research budget" />
              <TextField label="Notes" value={draft.notes} onChange={(notes) => setDraft({ ...draft, notes })} help="Only you can read these." />
            </div>
          </Card>
        </Section>

        <Section title="Who spends" description="The address the agent signs with.">
          <Card>
            <FieldGrid columns={2}>
              <AddressInput
                label="Agent address"
                value={draft.agent}
                onChange={(text) => setDraft({ ...draft, agent: text })}
                {...(agent.problem ? { problem: agent.problem } : {})}
              />
              {workspace.agents.length > 0 ? (
                <SelectField
                  label="Or pick a saved agent"
                  value={workspace.agents.some((entry) => entry.address === draft.agent) ? draft.agent : ''}
                  options={agentOptions}
                  onChange={(value) => value !== '' && setDraft({ ...draft, agent: value })}
                />
              ) : (
                <Field label="Saved agents">
                  <Link href="/workspace" className="underline underline-offset-2">
                    Add agents in the workspace
                  </Link>
                </Field>
              )}
            </FieldGrid>
          </Card>
        </Section>

        <Section title="What it may spend" description="The period cap refills each period. The total budget never refills, so it bounds the whole mandate.">
          <Card>
            <LimitsFields draft={draft.limits} onChange={(limits) => setDraft({ ...draft, limits })} problems={reading.problems} />
          </Card>
        </Section>

        <Section title="What it may buy" description="Choose the spend classes this mandate allows, and the capabilities under each.">
          <Card>
            <SpendClassFields
              classes={draft.classes}
              capabilities={draft.capabilities}
              onChange={(classes, capabilities) => setDraft({ ...draft, classes, capabilities })}
            />
          </Card>
        </Section>

        <Section title="Who it may pay" description="The counterparties this mandate may pay. Everything else is refused.">
          <Card>
            <div className="space-y-3">
              <AddressInput
                label="Counterparty address"
                value={payeeText}
                onChange={setPayeeText}
                action={
                  <Button onClick={addPayee} disabled={readAddress(payeeText).value === undefined}>
                    Add
                  </Button>
                }
              />
              <ChipList
                items={draft.payees.map((payee) => ({ key: payee, label: payee }))}
                onRemove={(key) => setDraft({ ...draft, payees: draft.payees.filter((entry) => entry !== key) })}
                empty="No counterparty yet. A mandate with none pays nobody."
              />
            </div>
          </Card>
        </Section>
      </form>

      <RuleCheck draft={draft} />

      <Section title="Activate" description="Activation deploys the mandate from your wallet. The draft stays here.">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-xl text-detail text-[color:var(--color-muted)]">
              The create screen opens with this draft filled in. You review it there, and a wallet transaction deploys it.
              A saved draft or a rule check is not a transaction and not a proof.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {dirty && <span className="text-detail text-[color:var(--color-muted)]">Save the draft first.</span>}
              {dirty ? (
                <Button tone="primary" disabled>
                  Activate
                </Button>
              ) : (
                <Link href={`/console/new?draft=${encodeURIComponent(saved.id)}`} className="action min-h-11 text-note" data-tone="primary">
                  <span className="action-label px-5 py-2">
                    <span>Activate</span>
                  </span>
                  <span className="action-square w-11" aria-hidden="true">
                    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </span>
                </Link>
              )}
            </div>
          </div>
        </Card>
      </Section>

      <div className="flex justify-end border-t border-[color:var(--color-line)] pt-4">
        <Button tone="quiet" size="sm" onClick={() => setRemoveOpen(true)}>
          Remove draft
        </Button>
      </div>

      <Modal
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        title="Remove this draft"
        description="It is deleted from the workspace. A deployed mandate made from it is not affected."
        footer={
          <div className="flex justify-end gap-2">
            <Button tone="quiet" onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button tone="destructive" onClick={() => void remove()}>
              Remove draft
            </Button>
          </div>
        }
      >
        <p className="text-detail">{draftTitle(saved)}</p>
      </Modal>
    </div>
  );
}

function RuleCheck({ draft }: { readonly draft: MandateDraft }) {
  const [spend, setSpend] = useState<PlannedSpend>(EMPTY_SPEND);
  const [result, setResult] = useState<RuleCheckResult | undefined>();
  const set = <K extends keyof PlannedSpend>(key: K, value: PlannedSpend[K]) => {
    setSpend({ ...spend, [key]: value });
    setResult(undefined);
  };
  const dateId = useId();

  const run = (event: FormEvent) => {
    event.preventDefault();
    setResult(checkDraftSpend(draft, spend));
  };

  return (
    <Section
      title="Check a spend before activation"
      description="Run a spend your agent might ask for against this draft’s rules. Nothing is deployed or sent; the check reads the draft as it is on screen."
    >
      <Card>
        <form onSubmit={run} className="space-y-5" noValidate>
          <FieldGrid columns={3}>
            <SelectField
              label="Spend class"
              value={spend.spendClass}
              onChange={(value) => set('spendClass', value as SpendClass)}
              options={SPEND_CLASSES.map((id) => ({
                value: id,
                label: SPEND_CLASS_INFO[id].available ? SPEND_CLASS_INFO[id].name : `${SPEND_CLASS_INFO[id].name} (not yet available)`,
              }))}
            />
            <TextField label="Capability" value={spend.capability} onChange={(value) => set('capability', value)} placeholder="gpu.render:1" mono />
            <AmountInput label="Amount" asset="USDG" value={spend.amount} onChange={(value) => set('amount', value)} />
          </FieldGrid>
          <FieldGrid columns={3}>
            <AddressInput label="Counterparty" value={spend.payee} onChange={(value) => set('payee', value)} />
            <AmountInput
              label="Already spent this period"
              asset="USDG"
              value={spend.spentThisPeriod}
              onChange={(value) => set('spentThisPeriod', value)}
              hint="Leave empty for none."
            />
            <AmountInput
              label="Already spent in total"
              asset="USDG"
              value={spend.spentInTotal}
              onChange={(value) => set('spentInTotal', value)}
              hint="Including this period."
            />
          </FieldGrid>
          <div className="space-y-1.5 sm:w-1/3">
            <label htmlFor={dateId} className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
              On
            </label>
            <input
              id={dateId}
              type="date"
              value={spend.date}
              onChange={(event) => set('date', event.target.value)}
              className="tabular h-11 w-full border border-[color:var(--color-line)] bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
            />
            <p className="text-note text-[color:var(--color-muted)]">Leave empty for today.</p>
          </div>
          <Button type="submit">Run the check</Button>
        </form>
        <div aria-live="polite" className="mt-5">
          {result && <RuleResult result={result} />}
        </div>
      </Card>
    </Section>
  );
}

function RuleResult({ result }: { readonly result: RuleCheckResult }) {
  if (result.outcome === 'incomplete') {
    return (
      <div className="border border-[color:var(--color-line)] p-4" data-outcome="incomplete">
        <p className="text-sm font-medium">The check needs more before it can answer.</p>
        <ul className="mt-2 space-y-1 text-detail" style={{ color: 'var(--color-state-blocked)' }}>
          {result.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      </div>
    );
  }

  const tone =
    result.outcome === 'allowed' ? 'var(--color-state-ok)' : result.outcome === 'approval' ? 'var(--color-state-attention)' : 'var(--color-state-blocked)';
  const headline =
    result.outcome === 'allowed' ? 'Within the rules' : result.outcome === 'approval' ? 'Needs your approval' : `Refused by the ${result.rule.toLowerCase()} rule`;

  return (
    <div className="border p-4" style={{ borderColor: tone }} data-outcome={result.outcome} data-rule={result.outcome === 'allowed' ? '' : result.rule}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium" style={{ color: tone }}>
          {headline}
        </p>
        {result.outcome !== 'allowed' && <Badge tone="quiet">{result.rule}</Badge>}
      </div>
      <p className="mt-1 text-detail">{result.message}</p>
      <p className="mt-2 text-note text-[color:var(--color-muted)]">A rule check reads the draft. It is not a transaction and not a proof.</p>
    </div>
  );
}
