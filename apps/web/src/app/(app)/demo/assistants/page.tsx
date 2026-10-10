import type { Metadata } from 'next';
import Link from 'next/link';

import { explorerAddress, explorerTx } from '@/chain/rhc';
import { Address, CopyControl } from '@/components/address';
import { Card, Field, FieldGrid, Section } from '@/components/layout';

export const metadata: Metadata = {
  title: 'Connect an assistant · Bursar',
  description: 'Give ChatGPT, Claude or Gemini a budget, and it pays for work inside your limits.',
};

/**
 * The run this page describes: a mandate created and funded from a terminal, an assistant
 * connected through the hosted endpoint, and one payment it made. Every figure is from chain.
 */
const DEMO = {
  mandate: '0x47F1f569F84fe0806846AD578FF1E85cfAFd3F34' as const,
  agent: '0x5EC462dc794fffB2B7bbd888174Ce237D056F10B',
  provider: '0x5210D8df060A9D5ce4c1305045ED5c9548fca374',
  capability: 'gpu.render:1',
  amount: '0.25 USDG',
  limits: '0.50 USDG a payment, 1.00 USDG a day, 5.00 USDG a month',
  seatTx: '0x418a957c134ba373da90e3b64eb74721dabef9df86778b9bd77c767bc6f7c3e4' as const,
  payTx: '0x09d2d3717c3f169de1ab6016d9e94cce515b7b00a80b83da7fd59238963e56c5' as const,
} as const;

const ENDPOINT = 'https://mcp.bursar.world/mcp';
const TOKEN = '<the token from the mandate page>';

const CLAUDE_CODE = `claude mcp add --transport http bursar ${ENDPOINT} --header "Authorization: Bearer ${TOKEN}"`;

const GEMINI = `{
  "mcpServers": {
    "bursar": {
      "httpUrl": "${ENDPOINT}",
      "headers": { "Authorization": "Bearer ${TOKEN}" },
      "timeout": 60000
    }
  }
}`;

const ASK = 'Pay 0.25 USDG to 0x5210D8df060A9D5ce4c1305045ED5c9548fca374 for gpu.render:1, with a day to deliver.';

