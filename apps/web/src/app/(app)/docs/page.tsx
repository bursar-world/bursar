import type { Metadata } from 'next';
import Link from 'next/link';

import { ADDRESSES, RHC, CHAIN_ID } from '@/chain/rhc';
import { Address, CopyControl } from '@/components/address';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { formatEth } from '@/money';
// Straight from the module. The state barrel re-exports hooks, and a static page that touches it
// ships wagmi and the query client to every reader.
import { ROUND_TRIP_FEE } from '@/state/evaluate';

export const metadata: Metadata = {
  title: 'Developers · BURSAR',
  description: 'SDK quickstart, the MCP server, and x402 for a provider that wants to charge agents.',
};

const QUICKSTART = `import { mandateAccount, usdg } from '@bursar/sdk';

const mandate = await mandateAccount(ACCOUNT, { account: AGENT_KEY });

const receipt = await mandate.pay({
  to: PROVIDER,
  amount: usdg('2.50'),
  capability: 'gpu.render:1',
});`;

const FETCH = `const paid = await mandate.fetch('https://api.provider.dev/render', {
  method: 'POST',
  body: JSON.stringify({ prompt: 'a koi' }),
  capability: 'gpu.render:1',
  lane: 'mandate',
});

paid.payment?.lock; // the escrow lock the mandate opened for this call`;

const PREVIEW = `const decision = await mandate.preview({
  to: PROVIDER,
  amount: usdg('2.50'),
  capability: 'gpu.render:1',
});

if (!decision.allowed) {
  // decision.reason is 'daily-cap', 'per-call-cap', 'merchant-not-allowed', …
  // decision.daily.resetsAt says when a spent window frees up.
}`;

/** The keyless second endpoint the packages default to, so a quickstart needs no key to run. */
const FALLBACK_RPC = 'https://robinhood.drpc.org';

/**
 * The command is a path because `@bursar/mcp` is not on any registry. A published name in this
 * block resolves to nothing on a reader's machine and the client reports `ENOENT`, which says
 * nothing about what is missing.
 */
const MCP_CONFIG = `{
  "mcpServers": {
    "mandate": {
      "command": "node",
      "args": ["<your clone>/packages/mcp/bin/bursar-mcp.mjs"],
      "env": {
        "RHC_RPC_PRIMARY": "${RHC.rpcUrl}",
        "RHC_RPC_FALLBACK": "${FALLBACK_RPC}",
        "MANDATE_ACCOUNT": "<the mandate account this server speaks for>"
      }
    }
  }
}`;

const TOOLS: readonly { readonly name: string; readonly what: string; readonly writes: boolean }[] = [
  { name: 'mandate_inspect', what: 'The caps, what each window has left, when each resets, the approval threshold, the funded balance, and whether the mandate is running.', writes: false },
  { name: 'mandate_quote_spend', what: 'What the mandate would decide about a payment, before making it. Names the limit that would stop it.', writes: false },
  { name: 'mandate_list_settlements', what: 'What this mandate has paid for, newest first, and where each payment stands.', writes: false },
  { name: 'mandate_get_settlement', what: 'One settlement in full, with the next decision and the time it has to be made by.', writes: false },
  { name: 'mandate_get_dispute', what: 'Where a contested payment stands: the phase, the clock on it, and the ruling once there is one.', writes: false },
  { name: 'mandate_pay_provider', what: 'Locks the amount in escrow against the mandate and hands the job to the provider.', writes: true },
  { name: 'mandate_hire_agent', what: 'The same against a brief: the task, what it runs on, and what counts as delivered, published with the payment.', writes: true },
  { name: 'mandate_open_dispute', what: 'Contests a settlement and hands the split to the resolver.', writes: true },
];

