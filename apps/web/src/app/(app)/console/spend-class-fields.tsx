'use client';

import { useId, useState } from 'react';

import { SPEND_CLASSES, SPEND_CLASS_INFO, bareLabel, classLabel } from '@/chain/capabilities';
import type { SpendClass } from '@/chain/capabilities';
import { Button } from '@/components/button';
import { ChipList } from './chip-list';

/** One capability a mandate allows, named without its class namespace. */
export type ClassedCapability = { readonly spendClass: SpendClass; readonly label: string };

export type ClassSelection = Readonly<Record<SpendClass, boolean>>;

/** The label as the chain hashes it: the class namespace, then the name. */
export function chainLabel(capability: ClassedCapability): string {
  return `${SPEND_CLASS_INFO[capability.spendClass].prefix}${capability.label}`;
}

/**
 * The capabilities a set of class toggles writes to the account.
 *
 * A class that is off writes nothing. The contract holds capabilities one id at a time, so this
 * list is the whole of what the classes mean on chain.
 */
export function classCapabilities(classes: ClassSelection, capabilities: readonly ClassedCapability[]): readonly ClassedCapability[] {
  return capabilities.filter((entry) => classes[entry.spendClass]);
}

/** The three spend classes, as toggles, each with the capabilities allowed under it. */
export function SpendClassFields({
  classes,
  capabilities,
  onChange,
  disabled = false,
}: {
  readonly classes: ClassSelection;
  readonly capabilities: readonly ClassedCapability[];
  readonly onChange: (classes: ClassSelection, capabilities: readonly ClassedCapability[]) => void;
  readonly disabled?: boolean;
}) {
  return (
    <div className="space-y-4">
      {SPEND_CLASSES.map((id) => (
        <ClassRow
          key={id}
          spendClass={id}
          on={classes[id]}
          capabilities={capabilities.filter((entry) => entry.spendClass === id)}
          disabled={disabled}
          onToggle={(on) => onChange({ ...classes, [id]: on }, capabilities)}
          onAdd={(label) => {
            if (capabilities.some((entry) => entry.spendClass === id && entry.label === label)) return;
            onChange(classes, [...capabilities, { spendClass: id, label }]);
          }}
          onRemove={(label) => onChange(classes, capabilities.filter((entry) => !(entry.spendClass === id && entry.label === label)))}
        />
      ))}
      <p className="text-note text-[color:var(--color-muted)]">
        Each capability is written on chain as the hash of its class and name, such as{' '}
        <code className="font-mono">service:gpu.render:1</code>. The contract checks that exact id, so a mandate that allows
        only services refuses every agent hire.
      </p>
    </div>
  );
}

function ClassRow({
  spendClass,
  on,
  capabilities,
  disabled,
  onToggle,
  onAdd,
  onRemove,
}: {
  readonly spendClass: SpendClass;
  readonly on: boolean;
  readonly capabilities: readonly ClassedCapability[];
  readonly disabled: boolean;
  readonly onToggle: (on: boolean) => void;
  readonly onAdd: (label: string) => void;
  readonly onRemove: (label: string) => void;
}) {
  const info = SPEND_CLASS_INFO[spendClass];
  const toggleId = useId();
  const inputId = useId();
  const [text, setText] = useState('');

  let problem: string | undefined;
  let label: string | undefined;
  if (text.trim() !== '') {
    try {
      label = bareLabel(classLabel(spendClass, text));
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
  }

  const add = () => {
    if (label === undefined) return;
    onAdd(label);
    setText('');
  };

  return (
    <div className="border border-[color:var(--color-line)] p-4" data-spend-class={spendClass}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-3">
          <input
            id={toggleId}
            type="checkbox"
            checked={on}
            disabled={disabled}
            onChange={(event) => onToggle(event.target.checked)}
            aria-describedby={`${toggleId}-about`}
            className="mt-1 h-4 w-4"
          />
          <label htmlFor={toggleId} className="text-sm">
            <span className="font-medium">{info.name}</span>
            <span id={`${toggleId}-about`} className="block text-detail text-[color:var(--color-muted)]">
              {info.summary}
            </span>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <code className="font-mono text-note text-[color:var(--color-muted)]">{info.prefix}*</code>
        </div>
      </div>

      {on && (
        <div className="mt-4 space-y-3 pl-7">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1">
              <label htmlFor={inputId} className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
                Capability in {info.name.toLowerCase()}
              </label>
              <input
                id={inputId}
                value={text}
                disabled={disabled}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    add();
                  }
                }}
                placeholder={spendClass === 'hire' ? 'research.summarize:1' : 'gpu.render:1'}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={problem !== undefined}
                aria-describedby={`${inputId}-note`}
                className="mt-1 h-11 w-full border bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
                style={{ borderColor: problem ? 'var(--color-state-blocked)' : 'var(--color-line)' }}
              />
            </div>
            <Button onClick={add} disabled={disabled || label === undefined}>
              Add
            </Button>
          </div>
          <p id={`${inputId}-note`} className="tabular text-note" style={{ color: problem ? 'var(--color-state-blocked)' : 'var(--color-muted)' }}>
            {problem ?? (label === undefined ? `Written on chain as ${info.prefix}<name>.` : `Written on chain as ${info.prefix}${label}.`)}
          </p>
          <ChipList
            items={capabilities.map((entry) => ({ key: entry.label, label: chainLabel(entry) }))}
            onRemove={onRemove}
            disabled={disabled}
            empty={`No capability yet. With none listed, this class allows nothing.`}
          />
        </div>
      )}
    </div>
  );
}
