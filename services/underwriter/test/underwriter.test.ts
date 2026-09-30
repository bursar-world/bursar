import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { capabilityId, toMicro } from '@bursar/core';
import { describe, expect, test } from 'vitest';

import { documentAnchor } from '../src/anchor.js';
import { RefuseReason } from '../src/decision.js';
import { type Hex32, documentHash, parseDocument } from '../src/document.js';
import { ChainUnavailableError } from '../src/errors.js';
import type { UnderwriterEvent } from '../src/events.js';
import { FileDecisionSink, loadJournal } from '../src/journal.js';
import { merchantLeaf } from '../src/merkle.js';
import type { SpendRequest } from '../src/policy.js';
import { errorSelector } from '../src/selectors.js';
import { ENFORCEMENT, Underwriter, type UnderwriterOptions } from '../src/underwriter.js';
import { ACCOUNT, AGENT, CAPABILITY, DAY, MERCHANT, MONTH, type FakeChain, fakeChain } from './support/fake-chain.js';

const CHAIN_ID = 4_663;
const SUBJECT = 'wallet:0x1111111111111111111111111111111111111111';
const NOW_SECONDS = 1_800_000_000n;
const NOW_ISO = new Date(Number(NOW_SECONDS) * 1000).toISOString();

const DOCUMENT_RAW = {
  subject: SUBJECT,
  account: ACCOUNT,
  chain_id: CHAIN_ID,
  version: 1,
  valid_from: '1970-01-01T00:00:00Z',
  expires_at: '2028-01-01T00:00:00Z',
  rules: [
    { effect: 'allow', pattern: 'gpu.*' },
    { effect: 'deny', pattern: 'gpu.experimental' },
  ],
  ceiling_micros: 100_000_000,
  per_call_cap_micros: 1_000_000,
  approval_threshold_micros: 500_000,
  daily_limit_micros: 5_000_000,
  daily_window_seconds: DAY,
  monthly_limit_micros: 50_000_000,
  monthly_window_seconds: MONTH,
  window_anchor: '1970-01-01T00:00:00Z',
  capabilities: [CAPABILITY],
};

const DOCUMENT = parseDocument(DOCUMENT_RAW);

function build(
  overrides: Partial<UnderwriterOptions> = {},
  chainOverrides: Parameters<typeof fakeChain>[0] = {},
): { underwriter: Underwriter; chain: FakeChain; events: UnderwriterEvent[] } {
  const chain = fakeChain(chainOverrides);
  chain.state.nowSeconds = NOW_SECONDS;
  chain.state.account = {
    ...chain.state.account,
    documentHash: documentAnchor({
      chainId: CHAIN_ID,
      account: ACCOUNT,
      version: chain.state.account.version,
      documentHash: documentHash(DOCUMENT),
    }),
  };

  const events: UnderwriterEvent[] = [];
  const underwriter = new Underwriter({
    chain,
    chainId: CHAIN_ID,
    account: ACCOUNT,
    document: DOCUMENT,
    onEvent: (event) => events.push(event),
    ...overrides,
  });

  return { underwriter, chain, events };
}

/** A payee nothing here is written for, so a replay that names it is asking for a different spend. */
const OTHER_MERCHANT = '0x9999999999999999999999999999999999999999' as const;

/** The shape every published example uses: the action is the capability label. */
const LABEL = 'gpu.lease:1';
const LABEL_ID = capabilityId(LABEL) as Hex32;

/** A mandate whose capability is written as a label, on both the document and the account. */
function labelled(): ReturnType<typeof build> {
  const built = build({
    document: parseDocument({ ...DOCUMENT_RAW, capabilities: [LABEL_ID], rules: [{ effect: 'allow', pattern: '*' }] }),
  });
  built.chain.rosters.capabilityAllowlist.add(LABEL_ID.toLowerCase());
  built.chain.state.account = {
    ...built.chain.state.account,
    documentHash: documentAnchor({
      chainId: CHAIN_ID,
      account: ACCOUNT,
      version: built.chain.state.account.version,
      documentHash: documentHash(
        parseDocument({ ...DOCUMENT_RAW, capabilities: [LABEL_ID], rules: [{ effect: 'allow', pattern: '*' }] }),
      ),
    }),
  };
  return built;
}

function request(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    requestId: 'r1',
    subject: SUBJECT,
    action: 'gpu.lease',
    amountMicros: toMicro(100_000),
    at: NOW_ISO,
    merchant: MERCHANT,
    capabilityId: CAPABILITY,
    deadline: NOW_SECONDS + 3_600n,
    ...overrides,
  };
}

