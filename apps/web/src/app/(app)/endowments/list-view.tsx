'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { Micro } from '@bursar/core';

import { ENDOWMENTS, readEndowments, sources } from '@/chain/endowments';
import type { EndowmentView } from '@/chain/endowments';
import { LevelBadge } from '@/components/badge';
import { Button } from '@/components/button';
import { Card, EmptyState, Section } from '@/components/layout';
import { Stat, StatGrid } from '@/components/stat';
import { Table } from '@/components/table';
import { bps, usd } from '@/money';

export function EndowmentsList() {
  const router = useRouter();
  const list = useQuery({ queryKey: ['bursar', 'endowments'], queryFn: readEndowments, refetchInterval: 30_000 });
  const rows = [...(list.data ?? [])].sort((a, b) => (a.state.nav === b.state.nav ? 0 : a.state.nav > b.state.nav ? -1 : 1));
  const total = rows.reduce((sum, row) => sum + row.state.nav, 0n);
  const drawn = rows.reduce((sum, row) => sum + row.state.drawn, 0n);
  const fees = rows.reduce((sum, row) => sum + row.state.fees, 0n);

  return (
    <div className="space-y-10">
      <Section
        title="Endowments"
        description="Fund an AI agent once. The principal stays invested in US stocks on Robinhood Chain, and the agent spends a yearly draw from it. Anyone can add to an endowment."
        actions={
          <Link href="/endowments/new">
            <Button tone="primary" size="sm">
              Endow an agent
            </Button>
          </Link>
        }
      >
        <Card>
          <StatGrid columns={4}>
            <Stat label="Endowments" value={list.data === undefined ? 'Reading' : rows.length.toString()} />
            <Stat label="Held for agents" value={usd(total as Micro)} hint="Principal in stocks and cash, at the feed price." />
            <Stat label="Drawn by agents" value={usd(drawn as Micro)} hint="Paid into their mandates so far." />
            <Stat label="Fees to the treasury" value={usd(fees as Micro)} hint="The protocol's share of each draw." />
          </StatGrid>
        </Card>
      </Section>

      {ENDOWMENTS === undefined ? (
        <EmptyState title="Endowments are not on this network">They run on Robinhood Chain.</EmptyState>
      ) : (
        <Section title="Ranked by principal" description="Accepted endowments rank above those still waiting for their agent's owner.">
          <Card>
            <Table<EndowmentView>
              caption="Endowments"
              rows={[...rows.filter((r) => r.state.accepted), ...rows.filter((r) => !r.state.accepted)]}
              rowKey={(row) => row.address}
              onRowClick={(row) => router.push(`/endowments/${row.address}`)}
              empty={list.isLoading ? 'Reading the endowments.' : 'No endowments yet. Be the first to endow an agent.'}
              columns={[
                { key: 'rank', header: '#', cell: (_, index) => <span className="tabular">{index + 1}</span>, width: '3rem' },
                { key: 'agent', header: 'Agent', cell: (row) => <span className="font-medium">Agent #{row.state.agentId.toString()}</span> },
                { key: 'nav', header: 'Principal', align: 'right', cell: (row) => <span className="tabular">{usd(row.state.nav as Micro)}</span> },
                {
                  key: 'draw',
                  header: 'Draw a year',
                  align: 'right',
                  cell: (row) => <span className="tabular">{usd(row.state.drawPerYear as Micro)}</span>,
                },
                { key: 'patrons', header: 'Patrons', align: 'right', cell: (row) => <span className="tabular">{row.state.patrons.toString()}</span> },
                {
                  key: 'earned',
                  header: 'Earned back',
                  align: 'right',
                  secondary: true,
                  cell: (row) => <span className="tabular">{usd(sources(row).earnedBack as Micro)}</span>,
                },
                {
                  key: 'holdings',
                  header: 'Holds',
                  secondary: true,
                  cell: (row) => row.holdings.map((h) => (row.holdings.length === 1 ? h.symbol : `${h.symbol} ${bps(h.weightBps)}`)).join(', '),
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (row) =>
                    row.state.frozen ? (
                      <LevelBadge level="attention">Paused</LevelBadge>
                    ) : row.state.accepted ? (
                      <LevelBadge level="ok">Drawing</LevelBadge>
                    ) : (
                      <LevelBadge level="unknown">Waiting to accept</LevelBadge>
                    ),
                },
              ]}
            />
          </Card>
        </Section>
      )}
    </div>
  );
}
