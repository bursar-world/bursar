'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState } from 'react';
import type { Address } from 'viem';
import { useSignMessage, useSignTypedData } from 'wagmi';
import { committedMandateAccountAbi, micro } from '@bursar/core';
import type { TermsDocument } from '@bursar/sdk';

import { rhcClient } from '@/chain/client';
import { committedFactories, privateContracts, termsProblem } from '@/chain/private';
import { fundsKeyContext, shieldedContracts, shieldedHref } from '@/chain/shielded';
import { SHIELDED_TIMING_LINE, STEALTH_LIMIT_LINE, agentKeyFile, downloadFile, formatEth, ownerKeysFrom, scanOwnedMandates, sendFromStealth } from '@/chain/stealth';
import type { OwnedPrivateMandate, OwnerKeys } from '@/chain/stealth';
import { Address as AddressView } from '@/components/address';
import { Badge } from '@/components/badge';
import { Button } from '@/components/button';
import { Card, EmptyState, Field, FieldGrid, Section } from '@/components/layout';
import { usd } from '@/money';
import { useWalletAccount } from '@/wallet/account';
import { ConnectButton } from '@/wallet/connect-button';
import type { OpenedTerms } from '../[mandate]/committed-view';

// The terms view lives with the mandate page, which pulls in the SDK at load; this page loads it on demand.
const TermsView = dynamic(() => import('../[mandate]/committed-view').then((module) => module.TermsView));
const AmendTerms = dynamic(() => import('../[mandate]/committed-view').then((module) => module.AmendTerms));

type Found = { readonly keys: OwnerKeys; readonly mandates: readonly OwnedPrivateMandate[] };

/**
 * The owner's private mandates, recovered from public announcements.
 *
 * The wallet signs the viewing-key message and the funds-key request; the page derives the owner's
 * stealth keys, reads every scheme-1 announcement since the privacy contracts were deployed, and
 * keeps the ones those keys can open. The factories' lists then give the mandates each owner
 * address holds.
 */