describe('quote', () => {
  test('allows a spend both the document and the account permit', async () => {
    const { underwriter } = build();
    const quote = await underwriter.quote(request());

    expect(quote.decision).toEqual({ decision: 'allow' });
    expect(quote.source).toBe('account');
    expect(quote.accountVersion).toBe(1n);
    expect(quote.bucket).toBeNull();
  });

  test('names the bucket that ran out rather than refusing generically', async () => {
    const { underwriter, chain } = build();
    chain.state.account = {
      ...chain.state.account,
      remaining: { ...chain.state.account.remaining, daily: toMicro(50_000) },
    };

    const quote = await underwriter.quote(request({ amountMicros: toMicro(100_000) }));
    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.DailyCapExceeded });
    expect(quote.bucket).toBe('daily');
    expect(quote.source).toBe('account');
    expect(quote.chainRefusal?.error).toBe('DailyCapExceeded');
    expect(quote.chainRefusal?.selector).toBe(errorSelector('DailyCapExceeded'));
  });

  test('reports the headroom in every bucket, chain and document alike', async () => {
    const { underwriter } = build();
    const quote = await underwriter.quote(request());

    expect(quote.headroom).toMatchObject({
      perCall: toMicro(1_000_000),
      daily: toMicro(5_000_000),
      monthly: toMicro(50_000_000),
      payeeCap: toMicro(10_000_000),
      balance: toMicro(100_000_000),
      ceiling: toMicro(100_000_000),
    });
  });

  test('carries the escrow deadline window, which previewSpend cannot report', async () => {
    const { underwriter, chain } = build();
    const quote = await underwriter.quote(request());

    expect(quote.deadline).toMatchObject({
      minTtlSeconds: chain.state.terms.minTtlSeconds,
      maxTtlSeconds: chain.state.terms.maxTtlSeconds,
      earliest: NOW_SECONDS + 30n + 60n + 1n,
      latest: NOW_SECONDS + chain.state.terms.maxTtlSeconds - 1n,
    });
  });

  test('refuses a deadline the escrow would reject, even though the account allows the spend', async () => {
    const { underwriter } = build();
    const quote = await underwriter.quote(request({ deadline: NOW_SECONDS + 10n }));

    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.TtlTooShort });
    expect(quote.source).toBe('escrow');
  });

  // The account's own preview has no view of the escrow's floor, so this is the only place a spend
  // under it is stopped before the lock reverts on chain.
  test('refuses an amount under the escrow floor, which the account allows', async () => {
    const { underwriter, chain } = build();
    const quote = await underwriter.quote(request({ amountMicros: toMicro(9_999) }));

    expect(chain.state.terms.minLockMicros).toBe(10_000n);
    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.BelowMinLock });
    expect(quote.source).toBe('escrow');
    expect(quote.bucket).toBeNull();
  });

  test('refuses when the account holds less than the spend', async () => {
    const { underwriter, chain } = build();
    chain.state.account = { ...chain.state.account, balanceMicros: toMicro(1) };

    const quote = await underwriter.quote(request());
    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.AccountUnderfunded });
    expect(quote.bucket).toBe('balance');
  });

  test('refuses a merchant the escrow registry has blacklisted', async () => {
    const { underwriter, chain } = build();
    chain.state.standing = { ...chain.state.standing, blacklisted: true };

    expect((await underwriter.quote(request())).decision).toEqual({
      decision: 'refuse',
      reason: RefuseReason.MerchantBlacklisted,
    });
  });

  test('the account outranks the document when the document is looser', async () => {
    const { underwriter, chain } = build();
    chain.state.account = { ...chain.state.account, paused: true };

    const quote = await underwriter.quote(request());
    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.Paused });
    expect(quote.source).toBe('account');
  });

  test('a document-only rule still refuses when the account would have allowed it', async () => {
    const { underwriter, chain } = build();
    const quote = await underwriter.quote(request({ action: 'storage.put' }));

    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.OutsideMandate });
    expect(quote.source).toBe('document');
    expect(chain.state.calls.previewSpend).toBe(1);
  });

  test('the lifetime ceiling is labelled as enforced by this service, not the contract', async () => {
    const { underwriter } = build();
    const quote = await underwriter.quote(request());

    expect(quote.enforcement).toBe(ENFORCEMENT);
    expect(ENFORCEMENT.service).toContain('lifetime ceiling');
    expect(ENFORCEMENT.contract).toContain('daily rolling window');
    expect(ENFORCEMENT.contract).not.toContain('lifetime ceiling');
  });

  test('an above-threshold spend is a hold carrying the account\'s own threshold', async () => {
    const { underwriter } = build();
    const quote = await underwriter.quote(request({ amountMicros: toMicro(600_000) }));

    expect(quote.decision).toEqual({ decision: 'hold', threshold_micros: toMicro(500_000) });
    expect(quote.source).toBe('account');
  });

  test('the threshold reported is the account\'s, not the document\'s', async () => {
    const { underwriter, chain } = build();
    chain.state.account = {
      ...chain.state.account,
      limits: { ...chain.state.account.limits, approvalThresholdMicros: toMicro(200_000) },
    };

    const quote = await underwriter.quote(request({ amountMicros: toMicro(300_000) }));
    expect(quote.decision).toEqual({ decision: 'hold', threshold_micros: toMicro(200_000) });
  });
});

