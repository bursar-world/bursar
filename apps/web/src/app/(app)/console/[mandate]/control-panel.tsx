'use client';

import { useState } from 'react';
import type { Address } from 'viem';

import { mandateAccountAbi } from '@/chain/abi';
import { isZeroAddress } from '@/chain/rhc';
import { Address as AddressView } from '@/components/address';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { TxButton } from '@/components/tx-button';
import { AddressInput, readAddress } from '@/components/address-input';
import { callGates } from '../lib/write-gates';
import { useMandateScope } from './mandate-scope';
import { useWriteContract } from '@/wallet/write';

/**
 * The two controls that stop an agent, and the one that starts it.
 *
 * Both take effect in the block they land in. Neither touches money already locked in the escrow:
 * a provider that has delivered still gets paid, which is the correct behaviour and worth saying
 * plainly on the screen where somebody is about to hit the switch.
 */
export function ControlPanel() {
  const { address, account, system, isOwner, writeContext, refresh } = useMandateScope();
  const { writeContractAsync } = useWriteContract();
  const [agentText, setAgentText] = useState('');

  if (!account) return null;

  const nextAgent = readAddress(agentText).value;
  const seated = !isZeroAddress(account.agent);
  // None of these three moves USDG, so none of them is gated on the token. A pause is the control
  // an owner reaches for when the asset itself is in trouble.
  const blockedBy = callGates(system);
  const sameAgent = nextAgent !== undefined && nextAgent.toLowerCase() === account.agent.toLowerCase();

  return (
    <Section title="Controls" description="Who spends from this mandate, and how to stop them.">
      <Card>
        <div className="space-y-6">
          <FieldGrid columns={2}>
            <Field label="Agent" hint={seated ? 'Spends inside the limits and can do nothing else.' : 'Nothing can spend from this mandate.'}>
              {seated ? <AddressView value={account.agent} /> : 'No agent seated'}
            </Field>
            <Field label="Mandate" hint={account.paused ? 'Every payment is refused while this is true.' : 'Payments are accepted, subject to the limits.'}>
              {account.paused ? 'Paused' : 'Running'}
            </Field>
          </FieldGrid>

          {isOwner && (
            <div className="grid grid-cols-1 gap-6 border-t border-[color:var(--color-line)] pt-6 sm:grid-cols-2">
              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold">{account.paused ? 'Resume the mandate' : 'Pause the mandate'}</h3>
                  <p className="mt-0.5 text-detail text-[color:var(--color-muted)]">
                    {account.paused
                      ? 'The agent can spend again, inside the limits that were already set. Nothing about them changed while it was paused.'
                      : 'Every new payment is refused from the block this lands in. Money already held by the escrow settles as it would have, and the limits are untouched.'}
                  </p>
                </div>
                <TxButton
                  label={account.paused ? 'Resume' : 'Pause'}
                  tone={account.paused ? 'primary' : 'destructive'}
                  blockedBy={blockedBy}
                  context={writeContext}
                  {...(account.paused
                    ? {}
                    : {
                        confirmPhrase: 'PAUSE',
                        confirmTitle: 'Pause this mandate',
                        confirmDescription: 'The agent stops spending immediately. You can resume it from this screen.',
                      })}
                  send={() =>
                    writeContractAsync({
                      address,
                      abi: mandateAccountAbi,
                      functionName: 'setPaused',
                      args: [!account.paused],
                    })
                  }
                  onConfirmed={refresh}
                />
              </div>

              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold">Revoke the agent</h3>
                  <p className="mt-0.5 text-detail text-[color:var(--color-muted)]">
                    The agent address is cleared and the mandate spends nothing. The funds stay where they are and the
                    limits stay as written. Seating an agent again is what puts it back to work.
                  </p>
                </div>
                <TxButton
                  label="Revoke"
                  tone="destructive"
                  disabled={!seated && account.revoked}
                  blockedBy={blockedBy}
                  context={writeContext}
                  confirmPhrase="REVOKE"
                  confirmTitle="Revoke the agent"
                  confirmDescription="Every new payment is refused from the block this lands in. Payments already locked in the escrow settle as they would have."
                  send={() =>
                    writeContractAsync({ address, abi: mandateAccountAbi, functionName: 'revokeAgent' })
                  }
                  onConfirmed={refresh}
                />
              </div>

              <div className="space-y-3 sm:col-span-2">
                <div>
                  <h3 className="text-sm font-semibold">{seated ? 'Replace the agent' : 'Seat an agent'}</h3>
                  <p className="mt-0.5 text-detail text-[color:var(--color-muted)]">
                    The new address spends inside the same limits from the block this lands in, and what has already
                    been spent this window stays spent.
                  </p>
                </div>
                <AddressInput
                  label="Agent address"
                  value={agentText}
                  onChange={setAgentText}
                  {...(sameAgent ? { problem: 'This address is already the agent on this mandate.' } : {})}
                  action={
                    <TxButton
                      label={seated ? 'Replace' : 'Seat'}
                      disabled={nextAgent === undefined || sameAgent}
                      blockedBy={blockedBy}
                      context={writeContext}
                      {...(seated
                        ? {
                            confirmPhrase: 'REPLACE',
                            confirmTitle: 'Replace the agent',
                            confirmDescription: 'The address seated now loses the mandate in the same transaction.',
                          }
                        : {})}
                      send={() =>
                        writeContractAsync({
                          address,
                          abi: mandateAccountAbi,
                          functionName: 'setAgent',
                          args: [nextAgent as Address],
                        })
                      }
                      onConfirmed={() => {
                        setAgentText('');
                        refresh();
                      }}
                    />
                  }
                />
              </div>
            </div>
          )}
        </div>
      </Card>
    </Section>
  );
}
