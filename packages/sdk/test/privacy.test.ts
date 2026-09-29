import { commitCanonical } from '@bursar/core';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import {
  SealOpenError,
  TermsLockedError,
  commit,
  deriveViewingKey,
  disclosureSlice,
  encodeMetaAddress,
  isSealedURI,
  open,
  openDisclosure,
  openSealedURI,
  openTerms,
  openText,
  seal,
  sealTerms,
  sealedURI,
  viewingKeyMessage,
  viewingKeyOfMetaAddress,
  writeTerms,
} from '../src/index.js';
import { FRESH_STATE, proveSpend, spendArgs, verifySpendProof } from '../src/prove.js';

const principal = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const other = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const PAYEE = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374' as const;
const MANDATE = '0x1A118049d8a039e58BC5DC1e692c16Fa45037aBc' as const;

async function viewingKeyOf(account: typeof principal) {
  return deriveViewingKey(await account.signMessage({ message: viewingKeyMessage(account.address) }));
}

const terms = writeTerms({
  perCallCap: 100_000n,
  periodCap: 250_000n,
  periodLen: 86_400,
  totalCap: 1_000_000n,
  classes: ['service'],
  counterparties: [PAYEE, other.address],
  expiry: 1_893_456_000,
  label: 'render budget',
});

describe('viewing key', () => {
  it('is the same every time the same wallet signs, and different for another wallet', async () => {
    const a = await viewingKeyOf(principal);
    const b = await viewingKeyOf(principal);
    const c = await viewingKeyOf(other);
    expect(a.privateKey).toBe(b.privateKey);
    expect(Buffer.from(a.termsKey).equals(Buffer.from(b.termsKey))).toBe(true);
    expect(a.privateKey).not.toBe(c.privateKey);
    expect(a.publicKey).toMatch(/^0x0[23][0-9a-f]{64}$/);
  });

  it('names the account and says it moves nothing', () => {
    const message = viewingKeyMessage(principal.address);
    expect(message).toContain(principal.address);
    expect(message).toContain('does not move funds');
  });
});

describe('seal', () => {
  it('opens only with the recipient key', async () => {
    const key = await viewingKeyOf(principal);
    const wrong = await viewingKeyOf(other);
    const box = await seal(key.publicKey, 'the brief');
    expect(await openText(key.privateKey, box)).toBe('the brief');
    await expect(open(wrong.privateKey, box)).rejects.toBeInstanceOf(SealOpenError);
    expect(await seal(key.publicKey, 'the brief')).not.toBe(box);
  });

  it('round-trips a sealed job URI and a 6538 meta-address', async () => {
    const key = await viewingKeyOf(principal);
    const meta = encodeMetaAddress(key.publicKey, key.publicKey);
    expect(viewingKeyOfMetaAddress(meta)).toBe(key.publicKey);
    const uri = await sealedURI(viewingKeyOfMetaAddress(meta), '{"task":"render"}');
    expect(isSealedURI(uri)).toBe(true);
    expect(uri).not.toContain('render');
    expect(await openSealedURI(key.privateKey, uri)).toBe('{"task":"render"}');
  });
});

describe('committed terms', () => {
  it('seal under the viewing key and open only with it', async () => {
    const key = await viewingKeyOf(principal);
    const sealed = await sealTerms(key.termsKey, principal.address, terms);
    expect(await openTerms(key.termsKey, principal.address, sealed)).toEqual(terms);
    await expect(openTerms((await viewingKeyOf(other)).termsKey, principal.address, sealed)).rejects.toBeInstanceOf(
      TermsLockedError,
    );
    await expect(openTerms(key.termsKey, other.address, sealed)).rejects.toBeInstanceOf(TermsLockedError);
    // Padded, so one counterparty and two look the same length.
    expect((sealed.length - 2) / 2).toBe(1 + 12 + 512 + 16);
  });

  it('commit with a fresh salt every time', () => {
    const again = writeTerms({ ...terms, perCallCap: 100_000n, periodCap: 250_000n, totalCap: 1_000_000n, classes: ['service'] });
    expect(again.salt).not.toBe(terms.salt);
    expect(commit(again).termsCommitment).not.toBe(commit(terms).termsCommitment);
  });

  it('refuse terms that cannot hold', () => {
    expect(() => writeTerms({ ...terms, perCallCap: 0n, periodCap: 1n, totalCap: 1n, classes: ['service'] })).toThrow();
    expect(() =>
      writeTerms({ ...terms, perCallCap: 5n, periodCap: 4n, totalCap: 10n, classes: ['service'] }),
    ).toThrow();
  });
});