describe('default deny', () => {
  test('a chain that will not answer refuses', async () => {
    const { underwriter, chain, events } = build();
    chain.state.down = true;

    const quote = await underwriter.quote(request());
    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.ChainUnavailable });
    expect(quote.headroom).toBeNull();
    expect(events.filter((event) => event.type === 'chain_unavailable')).toHaveLength(1);
  });

  test('a selector this build does not recognise still refuses', async () => {
    const { underwriter, chain } = build();
    chain.previewSpend = async () => ({ allowed: false, selector: '0xdeadbeef' });

    const quote = await underwriter.quote(request());
    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.ChainRefusedUnrecognised });
  });

  test('a field the caller left out is named, not answered with a policy that never ran', async () => {
    const { underwriter, chain } = build();

    await expect(underwriter.quote(request({ merchant: undefined }))).rejects.toMatchObject({
      code: 'underwriter_request_invalid',
      details: { field: 'merchant' },
    });

    // An action that is not a capability label carries no id to derive, so the field is required
    // and the message says so. Refusing this as capability_not_allowed would name an allowlist
    // that was never consulted.
    await expect(
      underwriter.quote(request({ action: 'gpu.lease', capabilityId: undefined })),
    ).rejects.toMatchObject({
      code: 'underwriter_request_invalid',
      details: { field: 'capabilityId' },
    });

    expect(chain.state.calls.readAccount).toBe(0);
  });

  test('a capability label in the action is the capability, and is decided against the account', async () => {
    const { underwriter, chain } = labelled();

    const quote = await underwriter.quote(request({ action: LABEL, capabilityId: undefined }));

    expect(quote.decision).toEqual({ decision: 'allow' });
    expect(chain.state.calls.readAccount).toBe(1);
  });

  test('a derived capability is the one recorded in the journal', async () => {
    const { underwriter } = labelled();

    const { entry } = await underwriter.authorize(request({ action: LABEL, capabilityId: undefined }));

    expect(entry.body.kind === 'decision' ? entry.body.capability_id : null).toBe(LABEL_ID);
  });

  test('an amount wider than uint128 is refused rather than truncated', async () => {
    const { underwriter } = build();
    const quote = await underwriter.quote(request({ amountMicros: (1n << 128n) as ReturnType<typeof toMicro> }));

    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.OverPerCallCap });
  });

  test('a document written for another account refuses before any read', async () => {
    const chain = fakeChain();
    const underwriter = new Underwriter({
      chain,
      chainId: CHAIN_ID,
      account: '0x9999999999999999999999999999999999999999',
      document: DOCUMENT,
    });

    const quote = await underwriter.quote(request());
    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.DocumentAccountMismatch });
    expect(chain.state.calls.readAccount).toBe(0);
  });

  test('a document written for another chain refuses', async () => {
    const chain = fakeChain();
    const underwriter = new Underwriter({ chain, chainId: 1, account: ACCOUNT, document: DOCUMENT });

    expect((await underwriter.quote(request())).decision).toEqual({
      decision: 'refuse',
      reason: RefuseReason.DocumentAccountMismatch,
    });
  });

  test('a subject the mandate was not written for refuses', async () => {
    const { underwriter } = build();
    expect((await underwriter.quote(request({ subject: 'wallet:0xdead' }))).decision).toEqual({
      decision: 'refuse',
      reason: RefuseReason.WrongSubject,
    });
  });
});

describe('the Merkle gate previewSpend cannot answer', () => {
  const gated = { merchantGate: { kind: 'merkleRoot', root: merchantLeaf(MERCHANT) } } as const;

  test('a verified proof lets the quote finish the account decision function', async () => {
    const { underwriter } = build({}, gated);
    const quote = await underwriter.quote(request({ merchantProof: [] }));

    expect(quote.decision).toEqual({ decision: 'allow' });
    expect(quote.source).toBe('account');
  });

  test('the threshold is still applied after the proof verifies', async () => {
    const { underwriter } = build({}, gated);
    const quote = await underwriter.quote(request({ amountMicros: toMicro(600_000), merchantProof: [] }));

    expect(quote.decision).toEqual({ decision: 'hold', threshold_micros: toMicro(500_000) });
  });

  test('no proof is a refusal, not an approval', async () => {
    const { underwriter } = build({}, gated);
    expect((await underwriter.quote(request())).decision).toEqual({
      decision: 'refuse',
      reason: RefuseReason.MerchantGateUndecidable,
    });
  });

  test('a proof against the wrong root is a refusal, reported with the selector the account would have used', async () => {
    const { underwriter } = build({}, { merchantGate: { kind: 'merkleRoot', root: `0x${'11'.repeat(32)}` as Hex32 } });
    const quote = await underwriter.quote(request({ merchantProof: [] }));

    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.BadMerkleProof });
    expect(quote.chainRefusal).toMatchObject({ error: 'BadMerkleProof', selector: errorSelector('BadMerkleProof') });
  });

  test('the undecidable case is reported as the account reported it', async () => {
    const { underwriter } = build({}, gated);
    const quote = await underwriter.quote(request());
    expect(quote.chainRefusal).toMatchObject({ error: 'MerkleGateActive', selector: errorSelector('MerkleGateActive') });
  });

  /**
   * The proof is not on the journal, so the re-quote an approval runs had nothing to verify and
   * every held call on a gated account was denied at the moment its principal approved it.
   */
  test('an approval carries the proof into the re-quote', async () => {
    const { underwriter } = build({}, gated);
    const held = await underwriter.authorize(request({ amountMicros: toMicro(600_000), merchantProof: [] }));
    expect(held.decision.decision).toBe('hold');

    const settled = await underwriter.settle('r1', 'approve', NOW_ISO, []);
    expect(settled.decision).toEqual({ decision: 'allow' });
  });

  test('an approval without the proof is still refused', async () => {
    const { underwriter } = build({}, gated);
    await underwriter.authorize(request({ amountMicros: toMicro(600_000), merchantProof: [] }));

    const settled = await underwriter.settle('r1', 'approve', NOW_ISO);
    expect(settled.decision).toEqual({ decision: 'refuse', reason: RefuseReason.MerchantGateUndecidable });
  });
});