export default function DocsPage() {
  return (
    <div className="space-y-10">
      <Section
        title="Developers"
        description="What an agent needs to spend inside a mandate, and what a provider needs to charge one."
      >
        <Card>
          <p className="max-w-3xl text-sm">
            Every limit in this system is enforced by the mandate account on chain. A payment outside them does not
            settle, whatever an agent was told to do and whichever of these interfaces sent it. The SDK signs with an
            account you pass it. The MCP server holds a key only when you tell it to by name, and hands the work to a
            signer you run when you would rather it did not.
          </p>
        </Card>
      </Section>

      <Section title="The SDK" description="An agent pays a provider in three lines.">
        <Card>
          <CodeBlock code={QUICKSTART} label="Copy the payment example" />
          <p className="mt-3 max-w-3xl text-sm">
            <code className="font-mono text-note">pay</code> reads the limits, opens an escrow lock against the
            account and returns the lock id with the transaction. The provider is paid when it delivers. If it never
            does, the deadline returns the money and credits the allowance back.
          </p>
          <p className="mt-3 max-w-3xl text-sm">
            Amounts are micro-USD held as <code className="font-mono text-note">bigint</code>, the six decimals the
            settlement asset uses. <code className="font-mono text-note">usdg(&apos;2.50&apos;)</code> is 2500000.
            Transaction fees are paid in ETH, which is a different asset with eighteen decimals of its own, and the
            two are never added together.
          </p>
          <p className="mt-3 max-w-3xl text-sm">
            Contract addresses come from the deployment record the package ships, so none of them is pasted in by hand.
            Pass <code className="font-mono text-note">rpc</code> with two endpoints at different hosts to turn on the
            failover pool.
          </p>
        </Card>

        <Card title="Pay for an HTTP call" description="x402: the provider answers 402 with a price, the mandate pays, the call goes through.">
          <CodeBlock code={FETCH} label="Copy the x402 example" />
          <p className="mt-3 max-w-3xl text-sm">
            With <code className="font-mono text-note">lane: &apos;mandate&apos;</code> the account pays the quoted price
            through the same checks as <code className="font-mono text-note">pay</code>. The daily and monthly windows
            move by the amount paid, and a call they do not cover is refused on chain before any money moves.
          </p>
          <p className="mt-3 max-w-3xl text-sm">
            Leave the lane out and the agent&apos;s own wallet pays by signing a USDG transfer for the exact price.
            That lane is per-call only; windows client-enforced. The mandate&apos;s per-call cap, providers and
            capabilities are checked before signing, but nothing on chain counts the payment against a window.
          </p>
        </Card>

        <Card title="Ask before you pay" description="The same check the contract will make, without sending anything.">
          <CodeBlock code={PREVIEW} label="Copy the preview example" />
          <p className="mt-3 max-w-3xl text-sm">
            A refused payment throws <code className="font-mono text-note">MandateDeniedError</code>, which carries
            the same reason and, for a window, the moment it frees up. An agent that reads it can wait instead of
            retrying into the same refusal.
          </p>
        </Card>
      </Section>

      <Section title="The MCP server" description="For an agent that reaches its tools over Model Context Protocol.">
        <Card>
          <CodeBlock code={MCP_CONFIG} label="Copy the server configuration" />
          <p className="mt-3 max-w-3xl text-sm">
            One server, one mandate. Every value in angle brackets is one you supply, starting with the account you
            created in the console. <code className="font-mono text-note">@bursar/mcp</code> is not published, so the
            command is the file in your own clone and{' '}
            <code className="font-mono text-note">pnpm --filter @bursar/mcp build</code> has to have run before it
            starts.
          </p>
          <p className="mt-3 max-w-3xl text-sm">
            As printed it holds no key and advertises the five tools that read. Signing is a separate decision with two
            answers. Set <code className="font-mono text-note">BURSAR_SIGNER=local</code> and{' '}
            <code className="font-mono text-note">BURSAR_SIGNER_KEY</code> and the key stays in this process, able to
            sign for the one account above and for three calls on it. Point{' '}
            <code className="font-mono text-note">BURSAR_RELAY_URL</code> at a signer you run instead and the key never
            reaches the process at all. Either answer advertises eight tools. Both at once is refused, and so is a key
            arriving under a name the server was not told to hold, such as{' '}
            <code className="font-mono text-note">AGENT_PRIVATE_KEY</code> or{' '}
            <code className="font-mono text-note">PRIVATE_KEY</code>. The refusal names the variable and the server
            does not start.
          </p>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-detail">
              <caption className="sr-only">Tools the BURSAR MCP server advertises</caption>
              <thead>
                <tr className="border-b border-[color:var(--color-line)] text-label uppercase tracking-wide text-[color:var(--color-muted)]">
                  <th scope="col" className="py-2 pr-4 font-medium">Tool</th>
                  <th scope="col" className="py-2 pr-4 font-medium">What it does</th>
                  <th scope="col" className="py-2 font-medium">Needs a signer</th>
                </tr>
              </thead>
              <tbody>
                {TOOLS.map((tool) => (
                  <tr key={tool.name} className="border-b border-[color:var(--color-line)] last:border-0 align-top">
                    <td className="whitespace-nowrap py-2 pr-4 font-mono text-note">{tool.name}</td>
                    <td className="py-2 pr-4">{tool.what}</td>
                    <td className="py-2 text-[color:var(--color-muted)]">{tool.writes ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-4 max-w-3xl text-sm">
            A payment at or above the approval threshold needs consent the account owner signed for that provider,
            capability and amount. Without one it is refused before it reaches the chain.
          </p>
        </Card>
      </Section>

      <Section title="Charging agents" description="What a provider runs to take payment from a mandate over x402.">
        <Card title="The facilitator">
          <p className="max-w-3xl text-sm">
            A provider charging for a call sends the payment it received to{' '}
            <code className="font-mono text-note">POST /verify</code> and{' '}
            <code className="font-mono text-note">POST /settle</code>. Verification reads and costs nothing.
            Settlement records the payment once, so a replay is worthless, and for a wallet payment it also
            broadcasts the transfer, drawing on a daily budget that stops when it runs out.
          </p>
          <p className="mt-3 max-w-3xl text-sm">
            Offer two schemes. <code className="font-mono text-note">escrow</code> is paid by the mandate account
            itself: the payment names the escrow lock its spend opened, verification checks that lock against your
            price, address and the request, and you collect by releasing it once the call is served.{' '}
            <code className="font-mono text-note">exact</code> is paid from the agent&apos;s wallet with an EIP-3009
            USDG transfer that settlement broadcasts. It is per-call only; windows client-enforced.
          </p>
          <p className="mt-3 max-w-3xl text-sm">
            The signing domain is read from the token, never assumed. The network identifier is{' '}
            <code className="font-mono text-note">eip155:{CHAIN_ID}</code>.
          </p>
        </Card>

        <Card title="The sidecar" description="The worker that delivers and collects.">
          <p className="max-w-3xl text-sm">
            It watches the escrow for locks naming your address, runs the capability the payer asked for, and calls{' '}
            <code className="font-mono text-note">release</code> with a commitment to what it delivered. That pays you
            in the same transaction. It signs your calls only, against funds the escrow already holds, and it cannot
            move a payer&apos;s money.
          </p>
          <p className="mt-3 max-w-3xl text-sm">
            One call is worth knowing about on its own.{' '}
            <code className="font-mono text-note">finalizeRelease</code> writes the reputation counter that sets the
            largest single job a payer may lock against you, and it reverts until the payer&apos;s time to contest has
            run out. Anyone can make it and nobody is obliged to, so a provider that never finalises holds its own
            ceiling down without seeing why. The sidecar makes it. So does the{' '}
            <Link href="/providers" className="underline underline-offset-2">
              provider screen
            </Link>
            , one job at a time.
          </p>
        </Card>
      </Section>

      <Section title="Disputes" description="What happens when a payer contests a job before paying for it.">
        <Card>
          <p className="max-w-3xl text-sm">
            A disputed payment stays in escrow until bonded resolvers rule on it. All three resolvers on the registry are
            operated by Bursar and follow a published policy: what counts as delivered, the evidence a provider can send,
            the deadlines, and when Bursar may override. The reasons behind each ruling are published once the votes are
            revealed.
          </p>
          <p className="mt-3 max-w-3xl text-sm">
            A provider sends signed delivery evidence from its desk, or has the sidecar send it by setting{' '}
            <code className="font-mono text-note">SIDECAR_EVIDENCE_URL</code> to{' '}
            <code className="font-mono text-note">https://app.bursar.world/api/evidence</code>.
          </p>
          <p className="mt-3 text-sm">
            <Link href="/docs/ruling-policy" className="underline underline-offset-2">
              Read the ruling policy
            </Link>
          </p>
        </Card>
      </Section>

      <Section title="What a call costs" description={`Gas measured on real transactions, priced at what ${RHC.name} has been charging.`}>
        <Card>
          <FieldGrid columns={3}>
            <Field label="One payment" hint="The mandate check, the escrow lock and the release, end to end.">
              <span className="tabular">{formatEth(ROUND_TRIP_FEE)}</span>
            </Field>
            <Field label="Settlement asset" hint="USDG, six decimals. Transaction fees are paid in ETH and come out of the signer's own balance.">
              <Address value={ADDRESSES.usdg} />
            </Field>
            <Field label="Chain" hint="Every contract address is published on the status page.">
              {RHC.name}, chain {CHAIN_ID}
            </Field>
          </FieldGrid>
          <p className="mt-4 max-w-3xl text-sm">
            Fund a mandate once and debit against the on-chain limit per call. The fee is paid in ETH and is the same
            size whatever the payment is worth, so what a mandate costs to run does not grow with what it spends.
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
