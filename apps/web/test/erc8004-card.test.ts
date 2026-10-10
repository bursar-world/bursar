import { ERC8004_REGISTRATION_TYPE, toCapabilityId } from '@bursar/core';
import type { Address } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { GET, siteFor } from '@/app/agents/[address]/card.json/route';

/**
 * The agent card, built from the chain. The reads are faked at the multicall, by function name,
 * so the test says what the contracts answered and checks what the card made of it: the
 * standard's required fields, the figures in USDG, and a registration only once the registry has
 * confirmed the token names the subject.
 */
const PROVIDER = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374' as Address;
const MANDATE = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c' as Address;
const OWNER = '0x877c349EFb5926082C413833E8055F0991185c61' as Address;
const AGENT = '0x9999999999999999999999999999999999999999' as Address;
const IDENTITY = '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432';

type Call = { readonly functionName: string; readonly args?: readonly unknown[]; readonly address: Address };

const answers: Record<string, (call: Call) => unknown> = {};
const failing = new Set<string>();

vi.mock('@/chain/client', () => ({ rhcClient: () => ({ fake: true }) }));
vi.mock('@/chain/mandates', () => ({ mandateCodeVersion: async (account: Address) => (account.toLowerCase() === MANDATE.toLowerCase() ? 'v6' : undefined) }));
vi.mock('viem/actions', async (original) => ({
  ...(await original<typeof import('viem/actions')>()),
  multicall: async (_client: unknown, { contracts }: { contracts: readonly Call[] }) =>
    contracts.map((call) =>
      failing.has(call.functionName) || answers[call.functionName] === undefined
        ? { status: 'failure', error: new Error(call.functionName) }
        : { status: 'success', result: answers[call.functionName]!(call) },
    ),
  readContract: async (_client: unknown, call: Call) => answers[call.functionName]!(call),
}));

const scanAnswering = (items: unknown[]): typeof fetch =>
  (async () => Response.json({ items })) as unknown as typeof fetch;

function listedProvider(): void {
  answers['isRegistered'] = ({ args }) => String(args?.[0]).toLowerCase() === PROVIDER.toLowerCase();
  answers['getAgent'] = () => ({ name: 'render-farm', stake: 12_500_000n, registeredAt: 1_760_000_000n, active: true });
  answers['isActive'] = () => true;
  answers['score'] = () => 87;
  answers['capOf'] = () => 220_750_000n;
  answers['payeeStats'] = () => [14n, 1n, 2n];
}

function tokenNaming(subject: Address, uri: string): void {
  answers['ownerOf'] = () => PROVIDER;
  answers['tokenURI'] = () => uri;
  answers['getMetadata'] = ({ args }) => (args?.[1] === 'bursar.subject' ? subject : '0x');
}