describe('divergence', () => {
  test('a document looser than the account is emitted as a trust event and the account still wins', async () => {
    const chain = fakeChain();
    chain.state.nowSeconds = NOW_SECONDS;
    chain.state.account = {
      ...chain.state.account,
      remaining: { ...chain.state.account.remaining, daily: toMicro(10_000) },
      limits: { ...chain.state.account.limits, dailyCapMicros: toMicro(10_000) },
    };

    const events: UnderwriterEvent[] = [];
    const underwriter = new Underwriter({
      chain,
      chainId: CHAIN_ID,
      account: ACCOUNT,
      document: DOCUMENT,
      onEvent: (event) => events.push(event),
    });

    const quote = await underwriter.quote(request({ amountMicros: toMicro(100_000) }));

    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.DailyCapExceeded });
    const divergences = events.filter((event) => event.type === 'divergence');
    expect(divergences.map((event) => (event.type === 'divergence' ? event.divergence.kind : ''))).toContain('daily_limit');
  });

  test('an unanchored account is reported without blocking the spend', async () => {
    const { underwriter, events } = build();
    const chain = fakeChain();
    chain.state.nowSeconds = NOW_SECONDS;

    const unanchored = new Underwriter({
      chain,
      chainId: CHAIN_ID,
      account: ACCOUNT,
      document: DOCUMENT,
      onEvent: (event) => events.push(event),
    });

    const quote = await unanchored.quote(request());
    expect(quote.decision).toEqual({ decision: 'allow' });
    expect(quote.anchor?.unanchored).toBe(true);
    expect(await underwriter.quote(request())).toMatchObject({ anchor: { matches: true } });
  });

  /**
   * `previewSpend` is a chain read like every other, and it sat outside the guard that turns one
   * that will not answer into a refusal. A caller got a 503 with no decision field and no journal
   * entry, against this class's own rule that every path that cannot reach an answer refuses.
   */
  test('a preview that cannot reach the chain refuses instead of throwing', async () => {
    const { underwriter, chain, events } = build();
    chain.previewSpend = async () => {
      throw new ChainUnavailableError('the request timed out after 10000 ms');
    };

    const quote = await underwriter.quote(request());
    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.ChainUnavailable });
    expect(quote.source).toBe('account');
    expect(events.filter((event) => event.type === 'chain_unavailable')).toHaveLength(1);
  });

  test('a preview that cannot reach the chain is still recorded as a decision', async () => {
    const { underwriter, chain } = build();
    chain.previewSpend = async () => {
      throw new ChainUnavailableError('the request timed out after 10000 ms');
    };

    const result = await underwriter.authorize(request());
    expect(result.decision).toEqual({ decision: 'refuse', reason: RefuseReason.ChainUnavailable });
    expect(underwriter.log.length).toBe(1);
  });

  test('an event sink that throws does not turn an allow into a refusal', async () => {
    const chain = fakeChain();
    chain.state.nowSeconds = NOW_SECONDS;
    const underwriter = new Underwriter({
      chain,
      chainId: CHAIN_ID,
      account: ACCOUNT,
      document: DOCUMENT,
      onEvent: () => {
        throw new Error('sink is down');
      },
    });

    expect((await underwriter.quote(request())).decision).toEqual({ decision: 'allow' });
  });
});

