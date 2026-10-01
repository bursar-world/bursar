import { describe, expect, it } from 'vitest';
import {
  deriveNonce,
  escrowSettlementNonce,
  hashRequest,
  readRequestURI,
  requestCommit,
  requestDocument,
  requestURI,
} from '../src/index.js';

/**
 * Known answers for the escrow lane.
 *
 * A client written against the README has only the written derivation to go on, so the bytes are
 * pinned here. A change to either derivation is one every client and every facilitator has to make
 * together, and this is where it shows first.
 */
describe('the escrow lane derivations', () => {
  const binding = { requestHash: hashRequest('{"prompt":"a koi"}'), salt: `0x${'5a'.repeat(32)}` as const };
  const document = requestDocument({ method: 'POST', url: 'https://api.provider.dev/render', binding });

  it('pins the request document, its commitment and the URI it is published at', () => {
    expect(binding.requestHash).toBe('c92bf6fd684a4a314f2c91a87add5659a34ea89b50ee1f93daa4e714462b78b7');
    expect(deriveNonce(binding)).toBe('0x4f810efdbacc3a641d0f8c03fd0bb5b13d8fe2d08cd79614f0e26008753eb281');
    expect(document).toEqual({
      method: 'POST',
      resource: 'https://api.provider.dev/render',
      requestNonce: '0x4f810efdbacc3a641d0f8c03fd0bb5b13d8fe2d08cd79614f0e26008753eb281',
    });
    expect(requestCommit(document)).toBe('0xf9a23ab1740d9aaa2fa6dc9a3c1693f55388e7c6a05101fa398d4b4bced20672');
    expect(requestURI(document)).toBe(
      'data:application/vnd.bursar.x402-request+json;base64,' +
        'eyJtZXRob2QiOiJQT1NUIiwicmVxdWVzdE5vbmNlIjoiMHg0ZjgxMGVmZGJhY2MzYTY0MWQwZjhjMDNmZDBiYjViMTNkOGZlMmQwOGNkNzk2MTRmMGUyNjAwODc1M2ViMjgxIiwicmVzb3VyY2UiOiJodHRwczovL2FwaS5wcm92aWRlci5kZXYvcmVuZGVyIn0=',
    );
    expect(readRequestURI(requestURI(document))).toEqual(document);
  });

  it('pins the settlement nonce for a lock opened under that commitment', () => {
    expect(
      escrowSettlementNonce({
        chainId: 4663,
        escrow: '0x4315F8be7C9661345710910577Ec31cb867f3c20',
        lockId: 7n,
        inputCommit: requestCommit(document),
      }),
    ).toBe('0x1418196368293e577152568a40bac115e60707df4e9bdbd4b4d0595490fa606c');
  });
});
