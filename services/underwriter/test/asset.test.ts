import { capabilityId, toMicro } from '@bursar/core';
import { describe, expect, test } from 'vitest';

import { documentAnchor } from '../src/anchor.js';
import { assetCondition } from '../src/asset.js';
import { controlFailure, type IssuerControls } from '../src/chain.js';
import { RefuseReason } from '../src/decision.js';
import { type Hex32, documentHash, parseDocument } from '../src/document.js';
import type { SpendRequest } from '../src/policy.js';
import { Underwriter, type UnderwriterOptions } from '../src/underwriter.js';
import { ACCOUNT, DAY, MERCHANT, MONTH, USDG, fakeChain, type FakeChain } from './support/fake-chain.js';

/**
 * The settlement asset's own controls, on the decision path.
 *
 * A principal whose account the token issuer has frozen and a principal who has run out of daily
 * headroom have nothing in common except that neither payment went through. One raises a limit
 * and tries again; the other cannot do anything at all and has to take it to the issuer. The
 * refusals have to say which, and this is where that is decided.
 *
 * The read happens whether or not the deployment simulates. `simulate` defaults off for anything
 * embedding this class, so a check that lived only inside the simulation would leave the issuer's
 * answer out of the decision entirely for those deployments.
 */

const CHAIN_ID = 4_663;
const SUBJECT = 'wallet:0x1111111111111111111111111111111111111111';
const NOW_SECONDS = 1_800_000_000n;
const NOW_ISO = new Date(Number(NOW_SECONDS) * 1000).toISOString();
const LABEL_ID = capabilityId('gpu.lease:1') as Hex32;

const DOCUMENT = parseDocument({
  subject: SUBJECT,
  account: ACCOUNT,
  chain_id: CHAIN_ID,
  version: 1,
  valid_from: '1970-01-01T00:00:00Z',
  expires_at: '2028-01-01T00:00:00Z',
  rules: [{ effect: 'allow', pattern: '*' }],
  ceiling_micros: 100_000_000,
  per_call_cap_micros: 1_000_000,
  approval_threshold_micros: 500_000,
  daily_limit_micros: 5_000_000,
  daily_window_seconds: DAY,
  monthly_limit_micros: 50_000_000,
  monthly_window_seconds: MONTH,
  window_anchor: '1970-01-01T00:00:00Z',
  capabilities: [LABEL_ID],
});

function build(overrides: Partial<UnderwriterOptions> = {}): { underwriter: Underwriter; chain: FakeChain } {
  const chain = fakeChain();
  chain.state.nowSeconds = NOW_SECONDS;
  chain.rosters.capabilityAllowlist.add(LABEL_ID.toLowerCase());
  chain.state.capabilityAllowed = true;
  chain.state.account = {
    ...chain.state.account,
    documentHash: documentAnchor({
      chainId: CHAIN_ID,
      account: ACCOUNT,
      version: chain.state.account.version,
      documentHash: documentHash(DOCUMENT),
    }),
  };

  const underwriter = new Underwriter({
    chain,
    chainId: CHAIN_ID,
    account: ACCOUNT,
    document: DOCUMENT,
    ...overrides,
  });

  return { underwriter, chain };
}

function request(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    requestId: 'asset-1',
    subject: SUBJECT,
    action: 'gpu.lease:1',
    amountMicros: toMicro(100_000),
    at: NOW_ISO,
    merchant: MERCHANT,
    capabilityId: LABEL_ID,
    deadline: NOW_SECONDS + 3_600n,
    ...overrides,
  };
}

describe('a spend the token issuer has stopped', () => {
  test('a frozen account is refused as frozen, not as a limit or a balance', async () => {
    const { underwriter, chain } = build();
    chain.state.issuer.frozen.add(ACCOUNT.toLowerCase());

    const quote = await underwriter.quote(request());

    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.PayerFrozen });
    expect(quote.source).toBe('asset');
    expect(quote.bucket).toBeNull();
    expect(quote.assetCondition).toMatchObject({ asset: USDG, party: ACCOUNT });
    expect(quote.assetCondition?.detail).toContain('token issuer');
  });

  test('a frozen payee has its own refusal, because the funds cannot reach them either', async () => {
    const { underwriter, chain } = build();
    chain.state.issuer.frozen.add(MERCHANT.toLowerCase());

    const quote = await underwriter.quote(request());

    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.PayeeFrozen });
    expect(quote.assetCondition?.party).toBe(MERCHANT);
  });

  test('a paused asset refuses every spend in it', async () => {
    const { underwriter, chain } = build();
    chain.state.issuer.paused = true;

    const quote = await underwriter.quote(request());

    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.AssetPaused });
    expect(quote.assetCondition?.party).toBeNull();
  });

  test('a frozen account is reported even when the account is also short', async () => {
    const { underwriter, chain } = build();
    chain.state.issuer.frozen.add(ACCOUNT.toLowerCase());
    chain.state.account = { ...chain.state.account, balanceMicros: toMicro(1) };

    const quote = await underwriter.quote(request());

    // Funding is the one of the two a principal can act on, and saying so would send them to put
    // money into an address the escrow cannot pull from.
    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.PayerFrozen });
  });

  test('the mandate\'s own terms still answer first', async () => {
    const { underwriter, chain } = build();
    chain.state.issuer.paused = true;
    chain.state.account = { ...chain.state.account, paused: true };

    const quote = await underwriter.quote(request());

    // Both are true. The principal paused this mandate themselves, so that is the answer they are
    // owed, and it is the one they can undo.
    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.Paused });
    expect(quote.source).toBe('account');
    expect(quote.assetCondition).toBeNull();
  });

  test('an allowed spend reports no asset condition at all', async () => {
    const { underwriter } = build();

    const quote = await underwriter.quote(request());

    expect(quote.decision).toEqual({ decision: 'allow' });
    expect(quote.assetCondition).toBeNull();
  });

  test('the refusal is what the journal records, so a retry gets the same answer', async () => {
    const { underwriter, chain } = build();
    chain.state.issuer.frozen.add(ACCOUNT.toLowerCase());

    const first = await underwriter.authorize(request());
    const retry = await underwriter.authorize(request());

    expect(first.decision).toEqual({ decision: 'refuse', reason: RefuseReason.PayerFrozen });
    expect(retry.idempotent).toBe(true);
    expect(retry.decision).toEqual({ decision: 'refuse', reason: RefuseReason.PayerFrozen });
  });
});

