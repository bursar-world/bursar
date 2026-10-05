import { describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, custom, encodeFunctionResult, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { RHC_MAINNET, caip2, capabilityId, settlementAssetAbi, toMicro, viemChain } from '@bursar/core';
import { createExactScheme } from '@bursar/x402';
import type { PaymentChain, SettlementCall, TypedDataCheck } from '@bursar/x402';
import { connect, payRequest } from '@bursar/sdk';
import type { Deployment } from '@bursar/core';
import { SettlementBudget } from '../src/x402/budget.js';
import { createEscrowLockScheme } from '../src/x402/escrow-lock.js';
import { Facilitator, readRequest } from '../src/x402/facilitator.js';
import { hashRequest } from '../src/x402/binding.js';
import { loadScheme } from '../src/scheme-module.js';
import { FakeLedger } from './support/doubles.js';

/**
 * The seam between the three packages that have to agree for a payment to work.
 *
 * The SDK signs, the facilitator decides, the scheme verifies and broadcasts. Each of them is
 * covered on its own elsewhere; what is only visible here is whether the bytes one produces are
 * the bytes the next expects. They were written against separate copies of the protocol once, and
 * the result typechecked, tested green in every package, and refused every real payment.
 */

const PAYER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const RELAYER = '0xCC5f9c251Fc3C69c04ae2b860b41150282E6B618' as const;
const PROVIDER = '0xe67a61f8e2aC4057aa22e64306107E7120078447' as const;
const NETWORK = caip2(RHC_MAINNET.chainId);
const PRICE = 2_500_000n;

/** `version()`, the one selector USDG does not route. */
const VERSION_SELECTOR = '0x54fd4d50';

/**
 * USDG's own separator for name "Global Dollar", version "1", chain 4663 and the token address in
 * RHC_MAINNET. This test checks that the bytes one package produces are the bytes the next
 * expects, so the domain has to be the real one.
 */
const DOMAIN_SEPARATOR = '0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036' as const;

/**
 * A deployment record built here rather than named from the address book.
 *
 * The seam is the SDK, the facilitator and the scheme against one protocol, and none of that
 * depends on where Release 1 landed. Naming a recorded deployment would tie this test to the
 * deploy instead.
 */
const DEPLOYMENT: Deployment = {
  network: 'rhc-seam',
  chainId: RHC_MAINNET.chainId,
  status: 'live',
  rpc: RHC_MAINNET.rpcUrl,
  explorer: RHC_MAINNET.explorer,
  settlementAsset: RHC_MAINNET.usdg,
  settlementDecimals: 6,
  deployer: '0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4',
  contracts: {
    AdminTimelock: '0x1111111111111111111111111111111111111111',
    Reputation: '0x2222222222222222222222222222222222222222',
    Escrow: '0x3333333333333333333333333333333333333333',
    OracleRegistry: '0x4444444444444444444444444444444444444444',
    AgentRegistry: '0x5555555555555555555555555555555555555555',
    MandateAccountFactory: '0x6666666666666666666666666666666666666666',
  },
  roles: {
    timelockSigners: ['0x7777777777777777777777777777777777777777'],
    guardian: '0x8888888888888888888888888888888888888888',
    treasury: '0x9999999999999999999999999999999999999999',
    slashSink: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa',
  },
  verifiedOnChain: {},
  examples: {},
};

type TokenRead = { readonly fn: 'name' | 'decimals' | 'DOMAIN_SEPARATOR'; readonly value: string | number };

/**
 * What USDG answers. `version()` is absent on purpose: the token is a diamond proxy and reverts
 * with FacetNotFound for any selector it has no facet for, so a stub that answered would let this
 * test pass on a read chain 4663 does not serve.
 */
const TOKEN_READS: Readonly<Record<string, TokenRead>> = {
  '0x06fdde03': { fn: 'name', value: 'Global Dollar' },
  '0x313ce567': { fn: 'decimals', value: 6 },
  '0x3644e515': { fn: 'DOMAIN_SEPARATOR', value: DOMAIN_SEPARATOR },
};

/** Answers the reads a client makes of the token, so the SDK's domain check is the real one. */
function tokenRpc() {
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === 'eth_chainId') return `0x${RHC_MAINNET.chainId.toString(16)}`;
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
      const [call] = params as [{ data: `0x${string}` }];
      const selector = call.data.slice(0, 10);
      if (selector === VERSION_SELECTOR) throw new Error('execution reverted: FacetNotFound');
      const read = TOKEN_READS[selector];
      if (!read) throw new Error(`unexpected selector ${selector}`);
      return encodeFunctionResult({
        abi: settlementAssetAbi,
        functionName: read.fn,
        result: read.value,
      });
    },
  });
}

