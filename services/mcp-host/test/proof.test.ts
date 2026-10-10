import { assistantConnectMessage } from '@bursar/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { ProofError, readConnectRequest, verifyProof } from '../src/proof.js';
import type { ConnectRequest } from '../src/proof.js';
import { fakeReads } from './support/fakes.js';

const owner = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
const MANDATE = '0x00000000000000000000000000000000000acc01' as const;
const NONCE: Hex = `0x${'0f'.repeat(16)}`;
const NOW = new Date('2026-10-10T12:00:00.000Z');

async function signed(overrides: Partial<ConnectRequest> = {}, by = owner): Promise<ConnectRequest> {
  const fields = { mandate: MANDATE, owner: owner.address, chainId: 4663, nonce: NONCE, issuedAt: '2026-10-10T11:59:00.000Z', ...overrides };
  const signature = await by.signMessage({ message: assistantConnectMessage(fields) });
  return { ...fields, signature, ...overrides };
}

const options = { chainId: 4663, reads: fakeReads({ [MANDATE]: owner.address }), windowSeconds: 600, now: () => NOW };

describe('the ownership proof', () => {
  it('accepts the principal signing the message the console builds', async () => {
    await expect(verifyProof(await signed(), options)).resolves.toEqual({ principal: owner.address });
    await expect(verifyProof(await signed({ label: 'Claude' }), options)).resolves.toEqual({ principal: owner.address });
  });

  it('refuses a signature by anyone but the mandate principal', async () => {
    const request = await signed({ owner: stranger.address }, stranger);
    await expect(verifyProof(request, options)).rejects.toMatchObject({ code: 'not_owner', status: 403 });
  });

  it('refuses a signature that does not match the fields', async () => {
    const request = await signed();
    await expect(verifyProof({ ...request, label: 'edited' }, options)).rejects.toMatchObject({ code: 'bad_signature' });
    await expect(verifyProof({ ...request, signature: `0x${'00'.repeat(65)}` }, options)).rejects.toMatchObject({ code: 'bad_signature' });
  });

  it('refuses a stale signature and one for another chain', async () => {
    await expect(verifyProof(await signed({ issuedAt: '2026-10-10T11:00:00.000Z' }), options)).rejects.toMatchObject({ code: 'proof_expired' });
    await expect(verifyProof(await signed({ chainId: 1 }), options)).rejects.toMatchObject({ code: 'wrong_chain', status: 400 });
  });

  it('refuses an address that is not a mandate', async () => {
    const request = await signed({ mandate: '0x00000000000000000000000000000000000acc09' });
    await expect(verifyProof(request, options)).rejects.toMatchObject({ code: 'no_mandate_account', status: 400 });
  });
});

describe('reading the request', () => {
  it('names the first field that cannot hold', () => {
    expect(() => readConnectRequest(null)).toThrow(ProofError);
    expect(() => readConnectRequest({ mandate: 'nope' })).toThrow(/mandate is a 0x address/u);
    expect(() => readConnectRequest({ mandate: MANDATE, owner: owner.address, chainId: '4663' })).toThrow(/chainId/u);
    expect(() => readConnectRequest({ mandate: MANDATE, owner: owner.address, chainId: 4663, nonce: '0x12' })).toThrow(/nonce/u);
    expect(() =>
      readConnectRequest({ mandate: MANDATE, owner: owner.address, chainId: 4663, nonce: NONCE, issuedAt: 'yesterday' }),
    ).toThrow(/issuedAt/u);
    expect(() =>
      readConnectRequest({ mandate: MANDATE, owner: owner.address, chainId: 4663, nonce: NONCE, issuedAt: NOW.toISOString(), signature: '0x12' }),
    ).toThrow(/signature/u);
    expect(() =>
      readConnectRequest({
        mandate: MANDATE,
        owner: owner.address,
        chainId: 4663,
        nonce: NONCE,
        issuedAt: NOW.toISOString(),
        signature: `0x${'00'.repeat(65)}`,
        label: 'x'.repeat(41),
      }),
    ).toThrow(/at most 40/u);
  });
});
