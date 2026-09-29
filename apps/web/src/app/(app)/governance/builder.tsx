'use client';

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  ADMIN_ACTIONS,
  actionById,
  blankRow,
  buildCall,
  emptyDraft,
  governedByKey,
  parseField,
} from '@/chain/admin-actions';
import type { AdminAction, AdminDraft, AdminField, BuiltCall } from '@/chain/admin-actions';
import { readCall } from '@/chain/admin-actions';
import { Address } from '@/components/address';
import { Button } from '@/components/button';
import { SelectField, TextField } from '@/components/fields';
import { Card, Field, FieldGrid } from '@/components/layout';

/**
 * The calldata builder.
 *
 * Governance on this deployment is two signatures and two days, and the second signature is the
 * one that authorises the change. A signer who approves a hex blob has authorised something they
 * did not read. So the form knows every setter the timelock can call, refuses what the contract
 * refuses before the two days are spent rather than after, and renders the finished call as a
 * sentence next to the bytes it produced. The sentence is decoded back out of those bytes, not
 * written alongside them, so the two cannot disagree.
 */

const UNIT: Readonly<Record<AdminField['kind'], string | undefined>> = {
  usdg: 'USDG',
  brsr: 'BRSR',
  seconds: 'seconds',
  bps: 'bps',
  count: undefined,
  score: 'points',
  address: undefined,
  bytes32: undefined,
  index: undefined,
};

export type CalldataBuilderProps = {
  /** Narrows the list. The operator surface offers two of these; governance offers all of them. */
  readonly only?: readonly string[];
  readonly initialActionId?: string;
  readonly label?: string;
  /** The send control. Handed the finished call so the caller can wrap it in a transaction. */
  readonly children: (built: BuiltCall, action: AdminAction) => ReactNode;
};

export function CalldataBuilder({ only, initialActionId, label = 'Change to propose', children }: CalldataBuilderProps) {
  const catalogue = useMemo(
    () => ADMIN_ACTIONS.filter((entry) => !entry.retired && (only === undefined || only.includes(entry.id))),
    [only],
  );
  const first = initialActionId ?? catalogue[0]?.id ?? ADMIN_ACTIONS[0]?.id ?? '';

  const [selected, setSelected] = useState(first);
  const [draft, setDraft] = useState<AdminDraft>(() => {
    const action = actionById(first);
    return action ? emptyDraft(action) : { values: {}, rows: [] };
  });

  const action = actionById(selected) ?? catalogue[0];
  if (!action) return null;

  const built = buildCall(action, draft);

  const choose = (id: string) => {
    const next = actionById(id);
    setSelected(id);
    setDraft(next ? emptyDraft(next) : { values: {}, rows: [] });
  };

  const setValue = (name: string, value: string) => setDraft((current) => ({ ...current, values: { ...current.values, [name]: value } }));

  const setRow = (index: number, name: string, value: string) =>
    setDraft((current) => ({
      ...current,
      rows: current.rows.map((row, position) => (position === index ? { ...row, [name]: value } : row)),
    }));

  return (
    <div className="space-y-5">
      <SelectField
        label={label}
        value={selected}
        onChange={choose}
        options={catalogue.map((entry) => ({ value: entry.id, label: entry.label, group: governedByKey(entry.contract).name }))}
        help="Every entry here is a call one of the governance delays administers. The proposal goes to the delay that administers the contract it changes."
      />

      <p className="max-w-3xl text-sm">{action.consequence}</p>

      {action.shape.kind === 'fields' && (
        <FieldGrid columns={2}>
          {action.shape.fields.map((field) => (
            <TextField
              key={field.name}
              label={field.label}
              value={draft.values[field.name] ?? ''}
              onChange={(value) => setValue(field.name, value)}
              help={field.help}
              problem={fieldProblem(field, draft.values[field.name] ?? '')}
              placeholder={field.placeholder}
              suffix={UNIT[field.kind]}
              mono={field.kind === 'address' || field.kind === 'bytes32'}
            />
          ))}
        </FieldGrid>
      )}

      {action.shape.kind === 'rows' && (
        <Rows
          shape={action.shape}
          rows={draft.rows}
          onChange={setRow}
          onAdd={() =>
            setDraft((current) => ({
              ...current,
              rows: [...current.rows, blankRow(action.shape.kind === 'rows' ? action.shape.row : [])],
            }))
          }
          onRemove={(index) => setDraft((current) => ({ ...current, rows: current.rows.filter((_, position) => position !== index) }))}
        />
      )}

      {action.shape.kind === 'none' && <p className="text-detail text-[color:var(--color-muted)]">This call takes no arguments.</p>}

      <CallPreview built={built} />

      {children(built, action)}
    </div>
  );
}