describe('authorize', () => {
  test('records the decision with the version that decided it', async () => {
    const { underwriter } = build();
    const result = await underwriter.authorize(request());

    expect(result.idempotent).toBe(false);
    expect(result.entry.body.kind).toBe('decision');
    if (result.entry.body.kind !== 'decision') throw new Error('expected a decision entry');
    expect(result.entry.body.account).toBe(ACCOUNT);
    expect(result.entry.body.account_version).toBe(1n);
    expect(result.entry.body.document_hash).toBe(documentHash(DOCUMENT));
    expect(underwriter.log.verify()).toMatchObject({ valid: true });
  });

  /**
   * Changed on purpose. The retry here used to carry a different amount, which made this test the
   * specification for the hole rather than a proof of idempotency: a second call under an id
   * already on the journal was answered with the first call's verdict whatever it asked for, and
   * the caller then paid the new amount against it. An identical replay is the thing that has to
   * be free, so that is what this asserts, and the case it used to cover has a test of its own
   * below.
   */
  test('a retried id returns the first decision without reading the chain again', async () => {
    const { underwriter, chain } = build();
    await underwriter.authorize(request());
    const reads = chain.state.calls.readAccount;

    const retry = await underwriter.authorize(request());
    expect(retry.idempotent).toBe(true);
    expect(retry.decision).toEqual({ decision: 'allow' });
    expect(retry.quote).toBeNull();
    expect(chain.state.calls.readAccount).toBe(reads);
    expect(underwriter.log.length).toBe(1);
  });

  /**
   * The replayed id. An authenticated caller that reuses an id it already spent under, with a
   * larger amount and a payee of its choosing, was handed the recorded allow: no chain read, no
   * per-call cap, no window, no approval threshold and no second journal entry. The facilitator
   * then applied that allow to the amount in front of it.
   */
  test('a replayed id carrying a different spend is refused, not answered from the journal', async () => {
    const { underwriter, chain } = build();
    await underwriter.authorize(request({ requestId: 'replay-1', amountMicros: toMicro(100_000) }));
    const reads = chain.state.calls.readAccount;

    await expect(
      underwriter.authorize(
        request({ requestId: 'replay-1', amountMicros: toMicro(100_000 * 100_000), merchant: OTHER_MERCHANT }),
      ),
    ).rejects.toMatchObject({ code: 'underwriter_request_replayed', details: { field: 'amountMicros' } });

    // Nothing was decided: no chain read, and the journal still holds one entry.
    expect(chain.state.calls.readAccount).toBe(reads);
    expect(underwriter.log.length).toBe(1);
  });

  test('a replayed id that only changes the payee is refused and names the payee', async () => {
    const { underwriter } = build();
    await underwriter.authorize(request({ requestId: 'replay-2' }));

    await expect(
      underwriter.authorize(request({ requestId: 'replay-2', merchant: OTHER_MERCHANT })),
    ).rejects.toMatchObject({ code: 'underwriter_request_replayed', details: { field: 'merchant' } });
  });

  test('a replay that only restates the timestamp is still a retry', async () => {
    const { underwriter } = build();
    const first = await underwriter.authorize(request({ requestId: 'replay-3' }));

    const retry = await underwriter.authorize(
      request({ requestId: 'replay-3', at: new Date(Number(NOW_SECONDS) * 1000 + 5_000).toISOString() }),
    );
    expect(retry.idempotent).toBe(true);
    expect(retry.decision).toEqual(first.decision);
    expect(underwriter.log.length).toBe(1);
  });

  test('a retry still reading the chain when the first decision lands is not appended twice', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bursar-underwriter-')), 'spend.log');
    const { underwriter, chain } = build({ sink: new FileDecisionSink(path) });

    // The client gave up at ten seconds and the facilitator retried the same nonce, so the second
    // call is past the idempotency guard and inside the chain read while the first one commits.
    let admit = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const readAccount = chain.readAccount.bind(chain);
    let held = false;
    chain.readAccount = async (account, blockNumber) => {
      if (held) await gate;
      held = true;
      return readAccount(account, blockNumber);
    };

    const first = underwriter.authorize(request());
    const retry = underwriter.authorize(request());
    await first;
    admit();

    expect((await retry).idempotent).toBe(true);
    expect((await retry).decision).toEqual((await first).decision);
    expect(underwriter.log.length).toBe(1);
    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(1);
    expect(loadJournal(path).root()).toBe(underwriter.log.root());
  });

  test('the ceiling counts committed spend across authorisations, and only this service applies it', async () => {
    const chain = fakeChain();
    chain.state.nowSeconds = NOW_SECONDS;
    const underwriter = new Underwriter({
      chain,
      chainId: CHAIN_ID,
      account: ACCOUNT,
      // A lifetime ceiling of 150_000 with the account's caps left wide open, so the refusal can
      // only have come from the document.
      document: parseDocument({ ...DOCUMENT_RAW, ceiling_micros: 150_000 }),
    });

    const first = await underwriter.authorize(request({ requestId: 'a', amountMicros: toMicro(100_000) }));
    expect(first.decision).toEqual({ decision: 'allow' });

    const second = await underwriter.authorize(request({ requestId: 'b', amountMicros: toMicro(100_000) }));
    expect(second.decision).toEqual({ decision: 'refuse', reason: RefuseReason.OverCumulativeCeiling });
    expect(second.quote?.source).toBe('document');
    expect(second.quote?.bucket).toBe('ceiling');
  });

  test('a decision reaches the journal before it is committed to memory', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bursar-underwriter-')), 'spend.log');
    const { underwriter } = build({ sink: new FileDecisionSink(path) });

    await underwriter.authorize(request());

    const reloaded = loadJournal(path);
    expect(reloaded.length).toBe(1);
    expect(reloaded.root()).toBe(underwriter.log.root());
  });

  test('emits a decision event carrying the entry hash and the new root', async () => {
    const { underwriter, events } = build();
    const result = await underwriter.authorize(request());

    const decision = events.find((event) => event.type === 'decision');
    expect(decision).toMatchObject({
      requestId: 'r1',
      account: ACCOUNT,
      accountVersion: 1n,
      entryHash: result.entry.entry_hash,
      root: underwriter.log.root(),
    });
  });

  test('a refusal is recorded as faithfully as an allow', async () => {
    const { underwriter, chain } = build();
    chain.state.account = { ...chain.state.account, revoked: true };

    const result = await underwriter.authorize(request());
    expect(result.decision).toEqual({ decision: 'refuse', reason: RefuseReason.Revoked });
    expect(underwriter.log.length).toBe(1);
    expect(underwriter.log.committedMicros()).toBe(0n);
  });
});

