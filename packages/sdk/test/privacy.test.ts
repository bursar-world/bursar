import { counterCommitment } from '@bursar/circuits';
import { capabilityId, commitCanonical, committedMandateAccountAbi } from '@bursar/core';
import { encodeAbiParameters, encodeEventTopics, type Hex, type Log } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import {
  FRESH_STATE,
  InvalidArgumentError,
  SealOpenError,
  TermsLockedError,
  TermsMismatchError,
  amendArgs,
  carriedState,
  classesOf,
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
  recoverState,
  seal,
  sealTerms,
  sealedURI,
  viewingKeyMessage,
  viewingKeyOfMetaAddress,
  writeTerms,
  type CounterState,
  type TermsDocument,
} from '../src/index.js';
import { proveSpend, spendArgs, verifySpendProof } from '../src/prove.js';

const principal = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const other = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const PAYEE = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374' as const;
const MANDATE = '0x1A118049d8a039e58BC5DC1e692c16Fa45037aBc' as const;
const ESCROW = '0x4315F8be7C9661345710910577Ec31cb867f3c20' as const;
const RENDER = 'service:gpu.render:1';

async function viewingKeyOf(account: typeof principal) {
  return deriveViewingKey(await account.signMessage({ message: viewingKeyMessage(account.address) }));
}

const input = {
  perCallCap: 100_000n,
  periodCap: 250_000n,
  periodLen: 86_400,
  totalCap: 1_000_000n,
  capabilities: [RENDER, 'service:audio.transcribe:1'],
  counterparties: [PAYEE, other.address],
  expiry: 1_893_456_000,
  label: 'render budget',
};
const terms = writeTerms(input);

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
  const at = { account: MANDATE, version: 1n };

  it('seal to one account and version, and open only with the key, the account and the version', async () => {
    const key = await viewingKeyOf(principal);
    const sealed = await sealTerms(key.termsKey, at, terms);
    const record = { ...at, termsCommitment: commit(terms).termsCommitment, ciphertext: sealed };
    expect(await openTerms(key.termsKey, record)).toEqual(terms);

    await expect(openTerms((await viewingKeyOf(other)).termsKey, record)).rejects.toBeInstanceOf(TermsLockedError);
    await expect(openTerms(key.termsKey, { ...record, account: other.address })).rejects.toBeInstanceOf(TermsLockedError);
    await expect(openTerms(key.termsKey, { ...record, version: 2n })).rejects.toBeInstanceOf(TermsLockedError);
    // Padded, so one counterparty and two look the same length.
    expect((sealed.length - 2) / 2).toBe(1 + 12 + 512 + 16);
  });

  it('refuse a copy that opens but is not the committed document', async () => {
    const key = await viewingKeyOf(principal);
    // The principal's own key sealed it, for the right account and version, and it still does not
    // match what the mandate committed to: say, a wider cap than the one proofs are held to.
    const wider = { ...terms, perCallCap: '250000' } satisfies TermsDocument;
    const sealed = await sealTerms(key.termsKey, at, wider);
    await expect(
      openTerms(key.termsKey, { ...at, termsCommitment: commit(terms).termsCommitment, ciphertext: sealed }),
    ).rejects.toBeInstanceOf(TermsMismatchError);

    const junk = await sealTerms(key.termsKey, at, { v: 2 } as unknown as TermsDocument);
    await expect(openTerms(key.termsKey, { ...at, termsCommitment: 1n, ciphertext: junk })).rejects.toBeInstanceOf(
      TermsMismatchError,
    );
  });

  it('commit with a fresh salt every time', () => {
    const again = writeTerms(input);
    expect(again.salt).not.toBe(terms.salt);
    expect(commit(again).termsCommitment).not.toBe(commit(terms).termsCommitment);
    expect(commit(terms).counter).toBe(counterCommitment(FRESH_STATE, terms.salt));
    expect(commit(terms).nonce).toBe(0n);
  });

  it('commit to capabilities under service and hire only', () => {
    expect(classesOf(terms)).toEqual(['service']);
    expect(classesOf(writeTerms({ ...input, capabilities: ['hire:research.summarize:1', RENDER, RENDER] }))).toEqual(['service', 'hire']);
    expect(writeTerms({ ...input, capabilities: [` ${RENDER} `, RENDER] }).capabilities).toEqual([RENDER]);
    for (const capabilities of [[], ['gpu.render:1'], ['rwa:SPY'], ['service:'], [capabilityId(RENDER)]]) {
      expect(() => writeTerms({ ...input, capabilities })).toThrow(InvalidArgumentError);
    }
  });

  it('refuse terms that cannot hold', () => {
    expect(() => writeTerms({ ...input, perCallCap: 0n, periodCap: 1n, totalCap: 1n })).toThrow();
    expect(() => writeTerms({ ...input, perCallCap: 5n, periodCap: 4n, totalCap: 10n })).toThrow();
  });

  it('start amended terms from the counters they take over', () => {
    const state: CounterState = { period: 20_725n, spent: 30_000n, total: 70_000n, nonce: 4n };
    const same = writeTerms(input, carriedState(state, terms, input.periodLen));
    expect(same.start).toEqual({ period: '20725', spent: '30000', total: '70000', nonce: '4' });
    const [next, counter, nonce, sealedTerms] = amendArgs(same, '0xc1f3');
    expect(next).toBe(commit(same).termsCommitment);
    expect(counter).toBe(counterCommitment(state, same.salt));
    expect(nonce).toBe(4n);
    expect(sealedTerms).toBe('0xc1f3');

    // A new period length restarts the period; the lifetime total and the nonce carry on.
    const weekly = writeTerms({ ...input, periodLen: 604_800 }, carriedState(state, terms, 604_800));
    expect(weekly.start).toEqual({ period: '0', spent: '0', total: '70000', nonce: '4' });
  });
});

