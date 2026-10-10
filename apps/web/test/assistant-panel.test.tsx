import { renderToStaticMarkup } from 'react-dom/server';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import { ConnectionList, CreatedSteps } from '@/app/(app)/console/[mandate]/assistant-panel';
import { ConnectorSettingsView } from '@/app/(app)/console/[mandate]/connector-settings';
import { CUSTODY_LINE, REVOKED_SHOWN_MS, TOKEN_ONCE_LINE, connectFields, visibleConnections } from '@/app/(app)/console/lib/assistants';
import type { ConnectorSettings, CreatedConnection } from '@/app/(app)/console/lib/assistants';

const TOKEN = 'bmcp_' + 'A'.repeat(43);
const AGENT = '0x877c349EFb5926082C413833E8055F0991185c61' as const;
const MANDATE = '0xF77c7c2d6c04Bad8a9cf013df952726Dc381183C' as const;
const OWNER = '0x2176977dD7010927c9492CFf765bc766A16d5f99' as const;

const settings: ConnectorSettings = {
  endpoint: 'https://mcp.bursar.world/mcp',
  endpointWithToken: `https://mcp.bursar.world/mcp/${TOKEN}`,
  chatgpt: { name: 'Bursar', url: `https://mcp.bursar.world/mcp/${TOKEN}`, authentication: 'No authentication', steps: ['Open Settings, then Connectors, then Create.'] },
  claude: { name: 'Bursar', url: `https://mcp.bursar.world/mcp/${TOKEN}`, steps: ['Open Settings, then Connectors, then Add custom connector.'] },
  claudeCode: { command: `claude mcp add --transport http bursar https://mcp.bursar.world/mcp --header "Authorization: Bearer ${TOKEN}"` },
  gemini: { settings: `{"mcpServers":{"bursar":{"httpUrl":"https://mcp.bursar.world/mcp","headers":{"Authorization":"Bearer ${TOKEN}"}}}}`, steps: ['Add the block under mcpServers.'] },
};

const created: CreatedConnection = {
  connection: { id: '0b1f2c3d-0000-4000-8000-000000000001', chainId: 4663, mandate: MANDATE, owner: OWNER, agent: AGENT, label: 'Claude', status: 'active', createdAt: '2026-10-10T12:00:00.000Z', revokedAt: null, lastUsedAt: null },
  token: TOKEN,
  settings,
};

describe('the fields an owner signs', () => {
  it('carry a fresh sixteen-byte nonce, the time, and checksummed addresses', () => {
    const fields = connectFields({ mandate: MANDATE.toLowerCase() as typeof MANDATE, owner: OWNER, chainId: 4663, label: '  Claude ' });
    expect(fields.nonce).toMatch(/^0x[0-9a-f]{32}$/u);
    expect(fields.mandate).toBe(getAddress(MANDATE));
    expect(fields.owner).toBe(getAddress(OWNER));
    expect(fields.chainId).toBe(4663);
    expect(Date.now() - Date.parse(fields.issuedAt)).toBeLessThan(5_000);
    expect(fields.label).toBe('Claude');
    expect(connectFields({ mandate: MANDATE, owner: OWNER, chainId: 4663, label: '' }).label).toBeUndefined();
    expect(connectFields({ mandate: MANDATE, owner: OWNER, chainId: 4663 }).nonce).not.toBe(fields.nonce);
  });
});

describe('the connector settings', () => {
  it('fill the endpoint and the token into every assistant, and say where the token travels', () => {
    for (const initial of ['chatgpt', 'claude', 'claude-code', 'gemini'] as const) {
      const html = renderToStaticMarkup(<ConnectorSettingsView settings={settings} initial={initial} />);
      expect(html).toContain(TOKEN);
      expect(html).toContain('mcp.bursar.world/mcp');
      expect(html).toMatch(/token travels in the URL|sent as a bearer header/u);
      expect(html).not.toContain('—');
    }
    const chatgpt = renderToStaticMarkup(<ConnectorSettingsView settings={settings} initial="chatgpt" />);
    expect(chatgpt).toContain('No authentication');
    expect(chatgpt).toContain('aria-selected="true"');
    const code = renderToStaticMarkup(<ConnectorSettingsView settings={settings} initial="claude-code" />);
    expect(code).toContain('claude mcp add --transport http bursar');
  });
});

describe('the steps after a connection is made', () => {
  it('show the agent, ask for the seat, and show the token once', () => {
    const html = renderToStaticMarkup(<CreatedSteps created={created} seated={false} seat={<button type="button">Seat the agent</button>} onDone={() => undefined} />);
    expect(html).toContain(AGENT);
    expect(html).toContain('Seat the agent');
    expect(html).toContain(TOKEN);
    expect(html).toContain(TOKEN_ONCE_LINE);
    expect(html).not.toContain('—');

    const seated = renderToStaticMarkup(<CreatedSteps created={created} seated seat={<button type="button">Seat the agent</button>} onDone={() => undefined} />);
    expect(seated).toContain('Seated. The assistant spends within the limits from now on.');
    expect(seated).not.toContain('>Seat the agent<');
  });

  it('lists connections with whether each one is the seated agent', () => {
    const html = renderToStaticMarkup(<ConnectionList connections={[created.connection]} seatedAgent={AGENT} />);
    expect(html).toContain('Claude');
    expect(html).toContain('Seated as the agent');
    const unseated = renderToStaticMarkup(<ConnectionList connections={[created.connection]} seatedAgent={'0x0000000000000000000000000000000000000000'} />);
    expect(unseated).toContain('Not seated. It cannot spend until you seat it.');
    expect(renderToStaticMarkup(<ConnectionList connections={[]} seatedAgent={undefined} />)).toContain('No assistant is connected');
  });

  it('keeps a disconnected connection in the list only for a few minutes', () => {
    const now = Date.parse('2026-10-10T12:30:00.000Z');
    const cut = { ...created.connection, id: 'cut', status: 'revoked' as const, revokedAt: new Date(now - REVOKED_SHOWN_MS + 1_000).toISOString() };
    const old = { ...cut, id: 'old', revokedAt: new Date(now - REVOKED_SHOWN_MS - 1_000).toISOString() };
    expect(visibleConnections([created.connection, cut, old], now).map((c) => c.id)).toEqual([created.connection.id, 'cut']);
  });

  it('says plainly who holds the key and what bounds it', () => {
    expect(CUSTODY_LINE).toContain('The host keeps this agent');
    expect(CUSTODY_LINE).toContain('limits on this mandate are what bound it');
    expect(CUSTODY_LINE).not.toContain('—');
  });
});
