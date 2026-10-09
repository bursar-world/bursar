'use client';

import { ADDRESSES, TOKEN_ADDRESSES, closedBench } from '@/chain';
import { isZeroAddress, sameAddress } from '@/chain/rhc';
import { Address } from '@/components/address';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { spellDuration } from '@/lib';
import { bps, formatBrsr } from '@/money';

import type { TokenPageData } from './use-token-page';

/** The registry seats at most this many resolvers, whatever its rules say. */
const ROSTER = 64;

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
  const closed = closedBench(floor);
  const wired = bond?.bondAsset !== undefined && !isZeroAddress(bond.bondAsset);
  const bondsInBrsr = wired && sameAddress(bond?.bondAsset, TOKEN_ADDRESSES.BRSR);
  const registered = bond?.yourStatus !== undefined && bond.yourStatus !== 0;

  return (
    <Section title="Resolver bonds" description="Resolvers bond BRSR to rule on disputes, and a bad ruling costs part of it.">
      <Card title="Bonds today" description="Held by the dispute registry.">
        <FieldGrid columns={4}>
          <Field
            label="Minimum bond"
            hint={
              closed
                ? 'Set at the whole supply, so no new address can bond. Each admitted resolver bonds against its own floor.'
                : 'Below this a resolver cannot register or vote.'
            }
          >
            {closed ? (
              'Closed to new resolvers'
            ) : (
              <span className="tabular">{floor === undefined ? unread : floorSet ? `${formatBrsr(floor)} BRSR` : 'None set'}</span>
            )}
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
            {bond?.unbondingPeriod === undefined ? unread : spellDuration(Number(bond.unbondingPeriod))}
          </Field>
          <Field label="Votes needed to settle a dispute">
            <span className="tabular">{bond?.quorum ?? unread}</span>
          </Field>
          <Field label="Most voters on one dispute" hint={votersHint(bond?.maxVoters)}>
            <span className="tabular">{bond?.maxVoters ?? unread}</span>
          </Field>
          <Field label="Dispute registry">
            <Address value={ADDRESSES.oracleRegistry} />
          </Field>
          <Field label="Bond asset" hint="Bonds and rewards use different tokens.">
            {bond?.bondAsset === undefined ? (
              unread
            ) : wired ? (
              <Address value={bond.bondAsset} label={bondsInBrsr ? 'BRSR' : undefined} />
            ) : (
              'None set'
            )}
          </Field>
        </FieldGrid>
      </Card>

      <Card title="The bond is BRSR" description="Governance sets the floor in the staking contract, and every vote checks it.">
        <FieldGrid columns={3}>
          <Field label="BRSR floor" hint={closed ? 'The whole supply, which no new address can post.' : 'A floor of zero refuses every bond.'}>
            <span className="tabular">{floor === undefined ? unread : `${formatBrsr(floor, { minDecimals: 0 })} BRSR`}</span>
          </Field>
          <Field
            label="Bonding in BRSR"
            hint={
              closed
                ? 'Admitted resolvers bond under floors set for each of them.'
                : 'Open once the registry holds BRSR as its bond asset and the floor is above zero.'
            }
          >
            {bond?.minBondBrsr === undefined || bond.bondAsset === undefined
              ? unread
              : !wired
                ? 'No bond asset set'
                : !bondsInBrsr
                  ? 'The registry bonds in another token'
                  : closed
                    ? 'Closed to new resolvers'
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
            With bonds in BRSR, a resolver who rules badly loses BRSR. The penalty is enforced by contract and
            verifiable on-chain.
          </p>
          <p>
            A bond&rsquo;s value moves with the BRSR price. Governance sets the floor, and can set a different one for an
            individual resolver.
          </p>
        </div>
      </Card>

      {data.account !== undefined && (
        <Card title="Your resolver record" description="For the connected wallet.">
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
            <Field label="BRSR floor set against you" hint="Governance can set a higher floor for one resolver.">
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
              {closed
                ? 'This wallet is not a resolver. Resolvers are admitted by governance, each with a floor of its own.'
                : 'This wallet is not a resolver. Register from the Resolvers page with at least the minimum bond above.'}
            </p>
          )}
        </Card>
      )}
    </Section>
  );
}

function votersHint(maxVoters: number | undefined): string {
  return maxVoters !== undefined && maxVoters >= ROSTER
    ? `Every bonded resolver can vote on every dispute, up to ${ROSTER}.`
    : `At most this many resolvers can vote on one dispute, from a roster of up to ${ROSTER}.`;
}
