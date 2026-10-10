'use client';

import { useQuery } from '@tanstack/react-query';
import { assistantConnectMessage, assistantDisconnectMessage } from '@bursar/sdk';
import Link from 'next/link';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Address } from 'viem';
import { parseEther } from 'viem';
import { useSendTransaction, useSignMessage } from 'wagmi';

import { mandateAccountAbi } from '@/chain/abi';
import { CHAIN_ID, sameAddress } from '@/chain/rhc';
import { Address as AddressView, CopyControl } from '@/components/address';
import { Button } from '@/components/button';
import { ErrorSurface } from '@/components/error-surface';
import { TextField } from '@/components/fields';
import { Instant } from '@/components/instant';
import { Card, Section } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { useWriteContract } from '@/wallet/write';
import { CUSTODY_LINE, TOKEN_ONCE_LINE, connectFields, createConnection, hostUnavailable, listConnections, revokeConnection, visibleConnections } from '../lib/assistants';
import type { CreatedConnection, PublicConnection } from '../lib/assistants';
import { callGates } from '../lib/write-gates';
import { ConnectorSettingsView } from './connector-settings';
import { useMandateScope } from './mandate-scope';

/**
 * Connecting ChatGPT, Claude or Gemini to this mandate.
 *
 * Three steps, in the order the owner takes them. The owner signs a message, which is how the
 * host knows the request came from the mandate's principal; the host answers with an agent
 * address it made a key for, and the token that reaches it. The owner seats that agent on the
 * mandate, which is the same transaction as seating any other. Then the assistant is pointed at
 * the endpoint. The token is shown once and nowhere else.
 */
