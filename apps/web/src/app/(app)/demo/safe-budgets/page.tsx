import type { Metadata } from 'next';
import Link from 'next/link';

import { explorerAddress, explorerTx } from '@/chain/rhc';
import { Address, CopyControl } from '@/components/address';
import { Card, Field, FieldGrid, Section } from '@/components/layout';

import { safeAppHome, safeAppOpen } from '../../console/lib/safe-signing';
import { LIVE } from './record';

export const metadata: Metadata = {
  title: 'Budgets from a Safe · Bursar',
  description: 'A treasury gives its agents budgets from a Safe. The Safe creates the mandate, funds it, sets the limits and signs the approvals.',
};

const CONSOLE_URL = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'https://app.bursar.world';

const SCRIPT = `source ops/rhc-env.sh
pnpm --filter @bursar/sdk exec tsx scripts/safe-budgets.ts`;

export default function SafeBudgetsPage() {
  return (
    <div className="space-y-10">
      <Section
        title="Budgets from a Safe"
        description="A treasury can own a mandate from its Safe. The Safe creates it, funds it, sets the limits, seats the agent and signs the approvals, with as many owners as the Safe requires."
      >
        <Card>
          <FieldGrid columns={3}>
            <Field label="Who owns the mandate" hint="The Safe, from the first transaction.">
              The mandate is created by its owner, so a Safe that sends the creation owns it outright. No key is
              delegated and nothing is held on its behalf.
            </Field>
            <Field label="What the owners sign" hint="Every change is a Safe transaction.">
              Funding, limits, the agent, a pause and a withdrawal are each one transaction, confirmed by the number
              of owners the Safe asks for.
            </Field>
            <Field label="How approvals work" hint="Checked by the mandate through ERC-1271.">
              A payment at or above the threshold waits for the Safe. The owners sign the approval as a message, or
              register it on chain as a transaction. Either way the agent pays with it once.
            </Field>
          </FieldGrid>
        </Card>
      </Section>

      <Section title="In the Safe app" description="Safe lists Robinhood Chain, so a Safe there runs the console from inside the Safe app.">
        <Card>
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              Open the console inside your Safe. In Safe, choose Apps, add <span className="tabular">{CONSOLE_URL}</span> as a custom
              app, and open it. The console connects as the Safe on its own; the wallet picker lists it as Safe.
            </li>
            <li>
              Create the mandate from the console as usual. The Safe app turns the creation into a Safe transaction,
              the owners confirm it, and the mandate lists the Safe as its owner.
            </li>
            <li>
              Fund it, set its limits, seat the agent, pause it or withdraw from the same screens. Each action is one
              Safe transaction.
            </li>
            <li>
              Approve a payment above the threshold. Sign it asks the Safe to sign the approval; with one owner the
              signed approval appears at once. With more, the other owners confirm the message in Safe and the console
              shows the finished approval when they have, read from the Safe transaction service for Robinhood Chain.
              Register it on chain is a Safe transaction instead, and needs no second step.
            </li>
          </ol>
          <p className="mt-4 text-detail text-[color:var(--color-muted)]">
            A Safe connected to the console any other way, through a browser wallet or WalletConnect, sends
            transactions but cannot sign messages. Its approvals are registered on chain.
          </p>
          <p className="mt-2 text-detail">
            <a href={safeAppOpen(LIVE.safe, CONSOLE_URL)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              Open the console inside the example Safe
            </a>
            <span className="text-[color:var(--color-muted)]"> (Safe asks you to connect as one of its owners first.)</span>
          </p>
        </Card>
      </Section>

      <Section title="From a script" description="A treasury run from code does the same with Safe's protocol kit, with no app and no transaction service.">
        <Card>
          <p className="text-sm">
            The script deploys a Safe with three owners and a threshold of two, then has it create a mandate, fund it,
            change a limit, seat an agent, register an approval and sign one, collecting two signatures each time. The
            Safe refunds the gas of every transaction it executes, so the treasury pays its own way.
          </p>
          <div className="mt-3 flex items-start justify-between gap-3">
            <pre className="tabular whitespace-pre-wrap break-all bg-[color:var(--color-raised)] p-3 text-note">{SCRIPT}</pre>
            <CopyControl value={SCRIPT} label="Copy the commands" />
          </div>
          <p className="mt-3 text-detail text-[color:var(--color-muted)]">
            The keys come from your own keystores, named in the script. Every transaction is written to a record the
            script reads back, so a step that fails is retried without a second Safe or a second mandate.
          </p>
        </Card>
      </Section>

      <Section title="The live example" description="What the script did on Robinhood Chain, with the transactions as the Safe sent them.">
        <Card>
          <FieldGrid columns={2}>
            <Field label="The Safe" hint="Safe 1.4.1, three owners, two to sign.">
              <span className="inline-flex items-center gap-2">
                <Address value={LIVE.safe} />
                <a href={safeAppHome(LIVE.safe)} target="_blank" rel="noreferrer" className="text-detail underline underline-offset-2">
                  In Safe
                </a>
              </span>
            </Field>
            <Field label="The mandate" hint="Owned by the Safe.">
              <span className="inline-flex items-center gap-2">
                <Address value={LIVE.mandate} />
                <Link href={`/console/${LIVE.mandate}`} className="text-detail underline underline-offset-2">
                  In the console
                </Link>
              </span>
            </Field>
          </FieldGrid>
          <table className="mt-6 w-full text-sm">
            <caption className="sr-only">Transactions the Safe sent</caption>
            <thead>
              <tr className="text-left text-label uppercase tracking-wide text-[color:var(--color-muted)]">
                <th className="py-2 pr-4 font-medium">Action</th>
                <th className="py-2 pr-4 font-medium">Who signed</th>
                <th className="py-2 font-medium">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {LIVE.steps.map((step) => (
                <tr key={step.hash} className="border-t border-[color:var(--color-line)]">
                  <td className="py-2 pr-4 align-top">{step.action}</td>
                  <td className="py-2 pr-4 align-top text-[color:var(--color-muted)]">{step.signed}</td>
                  <td className="py-2 align-top">
                    <a href={explorerTx(step.hash)} target="_blank" rel="noreferrer" className="tabular underline underline-offset-2">
                      {step.hash.slice(0, 10)}…{step.hash.slice(-6)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-detail text-[color:var(--color-muted)]">
            The signed approval never touched the chain until the agent paid with it: two owners signed the message,
            the Safe at{' '}
            <a href={explorerAddress(LIVE.safe)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              its address
            </a>{' '}
            accepted the pair, and the mandate verified that answer through ERC-1271 when the payment landed.
          </p>
        </Card>
      </Section>
    </div>
  );
}