describe('the clock a decision is measured against', () => {
  test('refuses an at the caller walked forward past the drift allowance', async () => {
    const { underwriter } = build();

    // A day forward is a fresh daily window, and the contract has no view on the document's
    // windows at all, so nothing downstream would have caught it.
    await expect(
      underwriter.authorize(request({ at: new Date(Number(NOW_SECONDS + 86_400n) * 1000).toISOString() })),
    ).rejects.toThrow(/clock/);
    expect(underwriter.log.length).toBe(0);
  });

  test('refuses an at dated before the mandate expired', async () => {
    const { underwriter } = build({ document: parseDocument({ ...DOCUMENT_RAW, expires_at: '2020-01-01T00:00:00Z' }) });

    await expect(underwriter.authorize(request({ at: '2019-01-01T00:00:00Z' }))).rejects.toThrow(/clock/);
  });

  test('accepts an at inside the drift allowance', async () => {
    const { underwriter } = build();
    const at = new Date(Number(NOW_SECONDS + 29n) * 1000).toISOString();

    expect((await underwriter.quote(request({ at }))).decision).toEqual({ decision: 'allow' });
  });
});

describe('the block a decision is taken at', () => {
  test('every read behind one decision is answered at the same height', async () => {
    const { underwriter, chain } = build({ simulate: true });
    await underwriter.quote(request());

    const heights = chain.state.calls.heights;
    expect(heights.length).toBeGreaterThan(5);
    expect(heights.every((height) => height === chain.state.blockNumber)).toBe(true);
  });

  test('a setLimits landing mid-decision does not decide it, and is not what the journal names', async () => {
    const { underwriter, chain } = build();
    const readAccount = chain.readAccount.bind(chain);

    // The principal narrows the account to nothing in the window between the head reading and the
    // reads taken against it. The decision was already pinned to the block before it.
    chain.readAccount = async (account, blockNumber) => {
      chain.state.account = {
        ...chain.state.account,
        version: 9n,
        remaining: { ...chain.state.account.remaining, daily: toMicro(0) },
      };
      chain.state.blockNumber += 1n;
      return readAccount(account, blockNumber);
    };

    const result = await underwriter.authorize(request());
    expect(result.decision).toEqual({ decision: 'allow' });
    expect(result.quote?.accountVersion).toBe(1n);
    expect(result.entry.body.kind === 'decision' && result.entry.body.account_version).toBe(1n);
  });
});

