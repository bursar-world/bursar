'use client';

import { useState } from 'react';

import { CopyControl } from '@/components/address';
import type { ConnectorSettings } from '../lib/assistants';

/**
 * What to type into each assistant, filled in with this connection's endpoint and token.
 *
 * Two forms of the same endpoint. ChatGPT's and Claude's connector forms take a URL and nothing
 * else, so for them the token travels in the URL. Claude Code and Gemini CLI send a header, so
 * for them it travels as a bearer. Each tab says which it is doing.
 */

export type Connector = 'chatgpt' | 'claude' | 'claude-code' | 'gemini';

export const CONNECTORS: readonly { readonly id: Connector; readonly label: string }[] = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'gemini', label: 'Gemini CLI' },
];

export function ConnectorSettingsView({ settings, initial = 'chatgpt' }: { readonly settings: ConnectorSettings; readonly initial?: Connector }) {
  const [active, setActive] = useState<Connector>(initial);

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Assistants" className="flex flex-wrap gap-2">
        {CONNECTORS.map((connector) => (
          <button
            key={connector.id}
            type="button"
            role="tab"
            aria-selected={connector.id === active}
            onClick={() => setActive(connector.id)}
            className={`cursor-pointer border px-3 py-1.5 font-mono text-note uppercase transition-colors ${
              connector.id === active
                ? 'border-[color:var(--color-ink)] text-[color:var(--color-ink)]'
                : 'border-[color:var(--color-line)] text-[color:var(--color-muted-deep)] hover:text-[color:var(--color-ink)]'
            }`}
          >
            {connector.label}
          </button>
        ))}
      </div>

      {active === 'chatgpt' && (
        <Steps steps={settings.chatgpt.steps} note="The token travels in the URL, because the connector form takes no header. Treat the URL as the secret it carries.">
          <Setting label="Name" value={settings.chatgpt.name} />
          <Setting label="MCP server URL" value={settings.chatgpt.url} copyLabel="Copy the server URL" />
          <Setting label="Authentication" value={settings.chatgpt.authentication} />
        </Steps>
      )}

      {active === 'claude' && (
        <Steps steps={settings.claude.steps} note="The token travels in the URL, because the connector form takes no header. Treat the URL as the secret it carries.">
          <Setting label="Name" value={settings.claude.name} />
          <Setting label="Remote MCP server URL" value={settings.claude.url} copyLabel="Copy the server URL" />
        </Steps>
      )}

      {active === 'claude-code' && (
        <Steps steps={['Run the command in a terminal where Claude Code is installed.', 'Start Claude Code and ask it to pay.']} note="The token is sent as a bearer header.">
          <Setting label="Command" value={settings.claudeCode.command} copyLabel="Copy the command" block />
        </Steps>
      )}

      {active === 'gemini' && (
        <Steps steps={settings.gemini.steps} note="The token is sent as a bearer header.">
          <Setting label="settings.json" value={settings.gemini.settings} copyLabel="Copy the settings" block />
        </Steps>
      )}
    </div>
  );
}

function Steps({ steps, note, children }: { readonly steps: readonly string[]; readonly note: string; readonly children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <div className="space-y-3">{children}</div>
      <ol className="list-decimal space-y-1 pl-5 text-detail">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="text-note text-[color:var(--color-muted)]">{note}</p>
    </div>
  );
}

function Setting({ label, value, copyLabel, block = false }: { readonly label: string; readonly value: string; readonly copyLabel?: string; readonly block?: boolean }) {
  return (
    <div className="space-y-1">
      <div className="text-label uppercase tracking-wide text-[color:var(--color-muted)]">{label}</div>
      <div className="relative">
        <pre className={`overflow-x-auto rounded-md bg-[color:var(--color-raised)] p-3 ${copyLabel ? 'pr-11' : ''} font-mono text-note leading-relaxed ${block ? '' : 'whitespace-pre-wrap break-all'}`}>
          <code>{value}</code>
        </pre>
        {copyLabel && (
          <span className="absolute right-1.5 top-1.5">
            <CopyControl value={value} label={copyLabel} />
          </span>
        )}
      </div>
    </div>
  );
}
