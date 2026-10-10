'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Address } from 'viem';

import { REGISTER_WITH_METADATA_ABI, REGISTRIES, SET_AGENT_URI_ABI, cardUrl, registeredIds, registrationArgs, rulingFeedback, siteOrigin, verifyIdentities } from '@/chain/erc8004';
import type { AgentIdentity, IdentityReading } from '@/chain/erc8004';
import { rhcClient } from '@/chain/client';
import { shortAddress } from '@/chain/rhc';
import { Address as AddressView } from '@/components/address';
import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { Card, Field, FieldGrid, Section, Skeleton } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import type { TxContext } from '@/components/tx-button';
import type { AnyState } from '@/state';
import { useWriteContract } from '@/wallet/write';

/**
 * The ERC-8004 identity of a Bursar address, read from the standard's registry on this chain.
 *
 * The registry mints to whoever registers, so a provider's identity sits in the provider's wallet
 * and a mandate's in its owner's. Which token stands for which address is on the registry itself,
 * in the `bursar.subject` entry a registration sets, and that is what this screen reads: an index
 * shortens the search for the owner's tokens, and a browser remembers the id it just minted, but
 * neither is shown until the registry has answered for it.
 */
export type IdentityKind = 'provider' | 'mandate';

type Reading = IdentityReading & {
  /** At least one index answered, so an empty reading means no identity rather than no answer. */
  readonly searched: boolean;
};

const REFETCH_MS = 30_000;

function hintKey(subject: Address): string {
  return `bursar.erc8004.${subject.toLowerCase()}`;
}

function readHints(subject: Address): readonly bigint[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(hintKey(subject));
    return raw === null ? [] : (JSON.parse(raw) as string[]).filter((id) => /^\d+$/.test(id)).map((id) => BigInt(id));
  } catch {
    return [];
  }
}

function rememberHint(subject: Address, agentId: bigint): void {
  if (typeof window === 'undefined') return;
  try {
    const ids = new Set(readHints(subject).map((id) => id.toString()));
    ids.add(agentId.toString());
    window.localStorage.setItem(hintKey(subject), JSON.stringify([...ids]));
  } catch {
    // Storage refused is a slower next read, nothing more.
  }
}

async function discover(owner: Address): Promise<{ ids: readonly bigint[]; searched: boolean }> {
  try {
    const response = await fetch(`/api/agents/discover?owner=${owner}`, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) return { ids: [], searched: false };
    const body = (await response.json()) as { ids?: string[]; sources?: { ok: boolean }[] };
    return {
      ids: (body.ids ?? []).filter((id) => /^\d+$/.test(id)).map((id) => BigInt(id)),
      searched: (body.sources ?? []).some((source) => source.ok),
    };
  } catch {
    return { ids: [], searched: false };
  }
}

export async function readIdentity(subject: Address, owner: Address): Promise<Reading> {
  const card = cardUrl(siteOrigin(), subject);
  const found = await discover(owner);
  const verified = await verifyIdentities(rhcClient(), [...found.ids, ...readHints(subject)], subject, card);
  const [identity, ...others] = verified;
  const rulings = identity === undefined ? undefined : await rulingFeedback(rhcClient(), identity.agentId).catch(() => undefined);
  return { identity, others, rulings, cardUrl: card, searched: found.searched || identity !== undefined };
}

export function useIdentity(subject: Address, owner: Address | undefined) {
  const query = useQuery({
    queryKey: ['bursar', 'erc8004', subject, owner],
    queryFn: () => readIdentity(subject, owner as Address),
    enabled: owner !== undefined && REGISTRIES !== undefined,
    refetchInterval: REFETCH_MS,
  });
  return { reading: query.data, isLoading: query.isLoading, error: query.error, refresh: () => void query.refetch() };
}