describe('prove', () => {
  it('proves a spend for a committed capability and builds the account call from the proof', async () => {
    const proven = await proveSpend({
      terms,
      state: FRESH_STATE,
      mandate: MANDATE,
      payee: PAYEE,
      amount: 10_000n,
      capability: RENDER,
      provenAt: 1_790_600_000n,
    });
    expect(proven.next).toEqual({ period: 1_790_600_000n / 86_400n, spent: 10_000n, total: 10_000n, nonce: 1n });
    const [spend, proof] = spendArgs(proven, { inputCommit: `0x${'22'.repeat(32)}`, inputURI: '', deadline: 1_790_700_000n });
    expect(spend).toMatchObject({ payee: PAYEE, amount: 10_000n, capabilityId: capabilityId(RENDER), newCounter: proven.newCounter });
    expect(proof.a).toHaveLength(2);
    // The capability rides in the public signals as two halves of the id the lock will carry.
    const id = BigInt(capabilityId(RENDER));
    expect(BigInt(proven.publicSignals[7]!)).toBe(id >> 128n);
    expect(BigInt(proven.publicSignals[8]!)).toBe(id & ((1n << 128n) - 1n));
  }, 60_000);

  it('refuses a hire on a services-only mandate before the prover runs', async () => {
    await expect(
      proveSpend({
        terms,
        state: FRESH_STATE,
        mandate: MANDATE,
        payee: PAYEE,
        amount: 10_000n,
        capability: 'hire:research.summarize:1',
        provenAt: 1_790_600_000n,
      }),
    ).rejects.toThrow('capability not allowed');
  });

  it('verifies with the published key and refuses altered signals', async () => {
    const proven = await proveSpend({ terms, state: FRESH_STATE, mandate: MANDATE, payee: PAYEE, amount: 1n, capability: RENDER, provenAt: 1_790_600_000n });
    const proof = {
      pi_a: [...proven.proof.a.map(String), '1'],
      pi_b: [
        [String(proven.proof.b[0][1]), String(proven.proof.b[0][0])],
        [String(proven.proof.b[1][1]), String(proven.proof.b[1][0])],
        ['1', '0'],
      ],
      pi_c: [...proven.proof.c.map(String), '1'],
      protocol: 'groth16',
      curve: 'bn128',
    };
    expect(await verifySpendProof(proven.publicSignals, proof as never)).toBe(true);
    expect(await verifySpendProof(proven.publicSignals.map((s, i) => (i === 5 ? '2' : s)), proof as never)).toBe(false);
    const hire = BigInt(capabilityId('hire:research.summarize:1'));
    const swapped = [...proven.publicSignals];
    swapped[7] = (hire >> 128n).toString();
    swapped[8] = (hire & ((1n << 128n) - 1n)).toString();
    expect(await verifySpendProof(swapped, proof as never)).toBe(false);
  }, 60_000);
});

/**
 * An account's logs and state as the chain would show them, built by replaying spends with the
 * circuit's own counter rule. Only `getLogs` and `readContract` exist: a spend sent through a
 * wallet contract has a transaction whose input is not `spend`, and recovery must not need it.
 */