describe('a provider card', () => {
  it('describes the listing from the contracts and claims only a confirmed registration', async () => {
    listedProvider();
    tokenNaming(PROVIDER, 'data:application/json;base64,e30=');
    globalThis.fetch = scanAnswering([{ chain_id: 4663, contract_address: IDENTITY, token_id: '9100' }]);

    const answer = await GET(new Request(`https://app.bursar.world/agents/${PROVIDER.toLowerCase()}/card.json`), {
      params: Promise.resolve({ address: PROVIDER.toLowerCase() }),
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('access-control-allow-origin')).toBe('*');
    const card = (await answer.json()) as Record<string, unknown>;

    expect(card['type']).toBe(ERC8004_REGISTRATION_TYPE);
    expect(card['name']).toBe('render-farm');
    expect(card['active']).toBe(true);
    expect(card['x402Support']).toBe(true);
    expect(card['supportedTrust']).toEqual(['reputation']);
    expect(card['services']).toEqual(
      expect.arrayContaining([{ name: 'web', endpoint: `https://app.bursar.world/providers/${PROVIDER}` }]),
    );
    expect(card['registrations']).toEqual([{ agentId: 9100, agentRegistry: `eip155:4663:${IDENTITY}` }]);
    expect(String(card['description'])).toContain('12.50 USDG stake');
    expect(String(card['description'])).toContain('Score 87 of 100');
    expect(String(card['description'])).toContain('220.75 USDG');
    expect(card['bursar']).toMatchObject({ role: 'provider', stake: '12.50', score: 87, settled: { delivered: 14, contested: 2, returned: 1 } });
  });

  it('drops a token the registry does not tie to the subject', async () => {
    listedProvider();
    tokenNaming('0x1234567890123456789012345678901234567890' as Address, 'https://elsewhere.example/card.json');
    globalThis.fetch = scanAnswering([{ chain_id: 4663, contract_address: IDENTITY, token_id: '9101' }]);

    const answer = await GET(new Request(`https://other.example/agents/${PROVIDER}/card.json`, { headers: { 'x-forwarded-host': 'preview.example', 'x-forwarded-proto': 'https' } }), {
      params: Promise.resolve({ address: PROVIDER }),
    });
    const card = (await answer.json()) as Record<string, unknown>;
    expect(card['registrations']).toEqual([]);
    expect(card['services']).toEqual(expect.arrayContaining([{ name: 'web', endpoint: `https://preview.example/providers/${PROVIDER}` }]));
  });
});

describe('a mandate card', () => {
  it('describes the budget, the seated agent and the capabilities the mandate allows', async () => {
    answers['isRegistered'] = () => false;
    answers['principal'] = () => OWNER;
    answers['agent'] = () => AGENT;
    answers['paused'] = () => false;
    answers['revoked'] = () => false;
    answers['limits'] = () => ({ perCallCap: 5_000_000n, dailyCap: 50_000_000n, monthlyCap: 400_000_000n, totalCap: 0n });
    answers['capabilities'] = ({ args }) => String(args?.[0]).toLowerCase() === hashOf('service:gpu.render:1');
    globalThis.fetch = scanAnswering([]);

    const answer = await GET(new Request(`https://app.bursar.world/agents/${MANDATE}/card.json`), { params: Promise.resolve({ address: MANDATE }) });
    const card = (await answer.json()) as Record<string, unknown>;

    expect(card['name']).toBe('Bursar mandate 0x8605…cd5c');
    expect(card['x402Support']).toBe(false);
    expect(card['active']).toBe(true);
    expect(String(card['description'])).toContain('up to 5.00 USDG per payment, 50.00 per day and 400.00 per month.');
    expect(String(card['description'])).toContain(`The seated agent is ${AGENT}.`);
    expect(card['bursar']).toMatchObject({ role: 'mandate', owner: OWNER, agent: AGENT, capabilities: ['service:gpu.render:1'], limits: { perPayment: '5.00', daily: '50.00', monthly: '400.00' } });
  });
});

describe('what is not a card', () => {
  it('answers 404 for an address that is neither listed nor a mandate, and for no address at all', async () => {
    answers['isRegistered'] = () => false;
    const stranger = await GET(new Request(`https://app.bursar.world/agents/${AGENT}/card.json`), { params: Promise.resolve({ address: AGENT }) });
    expect(stranger.status).toBe(404);
    expect(((await stranger.json()) as { error: string }).error).toBe('not_a_bursar_agent');

    const junk = await GET(new Request('https://app.bursar.world/agents/nope/card.json'), { params: Promise.resolve({ address: 'nope' }) });
    expect(junk.status).toBe(404);
  });

  it('names the site from the deployment first, then from the request', () => {
    process.env['NEXT_PUBLIC_SITE_URL'] = 'https://app.bursar.world/';
    expect(siteFor(new Request('http://localhost:4310/agents/x/card.json'))).toBe('https://app.bursar.world');
    delete process.env['NEXT_PUBLIC_SITE_URL'];
    expect(siteFor(new Request('http://localhost:4310/agents/x/card.json'))).toBe('http://localhost:4310');
  });
});

function hashOf(label: string): string {
  return toCapabilityId(label).toLowerCase();
}