export type IdentitySectionProps = {
  readonly subject: Address;
  /** Whose wallet holds, or would hold, the identity. The provider itself, or a mandate's owner. */
  readonly owner: Address | undefined;
  readonly kind: IdentityKind;
  /** The connected wallet is the owner and the address is in a state the card can describe. */
  readonly canRegister: boolean;
  /** Why registration is not offered, when `canRegister` is false and the wallet is the owner. */
  readonly heldBack?: string;
  readonly blockedBy: readonly AnyState[];
  readonly context?: TxContext;
};

export function IdentitySection(props: IdentitySectionProps) {
  const { subject, owner } = props;
  const { reading, isLoading, error, refresh } = useIdentity(subject, owner);

  if (REGISTRIES === undefined) return null;

  return (
    <Section title="Agent identity" description="An ERC-8004 identity on Robinhood Chain, listed on 8004scan and OpenSea.">
      <Card>
        <ErrorSurface error={error} action="Reading the identity registry" onRetry={refresh} />
        {isLoading && reading === undefined && <Skeleton height={56} />}
        {reading !== undefined && reading.identity !== undefined && (
          <Registered identity={reading.identity} others={reading.others} rulings={reading.rulings} {...props} onChanged={refresh} />
        )}
        {reading !== undefined && reading.identity === undefined && (
          <Unregistered reading={reading} {...props} onChanged={refresh} />
        )}
      </Card>
    </Section>
  );
}

function ExternalLink({ href, children }: { readonly href: string; readonly children: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {children}
    </a>
  );
}

