'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import { AddressInput, readAddress } from '@/components/address-input';
import { Badge } from '@/components/badge';
import { Button } from '@/components/button';
import { TextField } from '@/components/fields';
import { Card, EmptyState, Section } from '@/components/layout';
import { Modal } from '@/components/modal';
import { Table } from '@/components/table';
import { formatInstant } from '@/lib/time';
import { parseUsdgInput, usd } from '@/money';
import { useWorkspace } from '@/workspace/context';
import { draftTitle, newDraft, newId, upsert } from '@/workspace/model';
import type { MandateDraft, Workspace, WorkspaceAgent } from '@/workspace/model';
import { AGENT_FIELDS, DRAFT_FIELDS, readableExport } from '@/workspace/readable';
import type { AgentField, DraftField } from '@/workspace/readable';
import { isTotalDraft } from '../console/limits-form';
import { WorkspaceGate } from './gate';

export function WorkspaceView() {
  return (
    <div className="space-y-10">
      <Section
        title="Workspace"
        description="Draft mandates privately and check a payment against them before anything goes on chain. Saving a draft sends no transaction."
      >
        <WorkspaceGate>{(workspace) => <OpenWorkspace workspace={workspace} />}</WorkspaceGate>
      </Section>
    </div>
  );
}

function OpenWorkspace({ workspace }: { readonly workspace: Workspace }) {
  return (
    <div className="space-y-10">
      <LockBar />
      <Drafts workspace={workspace} />
      <Agents workspace={workspace} />
      <BackupAndExport workspace={workspace} />
    </div>
  );
}

function LockBar() {
  const { view, actions } = useWorkspace();
  const updatedAt = view.status === 'unlocked' ? view.updatedAt : null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border border-[color:var(--color-line)] bg-[color:var(--color-raised)] px-5 py-3">
      <p className="text-detail">
        <span className="font-medium">Unlocked in this tab.</span>{' '}
        <span className="text-[color:var(--color-muted)]">
          Encrypted and stored on this device only
          {updatedAt ? `, last saved ${formatInstant(new Date(updatedAt))}` : ''}. Locking it or closing the page asks for the
          passphrase again.
        </span>
      </p>
      <Button size="sm" onClick={actions.lock}>
        Lock
      </Button>
    </div>
  );
}

function Drafts({ workspace }: { readonly workspace: Workspace }) {
  const { actions } = useWorkspace();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    const draft = newDraft();
    try {
      await actions.update((current) => ({ ...current, drafts: [...current.drafts, draft] }));
      router.push(`/workspace/drafts/${draft.id}`);
    } finally {
      setBusy(false);
    }
  };

  const drafts = [...workspace.drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <Section
      title="Drafts"
      description="A draft lives only here and does nothing until you activate it."
      actions={
        <Button tone="primary" size="sm" onClick={create} disabled={busy}>
          New draft
        </Button>
      }
    >
      <Card>
        <Table<MandateDraft>
          rows={drafts}
          rowKey={(row) => row.id}
          caption="Draft mandates in this workspace"
          empty={<EmptyState title="No drafts yet.">Start one to set its limits and payees.</EmptyState>}
          columns={[
            {
              key: 'name',
              header: 'Draft',
              cell: (row) => (
                <Link href={`/workspace/drafts/${row.id}`} className="font-medium underline-offset-2 hover:underline">
                  {draftTitle(row)}
                </Link>
              ),
            },
            {
              key: 'budget',
              header: 'Total budget',
              align: 'right',
              cell: (row) => (
                <span className="tabular">{draftBudget(row)}</span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (row) => (row.activated ? <Badge>Activated</Badge> : <Badge tone="quiet">Draft</Badge>),
            },
            {
              key: 'updated',
              header: 'Saved',
              secondary: true,
              cell: (row) => <span className="text-detail text-[color:var(--color-muted)]">{formatInstant(new Date(row.updatedAt))}</span>,
            },
          ]}
        />
      </Card>
    </Section>
  );
}

const EMPTY_AGENT = { name: '', address: '', notes: '' };

