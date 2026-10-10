'use client';

import Link from 'next/link';
import type { Address } from 'viem';

import { REGISTRIES, cardUrl, siteOrigin } from '@/chain/erc8004';
import { explorerAddress } from '@/chain/rhc';
import { Address as AddressView } from '@/components/address';
import { Card, Field, FieldGrid, Section } from '@/components/layout';

import { IdentitySection } from '../../providers/identity';

/** The provider the walkthrough registered, read live like any other. */
export const DEMO_PROVIDER: Address = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374';

export function DemoView() {
  const registries = REGISTRIES;
  const card = cardUrl(siteOrigin(), DEMO_PROVIDER);

  return (
    <div className="space-y-10">
      <Section
        title="Every provider is an ERC-8004 agent"
        description="A Bursar provider registers an on-chain identity from its desk. 8004scan and OpenSea list it; rulings can reach its reputation."
      >
        <Card>
          <p className="max-w-prose text-sm">
            ERC-8004 gives agents a portable identity: an ERC-721 token in a registry that is the same contract on every chain it is
            deployed to, pointing at a card that says what the agent is and where to reach it. On Robinhood Chain the registry already
            holds thousands of agents. A provider on Bursar mints its identity from its desk in one transaction; the card is served by
            this console from the listing, so the handle, the stake, the score and the largest job a payer can open are read from the
            contracts, never typed in.
          </p>
        </Card>
      </Section>

      <IdentitySection subject={DEMO_PROVIDER} owner={DEMO_PROVIDER} kind="provider" canRegister={false} blockedBy={[]} />

      <Section title="Try it" description="With your own provider address, in two steps.">
        <Card>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Open <Link href="/providers" className="underline underline-offset-2">Getting paid</Link> with the wallet the escrow pays and list the address, if it is not listed yet.
            </li>
            <li>
              Under Agent identity, press Register the identity. The registry mints the token to your wallet and points it at your
              card. The desk reads the token back from the registry and links to it on 8004scan and OpenSea.
            </li>
          </ol>
          <p className="mt-4 text-detail text-[color:var(--color-muted)]">
            A mandate owner does the same for the agent seated on a mandate, from the mandate&rsquo;s overview. The card for this
            provider is at <a href={card} className="underline underline-offset-2" target="_blank" rel="noreferrer">{card}</a>.
          </p>
        </Card>
      </Section>

      {registries !== undefined && (
        <Section title="What is on chain" description="The standard's own registries on Robinhood Chain, chain 4663.">
          <Card>
            <FieldGrid columns={3}>
              <Field label="Identity registry" hint="AgentIdentity, an ERC-721. The same proxy and implementation as on Base.">
                <AddressView value={registries.identity} />
              </Field>
              <Field label="Reputation registry" hint="Signed feedback per agent from any client that is not its owner.">
                {registries.reputation === undefined ? 'Not deployed on this chain' : <AddressView value={registries.reputation} />}
              </Field>
              <Field label="Validation registry" hint="Validator responses per agent.">
                {registries.validation === undefined ? 'Not deployed on this chain' : <AddressView value={registries.validation} />}
              </Field>
            </FieldGrid>
            <p className="mt-4 text-detail text-[color:var(--color-muted)]">
              Read the registry at{' '}
              <a href={explorerAddress(registries.identity)} className="underline underline-offset-2" target="_blank" rel="noreferrer">
                the explorer
              </a>
              , the collection on{' '}
              <a href="https://opensea.io/collection/agentidentity" className="underline underline-offset-2" target="_blank" rel="noreferrer">
                OpenSea
              </a>{' '}
              and the agents on{' '}
              <a href="https://www.8004scan.io/agents" className="underline underline-offset-2" target="_blank" rel="noreferrer">
                8004scan
              </a>
              .
            </p>
          </Card>
        </Section>
      )}
    </div>
  );
}