describe('prove', () => {
  it('proves a spend that verifies and builds the account call', async () => {
    const proven = await proveSpend({
      terms,
      state: FRESH_STATE,
      mandate: MANDATE,
      payee: PAYEE,
      amount: 10_000n,
      spendClass: 'service',
      provenAt: 1_790_600_000n,
    });
    expect(proven.next).toEqual({ period: 1_790_600_000n / 86_400n, spent: 10_000n, total: 10_000n, nonce: 1n });
    const [spend, proof] = spendArgs(proven, {
      payee: PAYEE,
      capabilityId: `0x${'11'.repeat(32)}`,
      inputCommit: `0x${'22'.repeat(32)}`,
      inputURI: '',
      amount: 10_000n,
      deadline: 1_790_700_000n,
      spendClass: 'service',
    });
    expect(spend.newCounter).toBe(proven.newCounter);
    expect(proof.a).toHaveLength(2);
    await expect(
      proveSpend({ terms, state: FRESH_STATE, mandate: MANDATE, payee: PAYEE, amount: 10_000n, spendClass: 'hire', provenAt: 1n }),
    ).rejects.toThrow('class not allowed');
  }, 60_000);

  it('verifies with the published key and refuses altered signals', async () => {
    const { groth16 } = await import('snarkjs');
    const { spendInput } = await import('@bursar/circuits');
    const { artifacts } = await import('@bursar/circuits/artifacts');
    const { circuitTerms } = await import('../src/committed.js');
    const { input } = spendInput({
      terms: circuitTerms(terms),
      counterparties: terms.counterparties,
      state: FRESH_STATE,
      mandate: MANDATE,
      payee: PAYEE,
      amount: 1n,
      classId: 0,
      now: 1_790_600_000n,
    });
    const { proof, publicSignals } = await groth16.fullProve(input, artifacts.wasm, artifacts.zkey);
    expect(await verifySpendProof(publicSignals, proof)).toBe(true);
    expect(await verifySpendProof(publicSignals.map((s, i) => (i === 5 ? '2' : s)), proof)).toBe(false);
  }, 60_000);
});

describe('disclosure', () => {
  it('gives one resolver one slice it can check against the chain', async () => {
    const resolver = await viewingKeyOf(other);
    const input = { task: 'render', input: { frames: 24 } };
    const output = { url: 'ipfs://out' };
    const { sliceCommit, ciphertext } = await disclosureSlice({
      escrow: MANDATE,
      lockId: 4n,
      input,
      output,
      terms,
      payee: PAYEE,
      resolverViewingKey: resolver.publicKey,
    });

    const opened = await openDisclosure(resolver.privateKey, ciphertext, {
      sliceCommit,
      inputCommit: commitCanonical(input),
      outputCommit: commitCanonical(output),
      termsCommitment: commit(terms).termsCommitment,
      payee: PAYEE,
    });
    expect(opened.checks).toEqual({ sliceCommit: true, input: true, output: true, terms: true, payee: true });
    expect(JSON.stringify(opened.slice)).not.toContain(other.address.slice(2).toLowerCase());

    const lied = await openDisclosure(resolver.privateKey, ciphertext, {
      sliceCommit,
      inputCommit: commitCanonical({ task: 'something else', input: {} }),
      termsCommitment: 1n,
    });
    expect(lied.checks.input).toBe(false);
    expect(lied.checks.terms).toBe(false);

    await expect(openDisclosure((await viewingKeyOf(principal)).privateKey, ciphertext, { sliceCommit, inputCommit: sliceCommit })).rejects.toBeInstanceOf(SealOpenError);
  });
});