function Agents({ workspace }: { readonly workspace: Workspace }) {
  const { actions } = useWorkspace();
  const [form, setForm] = useState(EMPTY_AGENT);
  const [editing, setEditing] = useState<string | undefined>();
  const [tried, setTried] = useState(false);
  const address = readAddress(form.address);
  const nameProblem = form.name.trim() === '' ? 'Give the agent a name you will recognise.' : undefined;
  const addressProblem = address.problem ?? (form.address.trim() === '' ? 'Enter the address the agent signs with.' : undefined);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (nameProblem || addressProblem || address.value === undefined) return;
    const agent: WorkspaceAgent = { id: editing ?? newId(), name: form.name.trim(), address: address.value, notes: form.notes.trim() };
    await actions.update((current) => ({ ...current, agents: upsert(current.agents, agent) }));
    setForm(EMPTY_AGENT);
    setEditing(undefined);
    setTried(false);
  };

  const remove = (id: string) => actions.update((current) => ({ ...current, agents: current.agents.filter((entry) => entry.id !== id) }));

  return (
    <Section title="Agents" description="The agents you give mandates to. A draft can take its agent from this list.">
      <Card>
        <div className="space-y-5">
          <Table<WorkspaceAgent>
            rows={workspace.agents}
            rowKey={(row) => row.id}
            caption="Agents in this workspace"
            empty={<p className="text-detail text-[color:var(--color-muted)]">No agents yet. Add the first one below.</p>}
            columns={[
              { key: 'name', header: 'Agent', cell: (row) => <span className="font-medium">{row.name}</span> },
              { key: 'address', header: 'Address', cell: (row) => <span className="tabular text-detail break-all">{row.address}</span> },
              { key: 'notes', header: 'Notes', secondary: true, cell: (row) => <span className="text-detail">{row.notes}</span> },
              {
                key: 'actions',
                header: '',
                align: 'right',
                cell: (row) => (
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      tone="quiet"
                      aria-label={`Edit ${row.name}`}
                      onClick={() => {
                        setEditing(row.id);
                        setForm({ name: row.name, address: row.address, notes: row.notes });
                      }}
                    >
                      Edit
                    </Button>
                    <Button size="sm" tone="quiet" onClick={() => remove(row.id)} aria-label={`Remove ${row.name}`}>
                      Remove
                    </Button>
                  </div>
                ),
              },
            ]}
          />

          <form onSubmit={save} className="space-y-4 border-t border-[color:var(--color-line)] pt-4" noValidate>
            <p className="text-label uppercase tracking-wide text-[color:var(--color-muted)]">{editing ? 'Edit agent' : 'Add an agent'}</p>
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
              <TextField
                label="Name"
                value={form.name}
                onChange={(name) => setForm({ ...form, name })}
                {...(tried && nameProblem ? { problem: nameProblem } : {})}
              />
              <AddressInput
                label="Address"
                value={form.address}
                onChange={(text) => setForm({ ...form, address: text })}
                {...(tried && addressProblem ? { problem: addressProblem } : {})}
              />
            </div>
            <TextField label="Notes" value={form.notes} onChange={(notes) => setForm({ ...form, notes })} help="Kept encrypted with the rest of the workspace." />
            <div className="flex flex-wrap gap-2">
              <Button type="submit">{editing ? 'Save agent' : 'Add agent'}</Button>
              {editing && (
                <Button
                  tone="quiet"
                  onClick={() => {
                    setEditing(undefined);
                    setForm(EMPTY_AGENT);
                    setTried(false);
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </form>
        </div>
      </Card>
    </Section>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function BackupAndExport({ workspace }: { readonly workspace: Workspace }) {
  const { actions } = useWorkspace();
  const [readableOpen, setReadableOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [failure, setFailure] = useState<string | undefined>();

  const backup = async () => {
    setFailure(undefined);
    try {
      download(`bursar-workspace-${stamp()}.json`, await actions.exportBackup());
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The backup could not be written.');
    }
  };

  return (
    <Section title="Backup and export" description="Keep your own encrypted backup. It opens with the same passphrase, in this browser or another.">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Encrypted backup" description="Your whole workspace, readable only with your passphrase.">
          <div className="space-y-3">
            <Button onClick={backup}>Download encrypted backup</Button>
            {failure && (
              <p role="alert" className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
                {failure}
              </p>
            )}
          </div>
        </Card>
        <Card title="Readable export" description="A plain JSON file with only the fields you choose. Anyone holding it can read it, so keep it private.">
          <Button onClick={() => setReadableOpen(true)}>Choose fields</Button>
        </Card>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--color-line)] pt-4">
        <p className="text-detail text-[color:var(--color-muted)]">
          Removing the workspace deletes it from this browser. Without a backup and its passphrase it cannot be recovered.
        </p>
        <Button tone="quiet" size="sm" onClick={() => setRemoveOpen(true)}>
          Remove from this browser
        </Button>
      </div>

      <ReadableExportDialog open={readableOpen} onClose={() => setReadableOpen(false)} workspace={workspace} />

      <Modal
        open={removeOpen}
        onClose={() => {
          setRemoveOpen(false);
          setConfirm('');
        }}
        title="Remove this workspace"
        description="Every draft and agent in this browser is deleted. Download a backup first if you want to keep them."
        footer={
          <div className="flex justify-end gap-2">
            <Button tone="quiet" onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button tone="destructive" disabled={confirm !== 'REMOVE'} onClick={() => void actions.remove()}>
              Remove workspace
            </Button>
          </div>
        }
      >
        <TextField label="Type REMOVE to confirm" value={confirm} onChange={setConfirm} mono />
      </Modal>
    </Section>
  );
}

function ReadableExportDialog({ open, onClose, workspace }: { readonly open: boolean; readonly onClose: () => void; readonly workspace: Workspace }) {
  const [drafts, setDrafts] = useState<readonly DraftField[]>([]);
  const [agents, setAgents] = useState<readonly AgentField[]>([]);
  const nothing = drafts.length === 0 && agents.length === 0;

  const toggle = <T extends string>(list: readonly T[], value: T, on: boolean): readonly T[] =>
    on ? [...list.filter((entry) => entry !== value), value] : list.filter((entry) => entry !== value);

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={520}
      title="Readable export"
      description={`Only the ticked fields are written, for all ${workspace.drafts.length} draft${workspace.drafts.length === 1 ? '' : 's'} and ${workspace.agents.length} agent${workspace.agents.length === 1 ? '' : 's'}.`}
      footer={
        <div className="flex justify-end gap-2">
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            tone="primary"
            disabled={nothing}
            onClick={() => {
              download(`bursar-workspace-readable-${stamp()}.json`, JSON.stringify(readableExport(workspace, { drafts, agents }), null, 2));
              onClose();
            }}
          >
            Download readable file
          </Button>
        </div>
      }
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <FieldChecklist
          legend="From each draft"
          fields={DRAFT_FIELDS}
          selected={drafts}
          onToggle={(id, on) => setDrafts(toggle(drafts, id, on))}
        />
        <FieldChecklist
          legend="From each agent"
          fields={AGENT_FIELDS}
          selected={agents}
          onToggle={(id, on) => setAgents(toggle(agents, id, on))}
        />
      </div>
    </Modal>
  );
}

function FieldChecklist<T extends string>({
  legend,
  fields,
  selected,
  onToggle,
}: {
  readonly legend: string;
  readonly fields: readonly { readonly id: T; readonly label: string }[];
  readonly selected: readonly T[];
  readonly onToggle: (id: T, on: boolean) => void;
}) {
  const base = useId();
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-label uppercase tracking-wide text-[color:var(--color-muted)]">{legend}</legend>
      {fields.map((field) => (
        <div key={field.id} className="flex items-center gap-2">
          <input
            id={`${base}-${field.id}`}
            type="checkbox"
            checked={selected.includes(field.id)}
            onChange={(event) => onToggle(field.id, event.target.checked)}
            className="h-4 w-4"
          />
          <label htmlFor={`${base}-${field.id}`} className="text-detail">
            {field.label}
          </label>
        </div>
      ))}
    </fieldset>
  );
}

/** The total budget as the console prints money, or a dash where the draft has none. */
function draftBudget(draft: MandateDraft): string {
  if (!isTotalDraft(draft.limits) || draft.limits.monthly === '') return '—';
  const parsed = parseUsdgInput(draft.limits.monthly);
  return parsed.ok ? usd(parsed.value) : `${draft.limits.monthly} USDG`;
}