function chain(account: { version: bigint; nonce: bigint; counter: bigint; spends: { escrowId: bigint; amount: bigint; provenAt: bigint; version: bigint }[] }) {
  const logs: Log[] = [];
  const log = (eventName: 'ProvenSpend' | 'TermsSealed', args: Record<string, unknown>, data: Hex, index: number): Log => ({
    address: MANDATE,
    topics: encodeEventTopics({ abi: committedMandateAccountAbi, eventName, args } as never) as never,
    data,
    blockNumber: BigInt(10 + index),
    logIndex: 0,
    transactionHash: `0x${index.toString(16).padStart(64, '0')}`,
    transactionIndex: 0,
    blockHash: `0x${'aa'.repeat(32)}`,
    removed: false,
  });
  logs.push(log('TermsSealed', { version: 1n }, encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [1n, '0x01']), 0));
  account.spends.forEach((s, i) =>
    logs.push(
      log(
        'ProvenSpend',
        { escrowId: s.escrowId },
        encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'uint64' }],
          [BigInt(i + 1), 7n, s.provenAt, s.version],
        ),
        i + 1,
      ),
    ),
  );
  const amounts = new Map(account.spends.map((s) => [s.escrowId, s.amount]));
  return {
    getLogs: async () => logs,
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === 'escrow') return ESCROW;
      if (functionName === 'nonce') return account.nonce;
      if (functionName === 'counter') return account.counter;
      if (functionName === 'version') return account.version;
      if (functionName === 'getLock') return { amount: amounts.get(args?.[0] as bigint) };
      throw new Error(`unexpected read ${functionName}`);
    },
  };
}

function after(doc: TermsDocument, state: CounterState, amount: bigint, provenAt: bigint): CounterState {
  const period = provenAt / BigInt(doc.periodLen);
  const carried = period === state.period ? state.spent : 0n;
  return { period, spent: carried + amount, total: state.total + amount, nonce: state.nonce + 1n };
}

describe('recovering the counters', () => {
  const DAY = 1_790_600_000n;

  it('reads each spend from its log, so a spend sent through a wallet contract counts the same', async () => {
    const spends = [
      { escrowId: 11n, amount: 40_000n, provenAt: DAY, version: 1n },
      { escrowId: 12n, amount: 25_000n, provenAt: DAY + 60n, version: 1n },
      { escrowId: 15n, amount: 10_000n, provenAt: DAY + 86_400n, version: 1n },
    ];
    let state = FRESH_STATE;
    for (const s of spends) state = after(terms, state, s.amount, s.provenAt);
    const client = chain({ version: 1n, nonce: 3n, counter: counterCommitment(state, terms.salt), spends });

    expect(await recoverState(client as never, MANDATE, terms)).toEqual(state);
    expect(state).toMatchObject({ spent: 10_000n, total: 75_000n, nonce: 3n });
    await expect(recoverState(client as never, MANDATE, writeTerms(input))).rejects.toThrow(/do not match/);
  });

  it('follows an amendment: counts only the current version, from the counters it took over', async () => {
    const v1 = [
      { escrowId: 1n, amount: 40_000n, provenAt: DAY, version: 1n },
      { escrowId: 2n, amount: 30_000n, provenAt: DAY + 10n, version: 1n },
    ];
    let state = FRESH_STATE;
    for (const s of v1) state = after(terms, state, s.amount, s.provenAt);

    const amended = writeTerms({ ...input, perCallCap: 150_000n, periodCap: 300_000n }, carriedState(state, terms, input.periodLen));
    const v2 = [{ escrowId: 3n, amount: 120_000n, provenAt: DAY + 20n, version: 2n }];
    let next = { ...state };
    for (const s of v2) next = after(amended, next, s.amount, s.provenAt);
    expect(next).toMatchObject({ spent: 190_000n, total: 190_000n, nonce: 3n });

    const client = chain({ version: 2n, nonce: 3n, counter: counterCommitment(next, amended.salt), spends: [...v1, ...v2] });
    expect(await recoverState(client as never, MANDATE, amended)).toEqual(next);
    // The superseded terms no longer describe the account.
    await expect(recoverState(client as never, MANDATE, terms)).rejects.toThrow(/do not match/);

    // Straight after the amendment, before any spend, the account holds exactly the carried counters.
    const [, counter, nonce] = amendArgs(amended, '0x');
    const idle = chain({ version: 2n, nonce, counter, spends: v1 });
    expect(await recoverState(idle as never, MANDATE, amended)).toEqual(state);
  });
});

describe('disclosure', () => {
  it('gives one resolver one slice it can check against the chain', async () => {
    const resolver = await viewingKeyOf(other);
    const job = { task: 'render', input: { frames: 24 } };
    const output = { url: 'ipfs://out' };
    const { sliceCommit, ciphertext } = await disclosureSlice({
      escrow: MANDATE,
      lockId: 4n,
      input: job,
      output,
      terms,
      payee: PAYEE,
      resolverViewingKey: resolver.publicKey,
    });

    const opened = await openDisclosure(resolver.privateKey, ciphertext, {
      sliceCommit,
      inputCommit: commitCanonical(job),
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

