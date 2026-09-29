'use client';

import type { Address as AddressValue } from 'viem';

import { BRSR_SUPPLY, TOKEN_ADDRESSES, TOKEN_ROLES, vestingAbi } from '@/chain';
import { Address } from '@/components/address';
import { Instant } from '@/components/instant';
import { Card, Field, FieldGrid, Section } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { Table } from '@/components/table';
import { TxButton } from '@/components/tx-button';
import { formatBrsr } from '@/money';
import type { Brsr } from '@/money';
import type { AnyState } from '@/state';

import type { TokenPageData } from './use-token-page';
import { useWriteContract } from '@/wallet/write';

type AllocationRow = {
  readonly key: string;
  readonly name: string;
  readonly allocation: bigint;
  readonly holder: AddressValue | null;
  readonly holderLabel: string;
  readonly terms: string;
  readonly heldNow: Brsr | undefined;
  /** Set where no wallet on this page can be read for a live balance. */
  readonly heldNote?: string;
};

export function SupplySection({ data, blockedBy }: { readonly data: TokenPageData; readonly blockedBy: readonly AnyState[] }) {
  const { token, extras } = data;
  // The hint under this figure says it comes from the token. Falling back to the constant in this
  // file when the token does not answer would make that line false, and every share below is a
  // percentage of it.
  const total = token?.totalSupply;
  const unread = token === undefined ? 'Reading' : 'Not read';

  const rows: readonly AllocationRow[] = [
    {
      key: 'community',
      name: 'Community and ecosystem',
      allocation: BRSR_SUPPLY.community,
      holder: TOKEN_ROLES.community,
      holderLabel: 'Token governance delay',
      terms: 'Staking rewards, resolver incentives and integration grants. Each release is a proposal that waits out the 48-hour delay on the token contracts.',
      heldNow: extras?.holders.community,
    },
    {
      key: 'team',
      name: 'Team',
      allocation: BRSR_SUPPLY.team,
      holder: TOKEN_ADDRESSES.Vesting,
      holderLabel: 'Vesting contract',
      terms: 'One grant on a four-year term with a one-year cliff. The contract holds it for the whole term.',
      heldNow: extras?.holders.team,
    },
    {
      key: 'treasury',
      name: 'Treasury',
      allocation: BRSR_SUPPLY.treasury,
      holder: TOKEN_ROLES.treasury,
      holderLabel: 'Treasury',
      terms: 'Protocol-owned. Spending it is a governance proposal.',
      heldNow: extras?.holders.treasury,
    },
    {
      key: 'liquidity',
      name: 'Liquidity',
      allocation: BRSR_SUPPLY.liquidity,
      holder: TOKEN_ROLES.liquidity,
      holderLabel: 'Liquidity key',
      terms: 'Reserved for the BRSR/USDG pool. That pool has not been initialised, so the share waits on this key.',
      heldNow: extras?.holders.liquidity,
    },
  ];

  return (
    <Section
      title="Supply"
      description="One billion BRSR, created in the token's constructor and split four ways in the same transaction."
    >
      <Card>
        <p className="max-w-3xl text-sm">
          The token has no owner, no minter, no pauser and no upgrade path. The whole supply exists already, and a mint
          is refused once the supply is non-zero. What changes over time is who holds each share, and each figure under
          Held today is that holder&rsquo;s balance, read from the token.
        </p>

        <div className="mt-4">
          <Table
            rows={rows}
            rowKey={(row) => row.key}
            caption="Supply allocation and the address holding each share"
            columns={[
              { key: 'name', header: 'Allocation', cell: (row) => <span className="font-medium">{row.name}</span> },
              {
                key: 'share',
                header: 'Share',
                align: 'right',
                cell: (row) =>
                  total === undefined ? (
                    <span className="text-[color:var(--color-muted)]">{unread}</span>
                  ) : (
                    <span className="tabular">{percent(row.allocation, total)}</span>
                  ),
              },
              {
                key: 'amount',
                header: 'BRSR',
                align: 'right',
                cell: (row) => <span className="tabular">{formatBrsr(row.allocation as Brsr, { maxDecimals: 0 })}</span>,
              },
              {
                key: 'holder',
                header: 'Held by',
                cell: (row) =>
                  row.holder ? <Address value={row.holder} label={row.holderLabel} /> : <span>{row.holderLabel}</span>,
              },
              {
                key: 'now',
                header: 'Held today',
                align: 'right',
                secondary: true,
                cell: (row) =>
                  row.heldNow === undefined ? (
                    <span className="text-[color:var(--color-muted)]">
                      {row.heldNote ?? (extras === undefined ? 'Reading' : 'Not read')}
                    </span>
                  ) : (
                    <span className="tabular">{formatBrsr(row.heldNow, { maxDecimals: 0 })}</span>
                  ),
              },
              {
                key: 'terms',
                header: 'Terms',
                secondary: true,
                cell: (row) => <span className="text-[color:var(--color-muted)]">{row.terms}</span>,
              },
            ]}
          />
        </div>

        <FieldGrid columns={3}>
          <Field label="Total supply" hint="Read from the token, not from this file.">
            {total === undefined ? (
              <span className="text-[color:var(--color-muted)]">{unread}</span>
            ) : (
              <span className="tabular">{formatBrsr(total, { maxDecimals: 0 })} BRSR</span>
            )}
          </Field>
          <Field label="Decimals" hint="USDG carries six. The two are never mixed.">
            18
          </Field>
          <Field label="Token address">
            <Address value={TOKEN_ADDRESSES.BRSR} />
          </Field>
        </FieldGrid>
      </Card>

      {token?.grant && <GrantCard data={data} blockedBy={blockedBy} />}
    </Section>
  );
}