describe('settle', () => {
  test('approving a hold keeps the reservation and denying releases it', async () => {
    const { underwriter, events } = build();
    await underwriter.authorize(request({ amountMicros: toMicro(600_000) }));
    expect(underwriter.log.committedMicros()).toBe(toMicro(600_000));

    const settled = await underwriter.settle('r1', 'deny', NOW_ISO);
    // A principal declining is its own answer. Reporting the ceiling would have the facilitator
    // record a breach of a limit that was never reached.
    expect(settled.decision).toEqual({ decision: 'refuse', reason: RefuseReason.ApprovalDenied });
    expect(underwriter.log.committedMicros()).toBe(0n);
    expect(events.filter((event) => event.type === 'settlement')).toHaveLength(1);
  });

  test('a settlement is a second entry and never rewrites the hold', async () => {
    const { underwriter } = build();
    await underwriter.authorize(request({ amountMicros: toMicro(600_000) }));
    const holdEntry = underwriter.log.entries[0];

    await underwriter.settle('r1', 'approve', NOW_ISO);
    expect(underwriter.log.entries[0]).toBe(holdEntry);
    expect(underwriter.log.length).toBe(2);
    expect(underwriter.log.verify()).toMatchObject({ valid: true });
  });

  /**
   * An approval used to be a bookkeeping entry: no chain read, no document check and no bound on
   * how long the hold had been sitting. A principal who approved an hour after the account was
   * revoked was paying against a mandate that no longer existed.
   */
  test('approving a hold against an account that has since been revoked pays nothing', async () => {
    const { underwriter, chain } = build();
    await underwriter.authorize(request({ amountMicros: toMicro(600_000) }));
    expect(underwriter.log.committedMicros()).toBe(toMicro(600_000));

    chain.state.account = { ...chain.state.account, revoked: true };

    const settled = await underwriter.settle('r1', 'approve', NOW_ISO);
    expect(settled.decision).toEqual({ decision: 'refuse', reason: RefuseReason.Revoked });
    // Recorded as the denial it is, so the reservation goes back rather than sitting open forever.
    expect(settled.entry.body.kind === 'settlement' && settled.entry.body.resolution).toBe('deny');
    expect(settled.entry.body.kind === 'settlement' && settled.entry.body.reason).toBe(RefuseReason.Revoked);
    expect(underwriter.log.committedMicros()).toBe(0n);
  });

  test('approving a hold re-reads the chain and re-runs the document', async () => {
    const { underwriter, chain } = build();
    await underwriter.authorize(request({ amountMicros: toMicro(600_000) }));
    const reads = chain.state.calls.previewSpend;

    const settled = await underwriter.settle('r1', 'approve', NOW_ISO);
    expect(settled.decision).toEqual({ decision: 'allow' });
    expect(chain.state.calls.previewSpend).toBeGreaterThan(reads);
    // The hold's own reservation is not charged twice: it reserved 600_000 and it still is.
    expect(underwriter.log.committedMicros()).toBe(toMicro(600_000));
  });

  test('a hold nobody answered for a day is refused rather than paid', async () => {
    const { underwriter, chain } = build();
    await underwriter.authorize(request({ amountMicros: toMicro(600_000) }));

    const twoDaysOn = new Date(Number(NOW_SECONDS) * 1000 + 2 * 86_400 * 1000).toISOString();
    chain.state.nowSeconds = NOW_SECONDS + BigInt(2 * 86_400);

    const settled = await underwriter.settle('r1', 'approve', twoDaysOn);
    expect(settled.decision).toEqual({ decision: 'refuse', reason: RefuseReason.HoldExpired });
    expect(underwriter.log.committedMicros()).toBe(0n);
  });
});

describe('refunds', () => {
  const TIMED_OUT = 3;
  const RELEASED = 2;

  /**
   * `Escrow.timeout` gives the money back and credits the account's own buckets. Without an entry
   * for that, the windows this service applies decay toward zero against a contract that has
   * already refunded, and the lifetime ceiling never comes back.
   */
  function narrowDaily(): { underwriter: Underwriter; chain: FakeChain } {
    const chain = fakeChain();
    chain.state.nowSeconds = NOW_SECONDS;
    // Every lock these tests name timed out and handed this account its 100,000 back.
    for (const id of [7n, 8n, 9n]) {
      chain.state.locks.set(id, { id, payer: ACCOUNT, amountMicros: toMicro(100_000), status: TIMED_OUT });
    }
    const underwriter = new Underwriter({
      chain,
      chainId: CHAIN_ID,
      account: ACCOUNT,
      document: parseDocument({ ...DOCUMENT_RAW, daily_limit_micros: 200_000 }),
    });
    return { underwriter, chain };
  }

  test('a window that ran out has room again once the refund is recorded', async () => {
    const { underwriter } = narrowDaily();
    const spend = (id: string): SpendRequest => request({ requestId: id, amountMicros: toMicro(100_000) });

    expect((await underwriter.authorize(spend('a'))).decision).toEqual({ decision: 'allow' });
    expect((await underwriter.authorize(spend('b'))).decision).toEqual({ decision: 'allow' });
    expect((await underwriter.authorize(spend('c'))).decision).toEqual({
      decision: 'refuse',
      reason: RefuseReason.DailyCapExceeded,
    });

    await underwriter.refund('a', toMicro(100_000), NOW_ISO, { escrowId: '7' });

    expect((await underwriter.authorize(spend('d'))).decision).toEqual({ decision: 'allow' });
    expect(underwriter.log.verify()).toMatchObject({ valid: true });
  });

  test('a refund credits only what the decision charged', async () => {
    const { underwriter } = narrowDaily();
    await underwriter.authorize(request({ requestId: 'a', amountMicros: toMicro(100_000) }));

    await expect(underwriter.refund('a', toMicro(100_001), NOW_ISO, { escrowId: '7' })).rejects.toMatchObject({
      code: 'log_not_refundable',
    });
    await underwriter.refund('a', toMicro(40_000), NOW_ISO, { escrowId: '7' });
    await expect(underwriter.refund('a', toMicro(60_001), NOW_ISO, { escrowId: '8' })).rejects.toMatchObject({
      code: 'log_not_refundable',
    });
    expect(underwriter.log.committedMicros()).toBe(toMicro(60_000));
  });

  test('a refund against a refusal is refused: nothing was spent to credit back', async () => {
    const { underwriter } = narrowDaily();
    await underwriter.authorize(request({ requestId: 'a', amountMicros: toMicro(9_000_000) }));

    await expect(underwriter.refund('a', toMicro(1), NOW_ISO, { escrowId: '7' })).rejects.toMatchObject({
      code: 'log_not_refundable',
    });
  });

  /**
   * The route is reachable by whoever holds the token, and a refund hands the ceiling back. Taken
   * on the caller's word, one request resets a lifetime ceiling the principal wrote to be final.
   */
  test('is recorded only against a lock the escrow shows it gave back to this account', async () => {
    const { underwriter, chain } = narrowDaily();
    await underwriter.authorize(request({ requestId: 'a', amountMicros: toMicro(100_000) }));
    const refund = (escrowId?: string) =>
      underwriter.refund('a', toMicro(100_000), NOW_ISO, escrowId === undefined ? {} : { escrowId });

    await expect(refund()).rejects.toMatchObject({ code: 'underwriter_request_invalid' });
    await expect(refund('404')).rejects.toMatchObject({ code: 'log_not_refundable' });

    chain.state.locks.set(10n, { id: 10n, payer: ACCOUNT, amountMicros: toMicro(100_000), status: RELEASED });
    await expect(refund('10')).rejects.toMatchObject({ code: 'log_not_refundable', details: { status: RELEASED } });

    chain.state.locks.set(11n, { id: 11n, payer: MERCHANT, amountMicros: toMicro(100_000), status: TIMED_OUT });
    await expect(refund('11')).rejects.toMatchObject({ code: 'log_not_refundable' });

    chain.state.locks.set(12n, { id: 12n, payer: ACCOUNT, amountMicros: toMicro(99_999), status: TIMED_OUT });
    await expect(refund('12')).rejects.toMatchObject({ code: 'log_not_refundable' });

    chain.state.down = true;
    await expect(refund('7')).rejects.toMatchObject({ code: 'underwriter_chain_unavailable' });

    expect(underwriter.log.committedMicros()).toBe(toMicro(100_000));
  });

  test('credits one escrow lock once, however it is spelled', async () => {
    const { underwriter } = narrowDaily();
    await underwriter.authorize(request({ requestId: 'a', amountMicros: toMicro(100_000) }));
    await underwriter.refund('a', toMicro(40_000), NOW_ISO, { escrowId: '7' });

    await expect(underwriter.refund('a', toMicro(40_000), NOW_ISO, { escrowId: '007' })).rejects.toMatchObject({
      code: 'log_not_refundable',
      details: { escrowId: '7' },
    });
    expect(underwriter.log.committedMicros()).toBe(toMicro(60_000));
  });

  test('is refused by a chain that cannot read a lock at all', async () => {
    const { chain } = narrowDaily();
    const { readEscrowLock: _unused, ...withoutLocks } = chain;
    const underwriter = new Underwriter({ chain: withoutLocks, chainId: CHAIN_ID, account: ACCOUNT, document: DOCUMENT });
    await underwriter.authorize(request({ requestId: 'a', amountMicros: toMicro(100_000) }));

    await expect(underwriter.refund('a', toMicro(1), NOW_ISO, { escrowId: '7' })).rejects.toMatchObject({
      code: 'log_not_refundable',
    });
  });
});

