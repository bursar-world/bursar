import { canonicalStringify, commitCanonical, toDataUri } from '@bursar/core';
import { signDeliveryEvidence } from '@bursar/sdk';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { LockStatus } from '../src/chain.js';
import type { LockState } from '../src/chain.js';
import { checkDelivery, createFetcher, isOperatorParty } from '../src/evidence.js';
import { ESCROW } from './support/fake-chain.js';

const payee = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const OUTPUT = { answer: 42 };

const LOCK: LockState = {
  payer: '0x877c349EFb5926082C413833E8055F0991185c61',
  payee: payee.address,
  disputer: '0x877c349EFb5926082C413833E8055F0991185c61',
  capabilityId: `0x${'cc'.repeat(32)}`,
  inputCommit: `0x${'aa'.repeat(32)}`,
  outputCommit: `0x${'00'.repeat(32)}`,
  inputURI: '',
  outputURI: '',
  amount: 100_000n,
  deadline: 0n,
  releasedAt: 0n,
  bond: 5_000n,
  disputedAt: 0n,
  status: LockStatus.Disputed,
};

const publicHost = async () => ['93.184.215.14'];

function answering(body: string, init: ResponseInit = {}): typeof fetch {
  return (async () => new Response(body, init)) as typeof fetch;
}

describe('fetcher', () => {
  it('reads a base64 data URI in place', async () => {
    const fetcher = createFetcher({ timeoutMs: 1_000 });
    expect(await fetcher(toDataUri('{"a":1}'))).toEqual({ kind: 'ok', text: '{"a":1}' });
  });

  it('reads a percent-encoded data URI', async () => {
    const fetcher = createFetcher({ timeoutMs: 1_000 });
    expect(await fetcher('data:application/json,%7B%22a%22%3A1%7D')).toEqual({ kind: 'ok', text: '{"a":1}' });
  });

  it('refuses a host that resolves to a private address, without connecting', async () => {
    let called = false;
    const fetcher = createFetcher({
      timeoutMs: 1_000,
      resolve: async () => ['10.0.0.8'],
      fetch: (async () => {
        called = true;
        return new Response('{}');
      }) as typeof fetch,
    });

    expect((await fetcher('https://internal.example.com/x')).kind).toBe('not-public');
    expect(await fetcher('http://127.0.0.1:9000/admin')).toMatchObject({ kind: 'not-public' });
    expect(await fetcher('http://[::1]/')).toMatchObject({ kind: 'not-public' });
    expect(await fetcher('http://[::ffff:192.168.1.1]/')).toMatchObject({ kind: 'not-public' });
    expect(called).toBe(false);
  });

  it('refuses a scheme nobody can fetch from', async () => {
    const fetcher = createFetcher({ timeoutMs: 1_000 });
    expect(await fetcher('ipfs://bafy')).toMatchObject({ kind: 'not-public' });
  });

  it('refuses to follow redirects', async () => {
    let asked: RequestInit | undefined;
    const fetcher = createFetcher({
      timeoutMs: 1_000,
      resolve: publicHost,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        asked = init;
        return new Response('{}');
      }) as typeof fetch,
    });
    await fetcher('https://outputs.example.com/1.json');
    expect(asked?.redirect).toBe('error');
  });

  it('stops reading past the size cap', async () => {
    const fetcher = createFetcher({ timeoutMs: 1_000, maxBytes: 8, resolve: publicHost, fetch: answering('0123456789') });
    expect(await fetcher('https://outputs.example.com/1.json')).toMatchObject({ kind: 'unfetchable' });
  });

  it('reports an HTTP failure as unfetchable', async () => {
    const fetcher = createFetcher({ timeoutMs: 1_000, resolve: publicHost, fetch: answering('', { status: 404 }) });
    expect(await fetcher('https://outputs.example.com/1.json')).toEqual({ kind: 'unfetchable', detail: 'HTTP 404' });
  });
});

describe('delivery checks', () => {
  const sign = (outputCommit = commitCanonical(OUTPUT), outputURI = toDataUri(canonicalStringify(OUTPUT))) =>
    signDeliveryEvidence(payee, ESCROW, 4663, { escrowId: 1n, inputCommit: LOCK.inputCommit, outputCommit, outputURI, deliveredAt: 1n });

  it('verifies a delivery signed by the payee whose output matches', async () => {
    const submission = await sign();
    if (submission.kind !== 'delivery') throw new Error('delivery');
    const check = await checkDelivery({ submission, lock: LOCK, inputDocument: null, fetcher: createFetcher({ timeoutMs: 1_000 }), validators: new Map() });

    expect(check).toMatchObject({ signedByPayee: true, inputMatches: true, output: { kind: 'verified', wellFormed: true }, validator: 'none' });
  });

  it('marks an empty output as not well-formed', async () => {
    const submission = await sign(commitCanonical({}), toDataUri('{}'));
    if (submission.kind !== 'delivery') throw new Error('delivery');
    const check = await checkDelivery({ submission, lock: LOCK, inputDocument: null, fetcher: createFetcher({ timeoutMs: 1_000 }), validators: new Map() });

    expect(check.output).toEqual({ kind: 'verified', wellFormed: false });
  });

  it('runs a published validator, and treats one that throws as a rejection', async () => {
    const submission = await sign();
    if (submission.kind !== 'delivery') throw new Error('delivery');
    const fetcher = createFetcher({ timeoutMs: 1_000 });

    const partial = await checkDelivery({ submission, lock: LOCK, inputDocument: null, fetcher, validators: new Map([[LOCK.capabilityId, () => 'partial' as const]]) });
    expect(partial.validator).toBe('partial');

    const broken = await checkDelivery({
      submission,
      lock: LOCK,
      inputDocument: null,
      fetcher,
      validators: new Map([
        [
          LOCK.capabilityId,
          () => {
            throw new Error('bug');
          },
        ],
      ]),
    });
    expect(broken.validator).toBe('fail');
  });
});

describe('operator party', () => {
  it('matches the payer or the payee, case-blind, and nothing when unconfigured', () => {
    expect(isOperatorParty(LOCK, [LOCK.payer.toLowerCase() as `0x${string}`])).toBe(true);
    expect(isOperatorParty(LOCK, [payee.address])).toBe(true);
    expect(isOperatorParty(LOCK, ['0x1111111111111111111111111111111111111111'])).toBe(false);
    expect(isOperatorParty(LOCK, null)).toBe(false);
  });
});
