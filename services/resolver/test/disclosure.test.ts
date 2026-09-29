import { commitCanonical } from '@bursar/core';
import { deriveViewingKey, disclosureSlice, signDeliveryEvidence, viewingKeyMessage } from '@bursar/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { LockStatus } from '../src/chain.js';
import type { LockState } from '../src/chain.js';
import { readDisclosures, scanGrants, viewingKeyring } from '../src/disclosure.js';
import type { DisclosureGrant, DisclosureSource, GrantCheckpoint } from '../src/disclosure.js';
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
    grants,
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

describe('grant scan', () => {
  const resolvers = [resolverAccount.address];
  const stub = (at: bigint): DisclosureGrant => ({
    source: 'registry',
    resolver: resolverAccount.address,
    grantor,
    sliceCommit: `0x${at.toString(16).padStart(64, '0')}`,
    ciphertext: '0x01',
  });

  /** A source with one grant at each of `blocks`, recording every range it was asked for. */
  function recording(blocks: bigint[]) {
    const ranges: [bigint, bigint][] = [];
    const src: DisclosureSource = {
      grants: async (_escrow, _lockId, _resolvers, from, to) => {
        ranges.push([from, to]);
        return blocks.filter((block) => block >= from && block <= to).map(stub);
      },
      termsCommitment: async () => null,
    };
    return { src, ranges };
  }

  const base = { escrow: ESCROW, escrowId: 1n, resolvers } as const;

  it('starts at the deploy block with no checkpoint and steps in chunks that meet exactly', async () => {
    const { src, ranges } = recording([1_000n, 1_099n, 1_100n, 1_250n]);
    const saved: GrantCheckpoint[] = [];
    const grants = await scanGrants({ ...base, source: src, fromBlock: 1_000n, toBlock: 1_250n, chunk: 100n, save: async (c) => void saved.push(c) });
    expect(ranges).toEqual([
      [1_000n, 1_099n],
      [1_100n, 1_199n],
      [1_200n, 1_250n],
    ]);
    expect(grants).toHaveLength(4);
    expect(saved.map((c) => c.scannedTo)).toEqual([1_099n, 1_199n, 1_250n]);
    expect(saved.at(-1)).toMatchObject({ from: 1_000n, grants });
  });

  it('resumes after the checkpoint and keeps the grants it already found', async () => {
    const { src, ranges } = recording([1_050n, 1_300n]);
    const checkpoint: GrantCheckpoint = { from: 1_000n, scannedTo: 1_250n, resolvers, grants: [stub(1_050n)] };
    const grants = await scanGrants({ ...base, source: src, fromBlock: 1_000n, toBlock: 1_400n, chunk: 100n, checkpoint });
    expect(ranges).toEqual([
      [1_251n, 1_350n],
      [1_351n, 1_400n],
    ]);
    expect(grants.map((g) => g.sliceCommit)).toEqual([stub(1_050n).sliceCommit, stub(1_300n).sliceCommit]);
  });

  it('reads nothing when the checkpoint is already at the head', async () => {
    const { src, ranges } = recording([]);
    const checkpoint: GrantCheckpoint = { from: 1_000n, scannedTo: 1_400n, resolvers, grants: [stub(1_050n)] };
    const grants = await scanGrants({ ...base, source: src, fromBlock: 1_000n, toBlock: 1_400n, checkpoint });
    expect(ranges).toEqual([]);
    expect(grants).toHaveLength(1);
  });

  it('starts again when the checkpoint began later or filtered on other resolvers', async () => {
    for (const checkpoint of [
      { from: 1_100n, scannedTo: 1_300n, resolvers, grants: [] },
      { from: 1_000n, scannedTo: 1_300n, resolvers: [otherResolver.address], grants: [stub(1_200n)] },
    ] satisfies GrantCheckpoint[]) {
      const { src, ranges } = recording([1_200n]);
      const grants = await scanGrants({ ...base, source: src, fromBlock: 1_000n, toBlock: 1_300n, chunk: 1_000n, checkpoint });
      expect(ranges).toEqual([[1_000n, 1_300n]]);
      expect(grants).toHaveLength(1);
    }
  });

  it('keeps the progress saved before a failed step', async () => {
    let calls = 0;
    const src: DisclosureSource = {
      grants: async (_e, _l, _r, from) => {
        calls += 1;
        if (calls === 2) throw new Error('provider refused the range');
        return [stub(from)];
      },
      termsCommitment: async () => null,
    };
    let last: GrantCheckpoint | null = null;
    await expect(scanGrants({ ...base, source: src, fromBlock: 0n, toBlock: 299n, chunk: 100n, save: async (c) => void (last = c) })).rejects.toThrow('refused');
    expect(last).toMatchObject({ scannedTo: 99n });

    const { src: retry, ranges } = recording([]);
    const grants = await scanGrants({ ...base, source: retry, fromBlock: 0n, toBlock: 299n, chunk: 100n, checkpoint: last });
    expect(ranges).toEqual([
      [100n, 199n],
      [200n, 299n],
    ]);
    expect(grants).toHaveLength(1);
  });
});
