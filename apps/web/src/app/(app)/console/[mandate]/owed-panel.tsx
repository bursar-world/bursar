'use client';

import { ClaimOwedButton } from '@/components/claim-owed';
import { Card, Section } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { usdExact } from '@/money';
import { transferGates } from '../lib/write-gates';
import { useMandateScope } from './mandate-scope';

/**
 * A payout the escrow kept aside for this mandate.
 *
 * A settlement pays every party at once, and when the token refuses one of those transfers,
 * usually because its issuer had frozen the address, the escrow books that leg as owed instead of
 * holding up the rest. Nothing else brings it back: the mandate has no call of its own to collect
 * with, so the claim is open to anyone and pays only this mandate.
 */
export function OwedPanel() {
  const { address, account, system, connected, writeContext, refresh } = useMandateScope();
  const owed = system.snapshot?.escrow.owed;

  if (!account || owed === undefined || owed === 0n) return null;

  return (
    <Section title="Held for this mandate" description="A payout the escrow could not deliver when a payment settled.">
      <Card>
        <div className="space-y-4">
          <StatGrid columns={3}>
            <Stat
              label="Waiting to be claimed"
              value={usdExact(owed)}
              hint="Held by the escrow for this mandate, apart from every open payment."
              level="attention"
            />
          </StatGrid>
          <p className="max-w-3xl text-detail text-[color:var(--color-muted)]">
            When the payment settled, USDG refused the transfer to this mandate, which is what happens while the token
            issuer has frozen an address. The escrow kept the amount for it rather than hold up the rest of the
            settlement. Claiming it sends the whole amount here, and it goes through once USDG will move to this address
            again. Anyone can send the claim; the money only ever goes to this mandate.
          </p>
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
