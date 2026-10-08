'use client';

import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { Button } from '@/components/button';
import { Card } from '@/components/layout';
import { useWorkspace } from '@/workspace/context';
import { WrongPassphraseError } from '@/workspace/crypto';
import { BackupError, MIN_PASSPHRASE_LENGTH, passphraseProblem } from '@/workspace/session';

/**
 * The passphrase field. It is a password input with autocomplete scoped to what it is for, and it
 * is never given a name: nothing about it should be offered to a password manager as a login.
 */
export function PassphraseField({
  label,
  value,
  onChange,
  autoComplete,
  hint,
  problem,
  autoFocus = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: 'new-password' | 'current-password';
  readonly hint?: ReactNode;
  readonly problem?: string;
  readonly autoFocus?: boolean;
}) {
  const id = useId();
  const bad = problem !== undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
        {label}
      </label>
      <input
        id={id}
        type="password"
        value={value}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        spellCheck={false}
        aria-invalid={bad}
        aria-describedby={bad || hint ? `${id}-note` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 w-full border bg-surface px-3.5 text-sm outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
        style={{ borderColor: bad ? 'var(--color-state-blocked)' : 'var(--color-line)' }}
      />
      {(bad || hint) && (
        <p id={`${id}-note`} className="text-note" style={{ color: bad ? 'var(--color-state-blocked)' : 'var(--color-muted)' }}>
          {bad ? problem : hint}
        </p>
      )}
    </div>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof WrongPassphraseError || error instanceof BackupError) return error.message;
  return error instanceof Error ? error.message : 'Something went wrong. Nothing was changed.';
}

/** Opening a workspace takes a moment on purpose: 600,000 rounds of PBKDF2 is the point. */
function Working({ busy, children }: { readonly busy: boolean; readonly children: ReactNode }) {
  return <>{busy ? 'Working…' : children}</>;
}

export function CreateWorkspaceForm() {
  const { actions } = useWorkspace();
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const problem = passphraseProblem(passphrase, confirmation);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (problem !== undefined) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await actions.create(passphrase);
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Create a private workspace" description="Your drafts and agents are encrypted in this browser with a passphrase only you know.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <PassphraseField
          label="Passphrase"
          value={passphrase}
          onChange={setPassphrase}
          autoComplete="new-password"
          autoFocus
          hint={`At least ${MIN_PASSPHRASE_LENGTH} characters. It never leaves this page, and nobody can recover the workspace without it.`}
        />
        <PassphraseField
          label="Type it again"
          value={confirmation}
          onChange={setConfirmation}
          autoComplete="new-password"
          problem={tried ? problem : undefined}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" tone="primary" disabled={busy}>
            <Working busy={busy}>Create workspace</Working>
          </Button>
        </div>
        {failure && (
          <p role="alert" className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
            {failure}
          </p>
        )}
      </form>
    </Card>
  );
}

export function UnlockForm({ title = 'Unlock your workspace', description }: { readonly title?: string; readonly description?: ReactNode }) {
  const { actions } = useWorkspace();
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (passphrase === '') return;
    setBusy(true);
    setFailure(undefined);
    try {
      await actions.unlock(passphrase);
      setPassphrase('');
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={title} description={description ?? 'Enter your passphrase to open your drafts.'}>
      <form onSubmit={submit} className="space-y-4">
        <PassphraseField
          label="Passphrase"
          value={passphrase}
          onChange={setPassphrase}
          autoComplete="current-password"
          autoFocus
          problem={failure}
        />
        <Button type="submit" tone="primary" disabled={busy || passphrase === ''}>
          <Working busy={busy}>Unlock</Working>
        </Button>
      </form>
    </Card>
  );
}

export function ImportBackupForm({ replacing }: { readonly replacing: boolean }) {
  const { actions } = useWorkspace();
  const fileId = useId();
  const [text, setText] = useState<string | undefined>();
  const [fileName, setFileName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (text === undefined || passphrase === '') return;
    setBusy(true);
    setFailure(undefined);
    try {
      await actions.importBackup(text, passphrase);
      setPassphrase('');
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Import a backup"
      description={
        replacing
          ? 'Replaces the workspace in this browser once the backup’s passphrase opens it. Nothing is overwritten if it does not.'
          : 'Open an encrypted backup exported from this console, on this device or another.'
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor={fileId} className="block text-label uppercase tracking-wide text-[color:var(--color-muted)]">
            Backup file
          </label>
          <input
            id={fileId}
            type="file"
            accept="application/json,.json"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              setFailure(undefined);
              setFileName(file?.name ?? '');
              setText(file ? await file.text() : undefined);
            }}
            className="block w-full text-detail file:mr-3 file:h-9 file:border file:border-[color:var(--color-line-strong)] file:bg-transparent file:px-3.5 file:font-mono file:text-label file:uppercase file:tracking-wide focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
          />
          {fileName && <p className="text-note text-[color:var(--color-muted)]">{fileName}</p>}
        </div>
        <PassphraseField
          label="The backup’s passphrase"
          value={passphrase}
          onChange={setPassphrase}
          autoComplete="current-password"
          problem={failure}
        />
        <Button type="submit" disabled={busy || text === undefined || passphrase === ''}>
          <Working busy={busy}>{replacing ? 'Replace with this backup' : 'Import backup'}</Working>
        </Button>
      </form>
    </Card>
  );
}
