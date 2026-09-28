import { describe, expect, test } from 'vitest';

import { ANCHOR_DOMAIN, documentAnchor, verifyAnchor } from '../src/anchor.js';
import type { AccountState } from '../src/chain.js';
import { type Hex32, documentHash, parseDocument } from '../src/document.js';
import { ACCOUNT, fakeChain } from './support/fake-chain.js';

const CHAIN_ID = 4_663;

const DOCUMENT = parseDocument({
  subject: 'wallet:0x1111111111111111111111111111111111111111',
  account: ACCOUNT,
  chain_id: CHAIN_ID,
  version: 1,
  expires_at: '2027-01-01T00:00:00Z',
  rules: [{ effect: 'allow', pattern: 'gpu.*' }],
  ceiling_micros: 2_000_000,
  per_call_cap_micros: 1_000_000,
  approval_threshold_micros: 500_000,
});

function stateWith(documentHashValue: Hex32, version = 1n): AccountState {
  const chain = fakeChain();
  return { ...chain.state.account, documentHash: documentHashValue, version };
}

const ANCHOR = documentAnchor({
  chainId: CHAIN_ID,
  account: ACCOUNT,
  version: 1n,
  documentHash: documentHash(DOCUMENT),
});

describe('documentAnchor', () => {
  test('is deterministic', () => {
    expect(documentAnchor({ chainId: CHAIN_ID, account: ACCOUNT, version: 1n, documentHash: documentHash(DOCUMENT) })).toBe(
      ANCHOR,
    );
  });

  test('moves when the version moves, which is what a setLimits does', () => {
    expect(documentAnchor({ chainId: CHAIN_ID, account: ACCOUNT, version: 2n, documentHash: documentHash(DOCUMENT) })).not.toBe(
      ANCHOR,
    );
  });

  test('is bound to the account and the chain', () => {
    expect(
      documentAnchor({
        chainId: CHAIN_ID,
        account: '0x9999999999999999999999999999999999999999',
        version: 1n,
        documentHash: documentHash(DOCUMENT),
      }),
    ).not.toBe(ANCHOR);
    expect(documentAnchor({ chainId: 1, account: ACCOUNT, version: 1n, documentHash: documentHash(DOCUMENT) })).not.toBe(
      ANCHOR,
    );
  });

  test('is not the bare document hash, so an unrelated 32 bytes cannot pass as one', () => {
    expect(ANCHOR).not.toBe(documentHash(DOCUMENT));
    expect(ANCHOR_DOMAIN).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('verifyAnchor', () => {
  test('matches when the account holds the anchor for its live version', () => {
    const status = verifyAnchor(DOCUMENT, stateWith(ANCHOR), CHAIN_ID);
    expect(status.matches).toBe(true);
    expect(status.unanchored).toBe(false);
    expect(status.accountVersion).toBe(1n);
  });

  test('reports an account that never anchored anything', () => {
    const status = verifyAnchor(DOCUMENT, stateWith(`0x${'0'.repeat(64)}`), CHAIN_ID);
    expect(status.unanchored).toBe(true);
    expect(status.matches).toBe(false);
  });

  test('a limit change invalidates the anchor until the document is reissued', () => {
    const status = verifyAnchor(DOCUMENT, stateWith(ANCHOR, 2n), CHAIN_ID);
    expect(status.matches).toBe(false);
    expect(status.expected).toBe(
      documentAnchor({ chainId: CHAIN_ID, account: ACCOUNT, version: 2n, documentHash: documentHash(DOCUMENT) }),
    );
  });

  test('editing the document breaks the match', () => {
    const edited = parseDocument({
      subject: DOCUMENT.subject,
      account: ACCOUNT,
      chain_id: CHAIN_ID,
      version: 1,
      expires_at: DOCUMENT.expiresAt,
      rules: [{ effect: 'allow', pattern: 'gpu.*' }],
      ceiling_micros: 9_000_000,
      per_call_cap_micros: 1_000_000,
      approval_threshold_micros: 500_000,
    });
    expect(verifyAnchor(edited, stateWith(ANCHOR), CHAIN_ID).matches).toBe(false);
  });
});