export default function AssistantsDemoPage() {
  return (
    <div className="space-y-10">
      <Section title="Connect an assistant" description="Give ChatGPT, Claude or Gemini a budget, and it pays for work inside your limits.">
        <Card>
          <p className="max-w-3xl text-sm">
            A mandate is a budget on chain: the most per payment, per day and per month, who may be paid and for what.
            The hosted endpoint lets an assistant spend from one. On the mandate&apos;s page you sign a message, the
            host makes an agent for the assistant and keeps its key, you seat that agent on the mandate, and you paste one
            setting into the assistant. From then on it can ask to pay, and the mandate account decides. A payment outside
            the limits does not settle, whatever the assistant was told.
          </p>
          <p className="mt-3 max-w-3xl text-sm">
            The host holds the agent&apos;s key and nothing else: no USDG, no say over the limits. Pause the mandate or revoke
            the agent from the console and the assistant can spend nothing. Disconnect the assistant and the host stops
            answering its token.
          </p>
        </Card>
      </Section>

      <Section title="One real run" description="A mandate with cents in it, an assistant connected to it, and one payment it made.">
        <Card>
          <FieldGrid columns={2}>
            <Field label="Mandate" hint={DEMO.limits}>
              <Address value={DEMO.mandate} />
            </Field>
            <Field label="Agent the host made" hint="Seated on the mandate by its owner. Holds the key, never the money.">
              <Address value={DEMO.agent} />
            </Field>
            <Field label="Seated in" hint="The owner's one transaction after signing the connection message.">
              <a href={explorerTx(DEMO.seatTx)} className="font-mono text-note underline underline-offset-2" target="_blank" rel="noreferrer">
                {DEMO.seatTx.slice(0, 10)}…{DEMO.seatTx.slice(-6)}
              </a>
            </Field>
            <Field label="The payment" hint={`${DEMO.amount} for ${DEMO.capability}, asked for in a chat and sent by the hosted agent.`}>
              {DEMO.payTx ? (
                <a href={explorerTx(DEMO.payTx)} className="font-mono text-note underline underline-offset-2" target="_blank" rel="noreferrer">
                  {DEMO.payTx.slice(0, 10)}…{DEMO.payTx.slice(-6)}
                </a>
              ) : (
                <a href={explorerAddress(DEMO.mandate)} className="font-mono text-note underline underline-offset-2" target="_blank" rel="noreferrer">
                  the mandate&apos;s transactions
                </a>
              )}
            </Field>
          </FieldGrid>
          <p className="mt-4 max-w-3xl text-sm">
            What was typed into the assistant: <q>{ASK}</q> It called <code className="font-mono text-note">mandate_quote_spend</code>, then{' '}
            <code className="font-mono text-note">mandate_pay_provider</code>. The escrow holds the amount until the provider delivers or the
            deadline passes, and the mandate&apos;s daily budget moved by exactly that amount.
          </p>
        </Card>
      </Section>

      <Section title="Setting it up" description="Three steps on the mandate's page, then one setting in the assistant.">
        <Card title="On the mandate's page">
          <ol className="max-w-3xl list-decimal space-y-2 pl-5 text-sm">
            <li>
              Open your mandate in the <Link href="/console" className="underline underline-offset-2">console</Link> and find <strong>Assistants</strong>.
              Press <strong>Create connection</strong> and sign the message in your wallet. It sends no transaction.
            </li>
            <li>
              The host answers with the agent it made. Press <strong>Seat the agent</strong> and confirm the transaction. Until it
              lands the assistant can spend nothing.
            </li>
            <li>
              Send the agent a little ETH for network fees. It pays each payment&apos;s fee from its own address; the USDG never leaves the mandate until a provider is paid.
            </li>
            <li>Copy the token. It is shown once. The host keeps only a fingerprint of it.</li>
          </ol>
        </Card>

        <Card title="ChatGPT" description="Settings, then Connectors. Needs developer mode on a plan that offers it.">
          <ol className="max-w-3xl list-decimal space-y-1 pl-5 text-sm">
            <li>Open Settings, then Connectors, then Create.</li>
            <li>
              Name it <strong>Bursar</strong>. For the URL paste the one marked ChatGPT on the mandate page: the endpoint with your token in its path.
              Set Authentication to <strong>No authentication</strong>.
            </li>
            <li>If the form is not offered, turn on Developer mode under Settings, Connectors, Advanced.</li>
            <li>In a new chat, enable the connector from the plus menu and ask it to pay.</li>
          </ol>
          <p className="mt-3 max-w-3xl text-detail text-[color:var(--color-muted)]">
            The token travels in the URL because the form takes no header. Treat that URL as the secret it carries.
          </p>
        </Card>

        <Card title="Claude" description="Settings, then Connectors, then Add custom connector.">
          <ol className="max-w-3xl list-decimal space-y-1 pl-5 text-sm">
            <li>Open Settings, then Connectors, then Add custom connector.</li>
            <li>Name it <strong>Bursar</strong> and paste the URL marked Claude on the mandate page. Leave the OAuth fields empty.</li>
            <li>In a chat, open the tools menu, enable Bursar, and ask it to pay.</li>
          </ol>
          <p className="mt-3 max-w-3xl text-sm">In Claude Code the token goes in a header instead:</p>
          <div className="mt-2">
            <CodeBlock code={CLAUDE_CODE} label="Copy the Claude Code command" />
          </div>
        </Card>

        <Card title="Gemini CLI" description="One block in settings.json.">
          <CodeBlock code={GEMINI} label="Copy the Gemini settings" />
          <ol className="mt-3 max-w-3xl list-decimal space-y-1 pl-5 text-sm">
            <li>Add the block under <code className="font-mono text-note">mcpServers</code> in <code className="font-mono text-note">~/.gemini/settings.json</code>.</li>
            <li>Start Gemini CLI and run <code className="font-mono text-note">/mcp</code>. The Bursar tools are listed.</li>
            <li>Ask it to pay.</li>
          </ol>
        </Card>
      </Section>

      <Section title="What the assistant can do" description="The same tools the published MCP server offers, bound to your mandate.">
        <Card>
          <p className="max-w-3xl text-sm">
            It can read the limits and what is left, quote a payment before making it, pay a provider, hire an agent against a
            brief, follow a settlement, and contest one. It cannot change the limits, move funds out, or act for any other mandate:
            the token is bound to one account and the key signs for that account alone. The{' '}
            <Link href="/docs" className="underline underline-offset-2">developers page</Link> lists every tool.
          </p>
          <p className="mt-3 max-w-3xl text-sm">
            A payment at or above the approval threshold waits for your signature, as it does for any agent. The assistant is
            told so and can ask you for it.
          </p>
        </Card>
      </Section>
    </div>
  );
}

function CodeBlock({ code, label }: { readonly code: string; readonly label: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md bg-[color:var(--color-raised)] p-3 pr-11 font-mono text-note leading-relaxed">
        <code>{code}</code>
      </pre>
      <span className="absolute right-1.5 top-1.5">
        <CopyControl value={code} label={label} />
      </span>
    </div>
  );
}
