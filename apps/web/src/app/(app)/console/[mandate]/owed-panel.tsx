'use client';

import { ClaimOwedButton, owedExplanation } from '@/components/claim-owed';
import { Card, Section } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { usdExact } from '@/money';
import { transferGates } from '../lib/write-gates';
import { useMandateScope } from './mandate-scope';

/**
 * A payout the escrow kept aside for this mandate.
 *
 * A settlement pays every party at once, and when the token refuses one of those transfers,
 * usually because its issuer had frozen the address, the escrow books that leg as owed and pays
 * the rest. Nothing else brings it back: the mandate has no call of its own to collect with, so
 * the claim is open to anyone and pays only this mandate.
 */
export function OwedPanel() {
  const { address, account, system, connected, writeContext, refresh } = useMandateScope();
  const owed = system.snapshot?.escrow.owed;

  if (!account || owed === undefined || owed === 0n) return null;

  return (
    <Section title="Held for this mandate" description="Money owed to this mandate, held by the escrow until it can be sent.">
      <Card>
        <div className="space-y-4">
          <StatGrid columns={3}>
            <Stat
              label="Waiting to be claimed"
              value={usdExact(owed)}
              hint="Kept apart from open payments."
              level="attention"
            />
          </StatGrid>
          <p className="max-w-3xl text-detail text-[color:var(--color-muted)]">{owedExplanation('this mandate')}</p>
          {connected === undefined ? (
            <p className="text-detail text-[color:var(--color-muted)]">Connect a wallet to claim it. Any wallet can.</p>
          ) : (
            <ClaimOwedButton
              escrow={account.escrow}
              party={address}
              label="Claim it for this mandate"
              blockedBy={transferGates(system)}
              context={{ ...writeContext, amount: owed }}
              onClaimed={refresh}
            />
          )}
        </div>
      </Card>
    </Section>
  );
}