function Registered({
  identity,
  others,
  rulings,
  kind,
  canRegister,
  blockedBy,
  context,
  onChanged,
}: IdentitySectionProps & {
  readonly identity: AgentIdentity;
  readonly others: readonly AgentIdentity[];
  readonly rulings: Reading['rulings'];
  readonly onChanged: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const whose = kind === 'provider' ? 'this provider' : "this mandate's agent";

  return (
    <div className="space-y-4">
      <FieldGrid columns={3}>
        <Field label="Agent" hint={`Token ${identity.agentId.toString()} in the AgentIdentity registry at ${shortAddress(identity.registry)}.`}>
          <span className="space-x-3">
            <span className="tabular">#{identity.agentId.toString()}</span>
            <ExternalLink href={identity.scanUrl}>8004scan</ExternalLink>
            <ExternalLink href={identity.openseaUrl}>OpenSea</ExternalLink>
            <ExternalLink href={identity.explorerUrl}>Registry</ExternalLink>
          </span>
        </Field>
        <Field label="Held by" hint={kind === 'provider' ? 'The provider wallet owns its identity.' : "The mandate owner's wallet holds the agent's identity."}>
          <AddressView value={identity.owner} />
        </Field>
        <Field label="Rulings posted" hint="Feedback from the resolver service on this agent, read from the reputation registry.">
          {rulings === undefined
            ? 'Not read'
            : rulings.count === 0
              ? 'None yet'
              : `${rulings.count} ${rulings.count === 1 ? 'ruling' : 'rulings'}, average ${rulings.average?.toFixed(0)} of 100`}
        </Field>
      </FieldGrid>

      <p className="text-detail text-[color:var(--color-muted)]">
        The identity resolves to{' '}
        <ExternalLink href={identity.pointsAtCard ? identity.cardUrl : identity.uri}>{identity.pointsAtCard ? 'the card this console serves' : 'its card'}</ExternalLink>
        {identity.pointsAtCard ? `, generated from the chain each time it is read: what ${whose} is, what it may do and where to reach it.` : '.'}
        {others.length > 0 && ` ${others.length} more ${others.length === 1 ? 'identity names' : 'identities name'} this address; the oldest is shown.`}
      </p>

      {!identity.pointsAtCard && (
        <div className="space-y-2 border-t border-[color:var(--color-line)] pt-4">
          <p className="text-detail text-[color:var(--color-muted)]">
            The identity does not point at the live card yet. Pointing it there keeps the listing, the score and the links on
            8004scan and OpenSea current.{canRegister ? '' : ' Only the wallet that holds the identity can change this.'}
          </p>
          {canRegister && (
            <TxButton
              label="Point it at the live card"
              tone="secondary"
              blockedBy={blockedBy}
              {...(context === undefined ? {} : { context })}
              send={() =>
                writeContractAsync({
                  address: identity.registry,
                  abi: SET_AGENT_URI_ABI,
                  functionName: 'setAgentURI',
                  args: [identity.agentId, identity.cardUrl],
                })
              }
              onContinue={onChanged}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Unregistered({
  reading,
  subject,
  owner,
  kind,
  canRegister,
  heldBack,
  blockedBy,
  context,
  onChanged,
}: IdentitySectionProps & { readonly reading: Reading; readonly onChanged: () => void }) {
  const { writeContractAsync } = useWriteContract();
  const [minted, setMinted] = useState<bigint | undefined>(undefined);
  const registry = REGISTRIES?.identity;
  if (registry === undefined) return null;

  if (minted !== undefined) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          Registered as agent <span className="tabular">#{minted.toString()}</span>. The desk reads it back from the registry when
          you continue; 8004scan and OpenSea pick it up within a few minutes.
        </p>
        <p className="space-x-3 text-detail">
          <ExternalLink href={`https://www.8004scan.io/agents/${REGISTRIES?.scanChain}/${minted.toString()}`}>8004scan</ExternalLink>
          <ExternalLink href={`https://opensea.io/item/${REGISTRIES?.openseaChain}/${registry.toLowerCase()}/${minted.toString()}`}>OpenSea</ExternalLink>
        </p>
        <Button
          size="sm"
          onClick={() => {
            setMinted(undefined);
            onChanged();
          }}
        >
          Read it again
        </Button>
      </div>
    );
  }

  if (!reading.searched) {
    return (
      <p className="text-sm text-[color:var(--color-muted)]">
        Could not reach the indexes that list identities by owner, so whether this address has one is unknown right now.
      </p>
    );
  }

  const noun = kind === 'provider' ? 'this provider' : "this mandate's agent";

  return (
    <div className="space-y-4">
      <p className="max-w-prose text-sm">
        No ERC-8004 identity names this address{owner === undefined ? '' : ` in ${shortAddress(owner)}'s wallet`}.{' '}
        {kind === 'provider'
          ? 'Registering mints one to the provider wallet and points it at a card this console serves from the listing: the handle, the stake, the score and the largest job a payer can open.'
          : "Registering mints one to the mandate owner's wallet and points it at a card this console serves from the mandate: the seated agent, the budget and the capabilities it may spend on."}{' '}
        One transaction, paid in ETH for gas and nothing else.
      </p>
      <p className="text-detail text-[color:var(--color-muted)]">
        Card: <ExternalLink href={reading.cardUrl}>{reading.cardUrl}</ExternalLink>
      </p>
      {canRegister ? (
        <TxButton
          label={kind === 'provider' ? 'Register the identity' : "Register the agent's identity"}
          tone="primary"
          blockedBy={blockedBy}
          {...(context === undefined ? {} : { context })}
          send={() =>
            writeContractAsync({
              address: registry,
              abi: REGISTER_WITH_METADATA_ABI,
              functionName: 'register',
              args: registrationArgs(subject, reading.cardUrl),
            })
          }
          onConfirmed={(receipt) => {
            const [id] = registeredIds(receipt);
            if (id === undefined) return;
            rememberHint(subject, id);
            setMinted(id);
          }}
          onContinue={() => {
            setMinted(undefined);
            onChanged();
          }}
        />
      ) : (
        heldBack !== undefined && <p className="text-detail text-[color:var(--color-muted)]">{heldBack}</p>
      )}
      <p className="text-detail text-[color:var(--color-muted)]">
        Rulings on contested jobs can be posted against {noun} as feedback in the ERC-8004 reputation registry, so a stranger reads
        the record where every other agent's is read.
      </p>
    </div>
  );
}
