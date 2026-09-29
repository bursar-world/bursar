import { commitCanonical } from '@bursar/core';
import { deriveViewingKey, disclosureSlice, signDeliveryEvidence, viewingKeyMessage } from '@bursar/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { LockStatus } from '../src/chain.js';
import type { LockState } from '../src/chain.js';
import { readDisclosures, viewingKeyring } from '../src/disclosure.js';
import type { DisclosureGrant, DisclosureSource } from '../src/disclosure.js';
import { checkDelivery, createFetcher } from '../src/evidence.js';
import { rule } from '../src/policy.js';
import { ESCROW } from './support/fake-chain.js';

const resolverAccount = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
const otherResolver = privateKeyToAccount(`0x${'c3'.repeat(32)}`);
const payee = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const grantor: Address = '0x877c349EFb5926082C413833E8055F0991185c61';

const INPUT = { task: 'render', input: { frames: 24 } };
const OUTPUT = { url: 'ipfs://frames' };

const LOCK: LockState = {
  payer: grantor,
  payee: payee.address,
  disputer: grantor,
  capabilityId: `0x${'cc'.repeat(32)}`,
  inputCommit: commitCanonical(INPUT),
  outputCommit: `0x${'00'.repeat(32)}`,
  inputURI: 'data:application/vnd.bursar.sealed;base64,AQ==',
  outputURI: '',
  amount: 100_000n,
  deadline: 0n,
  releasedAt: 0n,
  bond: 5_000n,
  disputedAt: 0n,
  status: LockStatus.Disputed,
};

const key = { name: 'resolver-1', address: resolverAccount.address, account: resolverAccount };

async function publicKeyOf(account: typeof resolverAccount): Promise<Hex> {
  return deriveViewingKey(await account.signMessage({ message: viewingKeyMessage(account.address) })).publicKey;
}

function source(grants: DisclosureGrant[], termsCommitment: bigint | null = null): DisclosureSource {
  return { grants: async () => grants, termsCommitment: async () => termsCommitment };
}

async function grant(args: { input?: unknown; to?: typeof resolverAccount; lockId?: bigint } = {}): Promise<DisclosureGrant> {
  const { sliceCommit, ciphertext } = await disclosureSlice({
    escrow: ESCROW,
    lockId: args.lockId ?? 1n,
    input: args.input ?? INPUT,
    output: OUTPUT,
    resolverViewingKey: await publicKeyOf(args.to ?? resolverAccount),
  });
  return { source: 'registry', resolver: resolverAccount.address, grantor, sliceCommit, ciphertext };
}

async function read(grants: DisclosureGrant[]) {
  return readDisclosures({
    source: source(grants),
    keyring: await viewingKeyring([key]),
    escrow: ESCROW,
    escrowId: 1n,
    lock: LOCK,
    fromBlock: 0n,
    toBlock: 10n,
  });
}

describe('disclosure grants', () => {
  it('opens a grant to this resolver and supplies the checked input and output', async () => {
    const reading = await read([await grant()]);
    expect(reading.opened).toBe(1);
    expect(reading.notes).toEqual([]);
    expect(reading.input).toEqual({ document: INPUT });
    expect(reading.outputs.get(commitCanonical(OUTPUT).toLowerCase())).toEqual(OUTPUT);
  });

  it('flags a grant whose input does not match the lock and keeps it out of the evidence', async () => {
    const reading = await read([await grant({ input: { task: 'something else', input: {} } })]);
    expect(reading.input).toBeNull();
    expect(reading.notes).toHaveLength(1);
    expect(reading.notes[0]).toContain("does not hash to the lock's input commitment");

    const ruling = rule({ heldInDispute: true, input: { kind: 'unfetchable', detail: 'sealed' }, deliveries: [], override: null, operatorParty: false, disclosureNotes: reading.notes });
    expect(ruling.ruleId).toBe('P1');
    expect(ruling.reasons[0]).toContain('Disclosure');
  });

  it('notes a grant sealed to another key and a slice about another lock', async () => {
    const reading = await read([await grant({ to: otherResolver }), await grant({ lockId: 2n })]);
    expect(reading.input).toBeNull();
    expect(reading.notes[0]).toContain("does not open with this resolver's viewing key");
    expect(reading.notes[1]).toContain('names another lock');
  });

  it('lets a disclosed output stand in for an output URI that is not public', async () => {
    const reading = await read([await grant()]);
    const outputCommit = commitCanonical(OUTPUT);
    const submission = await signDeliveryEvidence(payee, ESCROW, 4663, {
      escrowId: 1n,
      inputCommit: LOCK.inputCommit,
      outputCommit,
      outputURI: 'http://10.0.0.5/private',
      deliveredAt: 1n,
    });
    if (submission.kind !== 'delivery') throw new Error('delivery');
    const fetcher = createFetcher({ timeoutMs: 1_000, resolve: async () => ['10.0.0.5'] });

    const without = await checkDelivery({ submission, lock: LOCK, inputDocument: INPUT, fetcher, validators: new Map() });
    expect(without.output.kind).toBe('not-public');

    const withGrant = await checkDelivery({ submission, lock: LOCK, inputDocument: INPUT, fetcher, validators: new Map(), disclosedOutputs: reading.outputs });
    expect(withGrant.output).toEqual({ kind: 'verified', wellFormed: true });
  });
});