describe('a control that does not answer', () => {
  test('a removed facet is refused as absent, not as a chain that is down', async () => {
    const { underwriter, chain } = build();
    chain.state.issuer.failure = { kind: 'absent' };

    const quote = await underwriter.quote(request());

    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.AssetControlAbsent });
    expect(quote.assetCondition?.detail).toContain('FacetNotFound');
  });

  test('a read that times out is refused as unreadable', async () => {
    const { underwriter, chain } = build();
    chain.state.issuer.failure = { kind: 'unreadable' };

    const quote = await underwriter.quote(request());

    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.AssetControlUnreadable });
    expect(quote.assetCondition?.detail).toContain('timed out');
  });

  test('the two are told apart rather than sharing one label', async () => {
    const absent = build();
    absent.chain.state.issuer.failure = { kind: 'absent', on: 'frozen' };
    const unreadable = build();
    unreadable.chain.state.issuer.failure = { kind: 'unreadable', on: 'frozen' };

    expect((await absent.underwriter.quote(request())).decision).toEqual({
      decision: 'refuse',
      reason: RefuseReason.AssetControlAbsent,
    });
    expect((await unreadable.underwriter.quote(request())).decision).toEqual({
      decision: 'refuse',
      reason: RefuseReason.AssetControlUnreadable,
    });
  });

  test('an answer beats an absence: a frozen account is reported when the pause read failed', async () => {
    const { underwriter, chain } = build();
    chain.state.issuer.failure = { kind: 'unreadable', on: 'paused' };
    chain.state.issuer.frozen.add(ACCOUNT.toLowerCase());

    const quote = await underwriter.quote(request());

    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.PayerFrozen });
  });
});

describe('what the read costs', () => {
  test('it happens on a deployment that does not simulate', async () => {
    const { underwriter, chain } = build({ simulate: false });
    chain.state.issuer.frozen.add(ACCOUNT.toLowerCase());

    const quote = await underwriter.quote(request());

    expect(quote.simulated).toBe(false);
    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.PayerFrozen });
  });

  test('both parties are asked about once, against the asset the account names', async () => {
    const { underwriter, chain } = build();

    await underwriter.quote(request());

    expect(chain.state.calls.issuerControls).toHaveLength(1);
    expect(chain.state.calls.issuerControls[0]).toEqual({
      asset: USDG,
      parties: [ACCOUNT, MERCHANT],
    });
  });

  test('it is answered at the height the rest of the decision was taken at', async () => {
    const { underwriter, chain } = build();

    await underwriter.quote(request());

    const heights = chain.state.calls.heights;
    expect(heights.length).toBeGreaterThan(0);
    expect(heights.every((height) => height === chain.state.blockNumber)).toBe(true);
  });

  test('a chain that answers nothing is still chain_unavailable, not an asset condition', async () => {
    const { underwriter, chain } = build();
    chain.state.down = true;

    const quote = await underwriter.quote(request());

    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.ChainUnavailable });
    expect(quote.assetCondition).toBeNull();
  });
});

describe('reading a failed control', () => {
  test('the diamond selector is recognised wherever in the error chain it landed', () => {
    expect(controlFailure(new Error('call failed', { cause: { data: '0x800ab12c' } })).state).toBe('absent');
  });

  test('a decoded FacetNotFound is recognised by name too', () => {
    expect(controlFailure(new Error('execution reverted: FacetNotFound')).state).toBe('absent');
  });

  test('anything else is unreadable, and keeps what the chain said', () => {
    const reading = controlFailure(new Error('connect ECONNREFUSED 127.0.0.1:8545'));
    expect(reading.state).toBe('unreadable');
    if (reading.state !== 'read') expect(reading.detail).toContain('ECONNREFUSED');
  });
});

describe('the verdict on its own', () => {
  const clear: IssuerControls = {
    asset: USDG,
    paused: { state: 'read', value: false },
    parties: [
      { address: ACCOUNT, frozen: { state: 'read', value: false } },
      { address: MERCHANT, frozen: { state: 'read', value: false } },
    ],
  };

  test('a clear reading of both parties lets the spend go on', () => {
    expect(assetCondition(clear, { payer: ACCOUNT, payee: MERCHANT })).toBeNull();
  });

  test('a party nobody read is a party nobody cleared', () => {
    const short: IssuerControls = { ...clear, parties: [clear.parties[0]!] };

    const condition = assetCondition(short, { payer: ACCOUNT, payee: MERCHANT });

    expect(condition?.reason).toBe(RefuseReason.AssetControlUnreadable);
    expect(condition?.party).toBe(MERCHANT);
  });
});