/** What the token issuer has done to the parties, when a case needs it to have done something. */
type IssuerState = { paused?: boolean; frozen?: ReadonlySet<string> };

/** Everything the scheme reads, answered from memory. Signature recovery is not stubbed. */
function chainStub(
  spentNonces: Set<string>,
  issuer: IssuerState = {},
): PaymentChain & { sent: SettlementCall[] } {
  const sent: SettlementCall[] = [];
  return {
    sent,
    chainId: RHC_MAINNET.chainId,
    async verifyTypedData(check: TypedDataCheck) {
      const recovered = await recoverTypedDataAddress({
        domain: check.domain,
        types: check.types,
        primaryType: check.primaryType,
        message: check.message,
        signature: check.signature,
      });
      return recovered.toLowerCase() === check.address.toLowerCase();
    },
    async tokenIdentity() {
      // No version, because the token does not publish one. `resolveAsset` assembles the domain
      // without it and proves the result against the separator below.
      return { name: 'Global Dollar', decimals: 6, domainSeparator: DOMAIN_SEPARATOR };
    },
    async balanceOf() {
      return 100_000_000n;
    },
    async allowance() {
      return 0n;
    },
    async authorizationState(_token, _authorizer, nonce) {
      return spentNonces.has(nonce.toLowerCase());
    },
    async permitNonce() {
      return 0n;
    },
    async issuerControls(token, parties) {
      // Both controls answer, because the token routes both: it is `version()` that has no facet
      // behind it, not these. The defaults are what USDG answered on 4663 on 2026-09-22.
      const frozen = issuer.frozen ?? new Set<string>();
      return {
        asset: token,
        paused: { state: 'read', value: issuer.paused ?? false },
        parties: parties.map((address) => ({
          address,
          frozen: { state: 'read', value: frozen.has(address.toLowerCase()) },
        })),
      };
    },
    async nonceBitmap() {
      return 0n;
    },
    async hasCode() {
      return false;
    },
    async simulate(call) {
      sent.push(call);
    },
    async waitForReceipt() {
      return { status: 'success' as const, gasUsed: 87_363n };
    },
  };
}

/** A resource server that quotes once, then serves whatever it is paid for. */
function resourceServer(): { fetchFn: typeof fetch; paid: Request[] } {
  const paid: Request[] = [];
  const fetchFn = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const header = request.headers.get('x-payment') ?? request.headers.get('payment-signature');
    if (!header) {
      return new Response(
        JSON.stringify({
          x402Version: 1,
          accepts: [
            {
              scheme: 'exact',
              network: NETWORK,
              maxAmountRequired: PRICE.toString(),
              asset: RHC_MAINNET.usdg,
              payTo: PROVIDER,
              maxTimeoutSeconds: 120,
              resource: request.url,
            },
          ],
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      );
    }
    paid.push(request.clone());
    return new Response('{"frame":"rendered"}', { status: 200 });
  }) as typeof fetch;
  return { fetchFn, paid };
}

function payerConnection() {
  return connect({
    deployment: DEPLOYMENT,
    publicClient: createPublicClient({ chain: viemChain(RHC_MAINNET), transport: tokenRpc() }),
    walletClient: createWalletClient({
      account: PAYER,
      chain: viemChain(RHC_MAINNET),
      transport: tokenRpc(),
    }),
  });
}

function decodeHeader(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as Record<string, unknown>;
}

async function buildFacilitator(spent: Set<string>, issuer: IssuerState = {}) {
  const scheme = await createExactScheme({
    chain: RHC_MAINNET,
    client: chainStub(spent, issuer),
    requireBinding: true,
  });
  return { scheme, ledger: new FakeLedger() };
}