describe('simulation', () => {
  test('an allow is re-checked against the whole spend call when asked', async () => {
    const { underwriter, chain } = build({ simulate: true });
    const quote = await underwriter.quote(request());

    expect(quote.simulated).toBe(true);
    expect(quote.decision).toEqual({ decision: 'allow' });
    expect(chain.state.calls.simulateSpend).toHaveLength(1);
    expect(chain.state.calls.simulateSpend[0]).toMatchObject({ account: ACCOUNT, agent: AGENT, merchant: MERCHANT });
  });

  test('a revert the preview could not predict overrides the allow', async () => {
    const { underwriter, chain } = build({ simulate: true });
    chain.state.simulation = { ok: false, selector: errorSelector('BadTtl') };

    const quote = await underwriter.quote(request());
    expect(quote.decision).toEqual({ decision: 'refuse', reason: RefuseReason.TtlOutOfBounds });
    expect(quote.source).toBe('simulation');
  });

  test('a simulation that cannot reach the chain refuses', async () => {
    const { underwriter, chain } = build({ simulate: true });
    chain.simulateSpend = async () => {
      throw new (await import('../src/errors.js')).ChainUnavailableError('no revert data');
    };

    expect((await underwriter.quote(request())).decision).toEqual({
      decision: 'refuse',
      reason: RefuseReason.ChainUnavailable,
    });
  });

  test('a request with no deadline is simulated against the earliest the escrow takes', async () => {
    const { underwriter, chain } = build({ simulate: true });
    const quote = await underwriter.quote(request({ deadline: undefined }));

    // The facilitator asks before it has picked a deadline, so this is the whole real path.
    expect(quote.simulated).toBe(true);
    expect(chain.state.calls.simulateSpend).toHaveLength(1);
    expect(chain.state.calls.simulateSpend[0]?.deadline).toBe(quote.deadline?.earliest);
  });

  test('simulation is off unless asked for, since it costs a second call', async () => {
    const { underwriter, chain } = build();
    await underwriter.quote(request());
    expect(chain.state.calls.simulateSpend).toHaveLength(0);
  });
});
