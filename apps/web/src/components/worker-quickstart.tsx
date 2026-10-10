import Link from 'next/link';

import { CopyControl } from '@/components/address';
import { Card } from '@/components/layout';

const CREATE = `npm create @bursar/provider my-api
cd my-api && npm install
npx wrangler secret put BURSAR_FACILITATOR_TOKEN
npx wrangler deploy`;

const WRAP = `import { paymentOf, withBursar } from '@bursar/provider-worker';

export default {
  fetch: withBursar(async (request) => {
    const payment = paymentOf(request);
    return Response.json({ rendered: 'a koi', paidBy: payment?.payer });
  }),
};`;

/**
 * The shortest path from a Cloudflare Worker to a priced route, shown on the provider desk and
 * the developers page. Every command runs as printed once the two packages are on npm.
 */
export function WorkerQuickstart({ compact = false }: { readonly compact?: boolean }) {
  return (
    <Card
      title="Charge from a Cloudflare Worker"
      description="One priced route, paid by agents over x402 and settled through Bursar. One command to deploy."
    >
      <div className="space-y-4">
        <Commands code={CREATE} label="Copy the deploy commands" />
        <p className="max-w-3xl text-sm">
          The project it writes has one priced route, <code className="font-mono text-note">POST /render</code> at
          0.01 USDG. Set your provider address, the capability and the prices in{' '}
          <code className="font-mono text-note">wrangler.toml</code>. An agent that calls the route without paying
          gets a 402 with the price; one that pays from its mandate gets the result, and the payment lands in
          escrow for your address.
        </p>
        {!compact && (
          <>
            <p className="max-w-3xl text-sm">
              An existing Worker takes the same route: install{' '}
              <code className="font-mono text-note">@bursar/provider-worker</code>, wrap the fetch handler, and
              price routes with <code className="font-mono text-note">BURSAR_PRICES</code>. Routes without a price
              pass through as before.
            </p>
            <Commands code={WRAP} label="Copy the handler example" />
          </>
        )}
        <p className="max-w-3xl text-sm">
          Your address has to be listed on the{' '}
          <Link href="/providers" className="underline underline-offset-2">
            provider desk
          </Link>{' '}
          first, and the hosted facilitator answers providers that hold a token. Releasing each escrow lock is
          what pays you: give the worker your provider key as a secret and it releases after every call, or release
          from the desk.
        </p>
      </div>
    </Card>
  );
}

function Commands({ code, label }: { readonly code: string; readonly label: string }) {
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