export function PrivateOwnersView() {
  const { address: owner, isConnected } = useWalletAccount();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const contracts = privateContracts();
  const [found, setFound] = useState<Found | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const header = (
    <div className="space-y-2">
      <Link href="/console" className="font-mono text-label uppercase tracking-wide text-[color:var(--color-muted)] transition-colors hover:text-[color:var(--color-ink)]">
        All mandates
      </Link>
      <h1 className="page-title">Private mandates</h1>
      <p className="max-w-3xl text-detail text-[color:var(--color-muted)]">
        Mandates whose owner and agent are stealth addresses derived from your wallet’s keys. Only your wallet can find them.
      </p>
      <p className="max-w-3xl text-detail text-[color:var(--color-muted)]">{STEALTH_LIMIT_LINE}</p>
      {shieldedContracts() && <p className="max-w-3xl text-detail text-[color:var(--color-muted)]">{SHIELDED_TIMING_LINE}</p>}
    </div>
  );

  if (contracts === undefined) {
    return (
      <div className="space-y-8">
        {header}
        <EmptyState title="Private mandates are not available on this network yet." />
      </div>
    );
  }

  if (!isConnected || owner === undefined) {
    return (
      <div className="space-y-8">
        {header}
        <EmptyState title="Connect the wallet that created them." action={<ConnectButton />}>
          Your wallet’s signature finds them.
        </EmptyState>
      </div>
    );
  }

  const scan = async (keys?: OwnerKeys) => {
    setBusy(true);
    setProblem(undefined);
    try {
      let current = keys;
      if (!current) {
        const { fundsKeyTypedData, viewingKeyMessage } = await import('@bursar/sdk');
        const context = fundsKeyContext(owner);
        const viewing = await signMessageAsync({ message: viewingKeyMessage(owner) });
        current = await ownerKeysFrom(viewing, await signTypedDataAsync(fundsKeyTypedData(context)), context);
      }
      const mandates = await scanOwnedMandates({ keys: current.stealth, factories: committedFactories(contracts), fromBlock: BigInt(contracts.fromBlock) });
      setFound({ keys: current, mandates });
    } catch (error) {
      setProblem(
        error instanceof Error && error.name === 'FundsKeySignatureError'
          ? 'The second signature did not come from this wallet, so nothing was found. Smart contract wallets cannot use hidden owners.'
          : 'The search did not finish. A signature was declined or the network did not answer.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      {header}
      <Section
        title="Find them"
        description="Your wallet signs twice, at no cost. The first finds your private mandates and opens their terms. The second, which your wallet shows as controlling funds, creates the keys that act for them in this page. Sign it only here."
      >
        <Card>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <Button tone="primary" onClick={() => void scan(found?.keys)} disabled={busy}>
                {busy ? 'Searching' : found ? 'Search again' : 'Unlock and search'}
              </Button>
              {found && (
                <Button tone="quiet" onClick={() => setFound(undefined)}>
                  Forget the keys
                </Button>
              )}
            </div>
            {problem && (
              <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
                {problem}
              </p>
            )}
          </div>
        </Card>
      </Section>

      {found && (
        <Section title={found.mandates.length === 1 ? 'One private mandate' : `${found.mandates.length} private mandates`}>
          {found.mandates.length === 0 ? (
            <Card>
              <EmptyState title="No private mandate belongs to this wallet yet.">
                <Link href="/console/new" className="underline underline-offset-2">
                  Create one
                </Link>{' '}
                with private terms and a hidden owner.
              </EmptyState>
            </Card>
          ) : (
            <div className="space-y-4">
              {found.mandates.map((entry) => (
                <OwnedMandate key={entry.mandate} entry={entry} keys={found.keys} fromBlock={BigInt(contracts.fromBlock)} onChange={() => void scan(found.keys)} />
              ))}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

function OwnedMandate({
  entry,
  keys,
  fromBlock,
  onChange,
}: {
  readonly entry: OwnedPrivateMandate;
  readonly keys: OwnerKeys;
  readonly fromBlock: bigint;
  readonly onChange: () => void;
}) {
  const [opened, setOpened] = useState<OpenedTerms | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const ownerKey = entry.principal.privateKey;
  const terms = opened?.terms;

  const act = (work: () => Promise<void>) => async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      await work();
    } catch (error) {
      setProblem(error instanceof Error ? error.message.split('\n')[0] : String(error));
    } finally {
      setBusy(false);
    }
  };

  const readTerms = async (): Promise<TermsDocument> => {
    if (terms) return terms;
    const { latestSealedTerms, openTerms } = await import('@bursar/sdk');
    const sealed = await latestSealedTerms(rhcClient(), entry.mandate, fromBlock);
    if (!sealed) throw new Error('No private terms were found for this mandate.');
    try {
      const doc = await openTerms(keys.termsKey, {
        account: entry.mandate,
        version: sealed.version,
        termsCommitment: entry.termsCommitment,
        ciphertext: sealed.ciphertext,
      });
      setOpened({ terms: doc, termsKey: keys.termsKey });
      return doc;
    } catch (error) {
      throw new Error(termsProblem(error));
    }
  };

  const downloadKey = act(async () => {
    const agentKey = entry.agentMatch?.privateKey;
    if (!agentKey) throw new Error('This mandate’s agent is not one of your stealth addresses, so there is no key to download.');
    downloadFile(await agentKeyFile({ mandate: entry.mandate, privateKey: agentKey, terms: await readTerms(), fromBlock }));
  });

  const togglePause = act(async () => {
    if (!ownerKey) throw new Error('The owner key could not be recovered from your wallet.');
    await sendFromStealth(ownerKey, { address: entry.mandate, abi: committedMandateAccountAbi, functionName: 'setPaused', args: [!entry.paused] });
    onChange();
  });

  return (
    <Card
      title={
        <Link href={`/console/${entry.mandate}`} className="underline underline-offset-2">
          <AddressView value={entry.mandate} copy={false} explorer={false} />
        </Link>
      }
      actions={
        <div className="flex items-center gap-2">
          {entry.paused && <Badge>Paused</Badge>}
          {entry.revoked && <Badge>Revoked</Badge>}
          <span className="tabular text-sm">{usd(micro(entry.balance))}</span>
        </div>
      }
    >
      <div className="space-y-4">
        <FieldGrid columns={2}>
          <Field label="Owner address" hint={`Gas: ${formatEth(entry.ownerGas)}. Pausing and resuming are sent from this address.`}>
            <AddressView value={entry.principal.stealthAddress as Address} />
          </Field>
          <Field
            label="Agent address"
            hint={entry.agentMatch ? `Gas: ${formatEth(entry.agentGas)}. One of your stealth addresses.` : 'Not one of your stealth addresses.'}
          >
            <AddressView value={entry.agent} />
          </Field>
        </FieldGrid>
        {opened && <TermsView terms={opened.terms} onLock={() => setOpened(undefined)} />}
        {opened && ownerKey && !entry.revoked && (
          <AmendTerms
            mandate={entry.mandate}
            opened={opened}
            version={entry.version}
            fromBlock={fromBlock}
            send={async (args) => {
              await sendFromStealth(ownerKey, { address: entry.mandate, abi: committedMandateAccountAbi, functionName: 'amend', args });
            }}
            onAmended={(next) => {
              setOpened({ terms: next, termsKey: opened.termsKey });
              onChange();
            }}
          />
        )}
        <div className="flex flex-wrap gap-3">
          {!terms && (
            <Button size="sm" onClick={act(async () => void (await readTerms()))} disabled={busy}>
              Show the terms
            </Button>
          )}
          <Button size="sm" onClick={downloadKey} disabled={busy || !entry.agentMatch}>
            Download the agent key
          </Button>
          <Button size="sm" onClick={togglePause} disabled={busy || entry.revoked || entry.ownerGas === 0n}>
            {entry.paused ? 'Resume spending' : 'Pause spending'}
          </Button>
          {shieldedContracts() && (
            <>
              <Link href={shieldedHref('mandate', entry.mandate)}>
                <Button size="sm">Fund from shielded funds</Button>
              </Link>
              <Link href={shieldedHref('stealth-owner', entry.principal.stealthAddress as Address)}>
                <Button size="sm">Send the owner gas from shielded funds</Button>
              </Link>
            </>
          )}
        </div>
        {entry.ownerGas === 0n && (
          <p className="text-detail text-[color:var(--color-muted)]">The owner address has no gas, so it cannot pause or resume yet. Send it some ETH first.</p>
        )}
        {problem && (
          <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
            {problem}
          </p>
        )}
      </div>
    </Card>
  );
}