function fieldProblem(field: AdminField, text: string): string | undefined {
  // Silent while the field is still empty. A form that turns red before anything has been typed
  // into it is telling a reader off for not having started.
  if (text.trim() === '') return undefined;
  const parsed = parseField(field, text);
  return parsed.ok ? undefined : parsed.problem;
}

function Rows({
  shape,
  rows,
  onChange,
  onAdd,
  onRemove,
}: {
  readonly shape: Extract<AdminAction['shape'], { kind: 'rows' }>;
  readonly rows: readonly Readonly<Record<string, string>>[];
  readonly onChange: (index: number, name: string, value: string) => void;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
}) {
  return (
    <div className="space-y-3">
      {rows.map((row, index) => (
        <div key={index} className="rounded-md border border-[color:var(--color-line)] px-3 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-label uppercase tracking-wide text-[color:var(--color-muted)]">
              {shape.rowLabel} {index + 1}
            </span>
            <Button size="sm" tone="quiet" onClick={() => onRemove(index)} disabled={rows.length === 1}>
              Remove
            </Button>
          </div>
          <FieldGrid columns={2}>
            {shape.row.map((field) => (
              <TextField
                key={field.name}
                label={field.label}
                value={row[field.name] ?? ''}
                onChange={(value) => onChange(index, field.name, value)}
                help={field.help}
                problem={fieldProblem(field, row[field.name] ?? '')}
                placeholder={field.placeholder}
                suffix={UNIT[field.kind]}
              />
            ))}
          </FieldGrid>
        </div>
      ))}

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={onAdd} disabled={rows.length >= shape.maxRows}>
          Add a {shape.rowLabel.toLowerCase()}
        </Button>
        <span className="text-note text-[color:var(--color-muted)]">
          {rows.length} of at most {shape.maxRows}.
        </span>
      </div>
    </div>
  );
}

/**
 * What the form just built, read back out of the bytes.
 *
 * The sentence comes from decoding the calldata, so it is the same reading a signer gets when the
 * proposal is pending and they are the second approval. If the two ever disagree, it is the
 * decoder that is wrong, and it is wrong in both places at once.
 */
export function CallPreview({ built }: { readonly built: BuiltCall }) {
  if (!built.ok) {
    return (
      <Card title="Nothing to propose yet">
        <ul className="space-y-1 text-sm">
          {built.problems.map((problem) => (
            <li key={problem} style={{ color: 'var(--color-state-blocked)' }}>
              {problem}
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  const reading = readCall(built.target, built.data);

  return (
    <Card title="What this proposal does" description={reading.sentence}>
      <FieldGrid columns={2}>
        <Field label="Target">
          <Address value={built.target} label={reading.targetName} />
        </Field>
        <Field label="Function">
          <span className="font-mono text-detail">{reading.signature ?? 'Not decoded'}</span>
        </Field>
      </FieldGrid>

      {reading.rows.length > 0 && (
        <div className="mt-4">
          <Field label="What it passes">
            <ul className="space-y-1">
              {reading.rows.map((entry) => (
                <li key={`${entry.label}-${entry.value}`} className="text-sm">
                  <span className="text-[color:var(--color-muted)]">{entry.label}</span>{' '}
                  {entry.address ? <Address value={entry.address} /> : <span className="tabular">{entry.value}</span>}
                </li>
              ))}
            </ul>
          </Field>
        </div>
      )}

      <div className="mt-4">
        <Field label="Calldata" hint="The bytes the proposal carries. The sentence above is decoded from exactly these.">
          <p className="break-all font-mono text-note">{built.data}</p>
        </Field>
      </div>
    </Card>
  );
}