export function AssistantPanel() {
  const { address, account, system, isOwner, connected, writeContext, refresh } = useMandateScope();
  const { signMessageAsync } = useSignMessage();
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<CreatedConnection | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState<'create' | string | undefined>(undefined);

  const connections = useQuery({
    queryKey: ['console', 'assistants', address],
    queryFn: () => listConnections(address),
    retry: false,
    refetchInterval: 60_000,
  });

  if (!account) return null;

  const unavailable = hostUnavailable(connections.error);
  const seatedAgent = account.agent;

  async function connect(): Promise<void> {
    if (connected === undefined) return;
    setBusy('create');
    setFailure(undefined);
    try {
      const fields = connectFields({ mandate: address, owner: connected, chainId: CHAIN_ID, label });
      const signature = await signMessageAsync({ message: assistantConnectMessage(fields) });
      const result = await createConnection(fields, signature);
      setCreated(result);
      setLabel('');
      void connections.refetch();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(undefined);
    }
  }

  async function disconnect(connection: PublicConnection): Promise<void> {
    if (connected === undefined) return;
    setBusy(connection.id);
    setFailure(undefined);
    try {
      const fields = connectFields({ mandate: address, owner: connected, chainId: CHAIN_ID });
      const signature = await signMessageAsync({ message: assistantDisconnectMessage({ ...fields, connection: connection.id }) });
      await revokeConnection(connection.id, fields, signature);
      if (created?.connection.id === connection.id) setCreated(undefined);
      void connections.refetch();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Section
      title="Assistants"
      description="Let ChatGPT, Claude or Gemini pay from this mandate, inside its limits."
      actions={
        <Link href="/demo/assistants" className="text-detail underline underline-offset-2">
          How it works
        </Link>
      }
    >
      <Card>
        <div className="space-y-6">
          <p className="max-w-3xl text-sm">{CUSTODY_LINE}</p>

          {unavailable ? (
            <p className="text-detail text-[color:var(--color-muted)]">Hosted connections are not available on this deployment.</p>
          ) : (
            <ConnectionList
              connections={visibleConnections(connections.data ?? [])}
              seatedAgent={seatedAgent}
              error={connections.isError && !unavailable ? connections.error : undefined}
              onRetry={() => void connections.refetch()}
              action={(connection) =>
                isOwner && connection.status === 'active' ? (
                  <Button size="sm" tone="quiet" disabled={busy !== undefined} onClick={() => void disconnect(connection)}>
                    {busy === connection.id ? 'Signing' : 'Disconnect'}
                  </Button>
                ) : null
              }
            />
          )}

          {isOwner && !unavailable && created === undefined && (
            <div className="space-y-3 border-t border-[color:var(--color-line)] pt-6">
              <div>
                <h3 className="text-sm font-semibold">Connect an assistant</h3>
                <p className="mt-0.5 text-detail text-[color:var(--color-muted)]">
                  Sign a message proving you own this mandate. The host makes an agent for it and gives you the token your
                  assistant connects with. Nothing is sent on chain until you seat the agent.
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <TextField label="Label" value={label} onChange={setLabel} placeholder="ChatGPT, Claude on my laptop" help="Optional. Shown in this list." />
                </div>
                <Button tone="primary" disabled={busy !== undefined || connected === undefined} onClick={() => void connect()}>
                  {busy === 'create' ? 'Signing' : 'Create connection'}
                </Button>
              </div>
            </div>
          )}

          {created !== undefined && (
            <CreatedSteps
              created={created}
              seated={sameAddress(seatedAgent, created.connection.agent)}
              seat={
                <TxButton
                  key={created.connection.id}
                  label={seatedAgent && !/^0x0+$/u.test(seatedAgent) ? 'Replace the agent' : 'Seat the agent'}
                  blockedBy={callGates(system)}
                  context={writeContext}
                  send={() => writeContractAsync({ address, abi: mandateAccountAbi, functionName: 'setAgent', args: [created.connection.agent as Address] })}
                  onConfirmed={refresh}
                />
              }
              fees={
                <TxButton
                  key={`${created.connection.id}-fees`}
                  label={`Send ${FEE_FLOAT_ETH} ETH for fees`}
                  tone="secondary"
                  blockedBy={callGates(system)}
                  context={writeContext}
                  send={() => sendTransactionAsync({ to: created.connection.agent as Address, value: parseEther(FEE_FLOAT_ETH), chainId: CHAIN_ID })}
                />
              }
              onDone={() => setCreated(undefined)}
            />
          )}

          {failure !== undefined && <ErrorSurface error={failure} action="Connecting the assistant" onRetry={() => setFailure(undefined)} retryLabel="Dismiss" />}
        </div>
      </Card>
    </Section>
  );
}

export function ConnectionList({
  connections,
  seatedAgent,
  error,
  onRetry,
  action,
}: {
  readonly connections: readonly PublicConnection[];
  readonly seatedAgent: Address | undefined;
  readonly error?: unknown;
  readonly onRetry?: () => void;
  readonly action?: (connection: PublicConnection) => ReactNode;
}) {
  if (error !== undefined) return <ErrorSurface error={error} action="Reading the connections" {...(onRetry ? { onRetry } : {})} />;
  if (connections.length === 0) return <p className="text-detail text-[color:var(--color-muted)]">No assistant is connected to this mandate.</p>;

  return (
    <ul className="divide-y divide-[color:var(--color-line)]">
      {connections.map((connection) => {
        const seated = sameAddress(seatedAgent, connection.agent);
        return (
          <li key={connection.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm">
                {connection.label ?? 'Assistant'}{' '}
                <span className="text-[color:var(--color-muted)]">
                  {connection.status === 'revoked' ? 'Disconnected' : seated ? 'Seated as the agent' : 'Not seated. It cannot spend until you seat it.'}
                </span>
              </div>
              <div className="text-detail text-[color:var(--color-muted)]">
                Agent <AddressView value={connection.agent} /> · connected <Instant at={new Date(connection.createdAt)} relative local />
              </div>
            </div>
            {action?.(connection)}
          </li>
        );
      })}
    </ul>
  );
}

/** Enough ETH for a few hundred payments at this chain's fees, and small enough to leave behind. */
export const FEE_FLOAT_ETH = '0.0005';

export function CreatedSteps({
  created,
  seated,
  seat,
  fees,
  onDone,
}: {
  readonly created: CreatedConnection;
  readonly seated: boolean;
  readonly seat: ReactNode;
  readonly fees?: ReactNode;
  readonly onDone: () => void;
}) {
  return (
    <div className="space-y-6 border-t border-[color:var(--color-line)] pt-6">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">1. The agent</h3>
        <p className="text-detail text-[color:var(--color-muted)]">
          The host made this agent for {created.connection.label ?? 'your assistant'}. It holds the key; the mandate holds the limits.
        </p>
        <div className="font-mono text-note">
          <AddressView value={created.connection.agent} full />
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">2. Seat it on this mandate</h3>
        <p className="text-detail text-[color:var(--color-muted)]">
          {seated ? 'Seated. The assistant spends within the limits from now on.' : 'One transaction. The assistant can spend nothing until it lands.'}
        </p>
        {!seated && seat}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">3. Give it ETH for network fees</h3>
        <p className="text-detail text-[color:var(--color-muted)]">
          The agent sends each payment from its own address and pays the network fee in ETH. USDG stays in the mandate; the
          agent never holds any. {FEE_FLOAT_ETH} ETH covers a few hundred payments.
        </p>
        {fees}
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">4. Connect your assistant</h3>
        <div className="space-y-1">
          <div className="text-label uppercase tracking-wide text-[color:var(--color-muted)]">Token</div>
          <div className="flex items-center gap-2">
            <code className="break-all font-mono text-note">{created.token}</code>
            <CopyControl value={created.token} label="Copy the token" />
          </div>
          <p className="text-note text-[color:var(--color-state-blocked)]">{TOKEN_ONCE_LINE}</p>
        </div>
        <ConnectorSettingsView settings={created.settings} />
      </div>

      <Button tone="secondary" onClick={onDone}>
        Done, I have copied it
      </Button>
    </div>
  );
}
