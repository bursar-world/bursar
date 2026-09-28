'use client';

import { ADDRESSES, TOKEN_ADDRESSES } from '@/chain';
import { isZeroAddress, sameAddress } from '@/chain/rhc';
import { Address } from '@/components/address';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { formatDuration } from '@/lib';
import { bps, formatBrsr } from '@/money';

import type { TokenPageData } from './use-token-page';

const STATUS_WORD: Readonly<Record<number, string>> = {
  0: 'Not registered',
  1: 'Active',
  2: 'Leaving',
  3: 'Exited',
};

/**
 * Resolver bonds, as the two contracts that decide them answer right now.
 *
 * A resolver rules on a contested delivery, and the bond is what a bad ruling costs them. The
 * registry names the currency and holds what is posted; the floor is a separate reading at the
 * staking pool the registry points to, and the registry reads it live on every vote. Both are on
 * the page because either one alone describes a dispute layer that does not exist: a floor with no
 * collateral wired, or a currency no amount of which is enough.
 */
export function BondingSection({ data }: { readonly data: TokenPageData }) {
  const bond = data.extras?.bonding;
  // Before the first reading lands these are on their way. After it lands, a missing figure is a
  // call the dispute registry did not answer.
  const unread = data.extras === undefined ? 'Reading' : 'Not read';
  const floor = bond?.minBondBrsr;
  const floorSet = floor !== undefined && floor > 0n;
  const wired = bond?.bondAsset !== undefined && !isZeroAddress(bond.bondAsset);
  const bondsInBrsr = wired && sameAddress(bond?.bondAsset, TOKEN_ADDRESSES.BRSR);
  const registered = bond?.yourStatus !== undefined && bond.yourStatus !== 0;

  return (
    <Section title="Resolver bonds" description="What a resolver stands to lose for ruling badly on a disputed delivery.">
      <Card title="Bonds today" description="Held by the dispute registry, in the currency it names.">
        <FieldGrid columns={4}>
          <Field label="Minimum bond" hint="Below this a resolver cannot register and cannot vote.">
            <span className="tabular">
              {floor === undefined ? unread : floorSet ? `${formatBrsr(floor)} BRSR` : 'None set'}
            </span>
          </Field>
          <Field label="Bonded across all resolvers">
            <span className="tabular">
              {bond?.totalBonded === undefined ? unread : `${formatBrsr(bond.totalBonded)} BRSR`}
            </span>
          </Field>
          <Field label="Taken for a bad ruling" hint="Share of the bond slashed when a resolver rules outside the accepted range.">
            <span className="tabular">{bond?.slashBps === undefined ? unread : bps(bond.slashBps)}</span>
          </Field>
          <Field label="Exit wait" hint="A bond cannot leave while the resolver has an open vote.">
            {bond?.unbondingPeriod === undefined ? unread : formatDuration(Number(bond.unbondingPeriod))}
          </Field>
          <Field label="Votes needed to settle a dispute">
            <span className="tabular">{bond?.quorum ?? unread}</span>
          </Field>
          <Field label="Most voters on one dispute" hint="Bounds what a single dispute can cost the roster.">
            <span className="tabular">{bond?.maxVoters ?? unread}</span>
          </Field>
          <Field label="Dispute registry">
            <Address value={ADDRESSES.oracleRegistry} />
          </Field>
          <Field label="Bond asset" hint="Read from the registry, never assumed. Bonds and rewards are different tokens.">
            {bond?.bondAsset === undefined ? (
              unread
            ) : wired ? (
              <Address value={bond.bondAsset} label={bondsInBrsr ? 'BRSR' : undefined} />
            ) : (
              'None wired'
            )}
          </Field>
        </FieldGrid>
      </Card>

      <Card title="The bond is BRSR" description="Governance sets the floor at the staking contract, and the registry reads it on every vote.">
        <FieldGrid columns={3}>
          <Field label="BRSR floor" hint="A floor of zero refuses a bond at any amount, whatever else is wired.">
            <span className="tabular">{floor === undefined ? unread : `${formatBrsr(floor)} BRSR`}</span>
          </Field>
          <Field label="Bonding in BRSR" hint="Open once the registry holds BRSR as its bond asset and the floor is above zero.">
            {bond?.minBondBrsr === undefined || bond.bondAsset === undefined
              ? unread
              : !wired
                ? 'No collateral wired'
                : !bondsInBrsr
                  ? 'The registry bonds in another token'
                  : floorSet
                    ? 'Open'
                    : 'Refused at any amount'}
          </Field>
          <Field label="Where the floor lives">
            <Address value={TOKEN_ADDRESSES.Staking} label="Staking contract" />
          </Field>
        </FieldGrid>

        <div className="mt-4 max-w-3xl space-y-3 text-sm">
          <p>
            Putting the bond in BRSR makes the token the security budget of the dispute layer. A resolver who rules
            badly loses BRSR, which is the version of &ldquo;the token secures the network&rdquo; that can be checked
            against a contract.
          </p>
          <p>
            The cost of that is real. A bond denominated in a volatile asset can fall below the value it secures, and
            governance can raise the floor after the fact but cannot raise it faster than a price moves. The answer here
            is a floor governance tunes, plus a higher floor it can set against an individual resolver. A price feed
            would make adjudication depend on an oracle the dispute layer otherwise does not need, which is the
            dependency it exists to avoid.
          </p>
        </div>
      </Card>

      {data.account !== undefined && (
        <Card title="Your resolver record" description="Read against the connected wallet.">
          <FieldGrid columns={4}>
            <Field label="Standing">{bond?.yourStatus === undefined ? unread : (STATUS_WORD[bond.yourStatus] ?? 'Unknown')}</Field>
            <Field label="Bond posted">
              <span className="tabular">{bond?.yourBond === undefined ? unread : `${formatBrsr(bond.yourBond)} BRSR`}</span>
            </Field>
            <Field label="Disputes settled">
              <span className="tabular">{bond?.yourFinalized ?? unread}</span>
            </Field>
            <Field label="Times slashed">
              <span className="tabular">{bond?.yourSlashes ?? unread}</span>
            </Field>
            <Field label="BRSR floor set against you" hint="Governance can require more from one resolver than from the roster.">
              <span className="tabular">
                {bond?.yourFloorBrsr === undefined ? unread : `${formatBrsr(bond.yourFloorBrsr)} BRSR`}
              </span>
            </Field>
            <Field label="Barred from bonding">
              {bond?.bondingDenied === undefined ? unread : bond.bondingDenied ? 'Yes' : 'No'}
            </Field>
          </FieldGrid>

          {!registered && bond?.yourStatus !== undefined && (
            <p className="mt-4 text-detail text-[color:var(--color-muted)]">
              This wallet is not a resolver. Registering happens at the dispute registry and needs a bond at or above
              the minimum above, in the currency named there.
            </p>
          )}
        </Card>
      )}
    </Section>
  );
}