/** Shown only to a wallet that holds a grant, which on this deployment is one address. */
function GrantCard({ data, blockedBy }: { readonly data: TokenPageData; readonly blockedBy: readonly AnyState[] }) {
  const grant = data.token?.grant;
  const { writeContractAsync } = useWriteContract();
  if (!grant) return null;

  const claimable = grant.claimable;
  const canClaim = claimable !== undefined && claimable > 0n;

  return (
    <Card title="Your grant" description="Held by the vesting contract. Nothing moves before the cliff.">
      <StatGrid columns={4}>
        <Stat label="Granted" value={`${formatBrsr(grant.total)} BRSR`} />
        <Stat label="Vested so far" value={grant.vested === undefined ? 'Not read' : `${formatBrsr(grant.vested)} BRSR`} />
        <Stat label="Claimed" value={`${formatBrsr(grant.claimed)} BRSR`} />
        <Stat label="Claimable now" value={claimable === undefined ? 'Not read' : `${formatBrsr(claimable)} BRSR`} />
      </StatGrid>

      <div className="mt-4">
        <FieldGrid columns={3}>
          <Field label="Term starts">
            <Instant at={grant.start} />
          </Field>
          <Field label="Cliff" hint="Nothing is claimable until this passes.">
            {grant.cliffAt === undefined ? <span className="text-[color:var(--color-muted)]">Not read</span> : <Instant at={grant.cliffAt} />}
          </Field>
          <Field label="Fully vested">
            {grant.endsAt === undefined ? <span className="text-[color:var(--color-muted)]">Not read</span> : <Instant at={grant.endsAt} />}
          </Field>
        </FieldGrid>
      </div>

      {grant.revokedAt && (
        <p className="mt-4 text-sm">
          This grant was revoked on <Instant at={grant.revokedAt} />. The schedule froze at the amount vested that
          instant, and what had already vested is still claimable.
        </p>
      )}

      <div className="mt-4">
        <TxButton
          label={canClaim ? `Claim ${formatBrsr(claimable)} BRSR` : 'Claim'}
          disabled={!canClaim}
          blockedBy={blockedBy}
          send={() => writeContractAsync({ address: TOKEN_ADDRESSES.Vesting, abi: vestingAbi, functionName: 'claim' })}
          onConfirmed={data.refresh}
        />
        {claimable === undefined && (
          <p className="mt-3 text-detail text-[color:var(--color-muted)]">
            The vesting contract did not answer what is claimable, so the claim is held back until the next reading
            lands.
          </p>
        )}
      </div>
    </Card>
  );
}

function percent(part: bigint, whole: bigint): string {
  if (whole === 0n) return '0%';
  const tenths = (part * 1000n) / whole;
  const value = Number(tenths) / 10;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}