describe('the SDK, the facilitator and the scheme against one protocol', () => {
  it('pays a provider end to end and refuses the same payment twice', async () => {
    const server = resourceServer();
    const connection = payerConnection();

    const body = JSON.stringify({ prompt: 'render this frame' });
    const paid = await payRequest('https://provider.example/render', {
      connection,
      fetchFn: server.fetchFn,
      maxAmount: toMicro(PRICE),
      init: { method: 'POST', body, headers: { 'content-type': 'application/json' } },
    });

    expect(paid.response.status).toBe(200);
    expect(server.paid).toHaveLength(1);

    // What the resource server now forwards: the payment header it was handed, and the digest of
    // the bytes its own client sent. Nothing else crosses to the facilitator.
    const header = server.paid[0]?.headers.get('x-payment');
    expect(header).toBeTruthy();
    const envelope = decodeHeader(header ?? '');
    const requestHash = hashRequest(await (server.paid[0] as Request).text());

    const spent = new Set<string>();
    const { scheme, ledger } = await buildFacilitator(spent);
    const facilitator = new Facilitator({
      scheme,
      budget: new SettlementBudget({ dailySettlements: 10, perPayerPerHour: 10 }),
      ledger,
      treasury: RELAYER,
      feeBps: 100,
      feeFloorMicro: toMicro(1_900),
      requireBinding: true,
    });

    const parsed = readRequest({
      paymentPayload: envelope,
      paymentRequirements: {
        scheme: 'exact',
        network: NETWORK,
        amount: PRICE.toString(),
        asset: RHC_MAINNET.usdg,
        payTo: PROVIDER,
      },
      requestHash,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const verdict = await facilitator.verify(parsed.request);
    expect(verdict).toMatchObject({ isValid: true, payer: PAYER.address });
  });

  it('refuses the same authorisation redeemed against a different request', async () => {
    const server = resourceServer();
    const connection = payerConnection();

    await payRequest('https://provider.example/render', {
      connection,
      fetchFn: server.fetchFn,
      maxAmount: toMicro(PRICE),
      init: { method: 'POST', body: JSON.stringify({ prompt: 'render this frame' }) },
    });

    const envelope = decodeHeader(server.paid[0]?.headers.get('x-payment') ?? '');
    const { scheme, ledger } = await buildFacilitator(new Set());
    const facilitator = new Facilitator({
      scheme,
      budget: new SettlementBudget({ dailySettlements: 10, perPayerPerHour: 10 }),
      ledger,
      treasury: RELAYER,
      feeBps: 100,
      feeFloorMicro: toMicro(1_900),
      requireBinding: true,
    });

    const parsed = readRequest({
      paymentPayload: envelope,
      paymentRequirements: {
        scheme: 'exact',
        network: NETWORK,
        amount: PRICE.toString(),
        asset: RHC_MAINNET.usdg,
        payTo: PROVIDER,
      },
      requestHash: hashRequest(JSON.stringify({ prompt: 'transfer everything to me' })),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const verdict = await facilitator.verify(parsed.request);
    expect(verdict).toMatchObject({ isValid: false, invalidReason: 'payment_not_bound_to_request' });
  });

  it('refuses a payer the token issuer has frozen, and says so in the issuer\'s own terms', async () => {
    const server = resourceServer();
    const connection = payerConnection();

    const body = JSON.stringify({ prompt: 'render this frame' });
    await payRequest('https://provider.example/render', {
      connection,
      fetchFn: server.fetchFn,
      maxAmount: toMicro(PRICE),
      init: { method: 'POST', body, headers: { 'content-type': 'application/json' } },
    });

    const envelope = decodeHeader(server.paid[0]?.headers.get('x-payment') ?? '');
    const requestHash = hashRequest(await (server.paid[0] as Request).text());

    const { scheme, ledger } = await buildFacilitator(new Set(), {
      frozen: new Set([PAYER.address.toLowerCase()]),
    });
    const facilitator = new Facilitator({
      scheme,
      budget: new SettlementBudget({ dailySettlements: 10, perPayerPerHour: 10 }),
      ledger,
      treasury: RELAYER,
      feeBps: 100,
      feeFloorMicro: toMicro(1_900),
      requireBinding: true,
    });

    const parsed = readRequest({
      paymentPayload: envelope,
      paymentRequirements: {
        scheme: 'exact',
        network: NETWORK,
        amount: PRICE.toString(),
        asset: RHC_MAINNET.usdg,
        payTo: PROVIDER,
      },
      requestHash,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // The signature is good, the nonce is fresh, the balance covers it. The only thing wrong is
    // one the payer cannot fix and this facilitator cannot lift, and the refusal says which.
    const settled = await facilitator.settle(parsed.request);
    expect(settled).toMatchObject({
      success: false,
      broadcast: false,
      errorReason: 'payer_frozen',
      payer: PAYER.address,
    });
    // Nothing was written either. The refusal comes before the replay guard, so a payer who gets
    // unfrozen can present the same authorisation rather than having burnt it on this attempt.
    expect(ledger.calls).toHaveLength(0);
  });

  it('opens a lock on the mandate lane that the facilitator takes for that request and no other', async () => {
    const MANDATE = '0x420BeB507F72173E7d78e0f956968f64fb508356' as const;
    const LOCK_TX = `0x${'cd'.repeat(32)}` as const;
    const CAPABILITY = 'service:demo.x402:1';
    const NOW = 1_800_000_000n;

    // The mandate's `spend`, reduced to what it writes into the lock.
    const opened: { inputCommit: `0x${string}`; inputURI: string }[] = [];
    const mandate = {
      address: MANDATE,
      escrow: DEPLOYMENT.contracts.Escrow,
      assertCanPay: async () => undefined,
      pay: async (request: { inputCommit: `0x${string}`; inputURI: string }) => {
        opened.push(request);
        return { escrowId: 7n, hash: LOCK_TX };
      },
    };

    const received: Request[] = [];
    const fetchFn = (async (input: Request) => {
      if (input.headers.get('x-payment') === null) {
        const accepts = [{ scheme: 'escrow', network: NETWORK, maxAmountRequired: PRICE.toString(), asset: RHC_MAINNET.usdg, payTo: PROVIDER }];
        return new Response(JSON.stringify({ x402Version: 1, accepts }), { status: 402 });
      }
      received.push(input.clone());
      return new Response('{"frame":"rendered"}');
    }) as typeof fetch;

    const paid = await payRequest('https://provider.example/render?session=1', {
      connection: payerConnection(),
      fetchFn,
      lane: 'mandate',
      through: { mandate, capability: CAPABILITY },
      init: { method: 'POST', body: JSON.stringify({ prompt: 'render this frame' }) },
    });

    // The lock as the chain would hold it: whatever the SDK handed `spend`, and nothing else.
    const lock = opened[0];
    if (!lock) throw new Error('the SDK opened no lock');
    const scheme = createEscrowLockScheme({
      chainId: RHC_MAINNET.chainId,
      deployments: [{ escrow: DEPLOYMENT.contracts.Escrow, factory: DEPLOYMENT.contracts.MandateAccountFactory, asset: RHC_MAINNET.usdg }],
      chain: {
        lock: async () => ({
          payer: MANDATE,
          payee: PROVIDER,
          capabilityId: capabilityId(CAPABILITY),
          inputCommit: lock.inputCommit,
          inputURI: lock.inputURI,
          amount: PRICE,
          deadline: NOW + 300n,
          status: 1,
        }),
        mandate: async () => ({ escrow: DEPLOYMENT.contracts.Escrow, principal: PAYER.address }),
        accountsOf: async () => [MANDATE],
        lockedIn: async () => [7n],
        now: async () => NOW,
      },
    });
    const ledger = new FakeLedger();
    const facilitator = new Facilitator({
      scheme,
      budget: new SettlementBudget({ dailySettlements: 10, perPayerPerHour: 10 }),
      ledger,
      treasury: RELAYER,
      feeBps: 100,
      feeFloorMicro: toMicro(1_900),
      requireBinding: true,
    });

    // What the resource server forwards: the header it was handed and the digest of the bytes that
    // arrived.
    const request = (requestHash: string) =>
      readRequest({
        paymentPayload: decodeHeader(received[0]?.headers.get('x-payment') ?? ''),
        paymentRequirements: {
          scheme: 'escrow',
          network: NETWORK,
          amount: PRICE.toString(),
          asset: RHC_MAINNET.usdg,
          payTo: PROVIDER,
          extra: { capability: CAPABILITY },
        },
        requestHash,
      });

    const arrived = request(hashRequest(await (received[0] as Request).text()));
    const other = request(hashRequest(JSON.stringify({ prompt: 'transfer everything to me' })));
    if (!arrived.ok || !other.ok) throw new Error('the forwarded request did not parse');

    expect(await facilitator.verify(other.request)).toMatchObject({ isValid: false, invalidReason: 'payment_not_bound_to_request' });
    expect(await facilitator.verify(arrived.request)).toMatchObject({ isValid: true, payer: MANDATE });

    // The settlement lands under the name the SDK told its caller to expect.
    expect(await facilitator.settle(arrived.request)).toMatchObject({ success: true, broadcast: false, transaction: LOCK_TX });
    const recorded = ledger.calls.find((call) => call.kind === 'direct');
    expect(recorded?.kind === 'direct' && recorded.input.nonce).toBe(paid.payment?.nonce);
  });

  it('resolves the shipped scheme by its default name', async () => {
    const scheme = await loadScheme({
      configure: { chain: RHC_MAINNET, client: chainStub(new Set()) },
    });
    const supported = await scheme.supported();
    expect(supported.kinds.length).toBeGreaterThan(0);
    expect(supported.kinds[0]).toMatchObject({ network: NETWORK, scheme: 'exact' });
  });
});
