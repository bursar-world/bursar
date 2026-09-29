import { readFileSync } from 'node:fs';

import { shieldedArtifacts } from '@bursar/circuits/privacy-pools';
import { encodeAbiParameters, encodeEventTopics, getContractAddress, type Address, type Hex, type Log } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  associationSetCid,
  buildAssociationSet,
  changeSecrets,
  decodeRelayData,
  depositSecrets,
  deriveShieldedKeys,
  encodeRelayData,
  fetchPoolEvents,
  labelOf,
  leanProof,
  leanRoot,
  noteOf,
  nullifierHashOf,
  precommitmentOf,
  proofFromWire,
  proofToWire,
  recoverNotes,
  scopeOf,
  shieldedPoolAbi,
  withdrawInput,
  withdrawSignals,
  withdrawalContext,
  type PoolDeposit,
  type PoolEvents,
} from '../src/index.js';
import { proveRagequit, proveWithdrawal, verifyShieldedProof } from '../src/shielded-prove.js';

const SIGNATURE: Hex = `0x${'ab'.repeat(32)}${'cd'.repeat(32)}1b`;
const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const POOL: Address = '0x9F9914dd397a9e9462Dd7cB6891Ab835119297C7';
const RELAY: Address = '0xEb4978Cab69FF3B958f6Fd1B852C1Ae3d4Ba84f2';
const keys = deriveShieldedKeys(SIGNATURE);
const scope = scopeOf(POOL, 4663, USDG);
const vkey = (name: 'withdraw' | 'commitment') => JSON.parse(readFileSync(shieldedArtifacts[name].vkey, 'utf8'));

const deposit = (overrides: Partial<PoolDeposit> & Pick<PoolDeposit, 'label' | 'value' | 'commitment' | 'precommitment'>): PoolDeposit => ({
  depositor: '0x877c349EFb5926082C413833E8055F0991185c61',
  blockNumber: 1n,
  transactionHash: `0x${'00'.repeat(32)}`,
  logIndex: 0,
  ...overrides,
});

describe('shielded keys and notes', () => {
  it('derives the same keys from the same signature and different ones from another', () => {
    expect(deriveShieldedKeys(SIGNATURE)).toEqual(keys);
    expect(deriveShieldedKeys(`0x${'ab'.repeat(64)}1c`).masterSecret).not.toBe(keys.masterSecret);
    expect(() => deriveShieldedKeys('0x1234')).toThrow(/full wallet signature/);
  });

  it('matches the scope the live pool reports', () => {
    // ShieldedPool.SCOPE() on 4663, recorded at deploy.
    expect(scope).toBe(869543705072628544128504902837391379516070938188476514926978342993992889566n);
  });

  it('matches the scope and commitments in the forge fixture', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../contracts/test/fixtures/shielded.json', import.meta.url), 'utf8'));
    const pool = getContractAddress({ from: '0x00000000000000000000000000000000000e0002', nonce: 0n });
    const fixtureScope = scopeOf(pool, 4663, USDG);
    expect(fixtureScope.toString()).toBe(fixture.scope);
    const note = noteOf(1_000_000n, labelOf(fixtureScope, 1n), depositSecrets(keys, fixtureScope, 0n));
    expect(note.commitment.toString()).toBe(fixture.deposit1.commitment);
    expect(precommitmentOf(depositSecrets(keys, fixtureScope, 0n)).toString()).toBe(fixture.deposit1.precommitment);
  });

  it('round-trips relay data', () => {
    const data = { recipient: RELAY, feeRecipient: POOL, relayFeeBPS: 25n };
    expect(decodeRelayData(encodeRelayData(data))).toEqual(data);
  });
});

describe('lean trees', () => {
  it('a single leaf is its own root at depth zero', () => {
    const proof = leanProof([7n], 7n);
    expect(proof.root).toBe(7n);
    expect(proof.depth).toBe(0);
    expect(proof.siblings).toHaveLength(32);
  });

  it('refuses a leaf that is not there', () => {
    expect(() => leanProof([1n, 2n], 3n)).toThrow(/not in the tree/);
    expect(leanRoot([])).toBe(0n);
  });
});

describe('association set', () => {
  const d1 = deposit({ label: 11n, value: 5n, commitment: 1n, precommitment: 1n });
  const d2 = deposit({ label: 22n, value: 5n, commitment: 2n, precommitment: 2n, depositor: '0x000000000000000000000000000000000000dEaD' });

  it('leaves out blocked depositors and keeps deposit order', () => {
    const set = buildAssociationSet({
      chainId: 4663,
      pool: POOL,
      scope,
      deposits: [d1, d2],
      blocked: new Set<Address>(['0x000000000000000000000000000000000000dEaD']),
      throughBlock: 9n,
    });
    expect(set.labels).toEqual(['11']);
    expect(set.excluded).toEqual([{ label: '22', reason: 'blocked' }]);
    expect(set.root).toBe('11');
  });

  it('has a CIDv1 the Entrypoint accepts, stable across key order', () => {
    const set = buildAssociationSet({ chainId: 4663, pool: POOL, scope, deposits: [d1, d2], blocked: new Set(), throughBlock: 9n });
    const cid = associationSetCid(set);
    expect(cid).toMatch(/^bafkrei[a-z2-7]{52}$/);
    expect(cid.length).toBeGreaterThanOrEqual(32);
    expect(cid.length).toBeLessThanOrEqual(64);
    const reordered = Object.fromEntries(Object.entries(set).reverse()) as typeof set;
    expect(associationSetCid(reordered)).toBe(cid);
  });
});

describe('recovering notes', () => {
  const s0 = depositSecrets(keys, scope, 0n);
  const s1 = depositSecrets(keys, scope, 1n);
  const n0 = noteOf(100_000n, labelOf(scope, 1n), s0);
  const n1 = noteOf(20_000n, labelOf(scope, 2n), s1);
  const change = noteOf(50_000n, n0.label, changeSecrets(keys, n0.label, 0n));
  const events: PoolEvents = {
    deposits: [
      deposit({ label: n0.label, value: n0.value, commitment: n0.commitment, precommitment: precommitmentOf(s0) }),
      deposit({ label: 999n, value: 1n, commitment: 3n, precommitment: 3n }),
      deposit({ label: n1.label, value: n1.value, commitment: n1.commitment, precommitment: precommitmentOf(s1) }),
    ],
    withdrawals: [
      {
        processooor: RELAY,
        value: 50_000n,
        spentNullifier: nullifierHashOf(s0.nullifier),
        newCommitment: change.commitment,
        blockNumber: 2n,
        transactionHash: `0x${'11'.repeat(32)}`,
      },
    ],
    ragequits: [
      { ragequitter: '0x877c349EFb5926082C413833E8055F0991185c61', commitment: n1.commitment, label: n1.label, value: n1.value, blockNumber: 3n, transactionHash: `0x${'22'.repeat(32)}` },
    ],
    leaves: [n0.commitment, 3n, n1.commitment, change.commitment],
    toBlock: 3n,
  };

  it('follows a deposit through its withdrawals and marks ragequits', () => {
    const { notes, nextDepositIndex } = recoverNotes({ keys, scope, events });
    expect(nextDepositIndex).toBe(2n);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ value: 50_000n, commitment: change.commitment, withdrawals: 1, status: 'spendable' });
    expect(notes[1]).toMatchObject({ value: 20_000n, status: 'ragequit' });
  });

  it('finds nothing for other keys', () => {
    const other = deriveShieldedKeys(`0x${'12'.repeat(64)}1b`);
    expect(recoverNotes({ keys: other, scope, events }).notes).toEqual([]);
  });
});

describe('pool events', () => {
  it('reads deposits and leaves in order and refuses a gap', async () => {
    const log = (eventName: 'Deposited' | 'LeafInserted', args: readonly bigint[], logIndex: number, depositor?: Address): Log => {
      const event = shieldedPoolAbi.find((x) => x.type === 'event' && x.name === eventName)!;
      const inputs = (event as { inputs: readonly { type: string; indexed: boolean }[] }).inputs.filter((i) => !i.indexed);
      return {
        address: POOL,
        topics: encodeEventTopics({ abi: shieldedPoolAbi, eventName, args: depositor ? { _depositor: depositor } : {} } as never) as [Hex, ...Hex[]],
        data: encodeAbiParameters(inputs as never, args as never),
        blockNumber: 5n,
        logIndex,
        transactionHash: `0x${'33'.repeat(32)}`,
        transactionIndex: 0,
        blockHash: `0x${'44'.repeat(32)}`,
        removed: false,
      };
    };
    const logs = [
      log('LeafInserted', [1n, 77n, 77n], 1),
      log('Deposited', [77n, 5n, 10_000n, 9n], 2, '0x877c349EFb5926082C413833E8055F0991185c61'),
    ];
    const client = { getBlockNumber: async () => 10n, getLogs: async () => logs } as never;
    const events = await fetchPoolEvents(client, { pool: POOL, fromBlock: 1n });
    expect(events.leaves).toEqual([77n]);
    expect(events.deposits[0]).toMatchObject({ label: 5n, value: 10_000n, precommitment: 9n });

    const gap = { getBlockNumber: async () => 10n, getLogs: async () => [log('LeafInserted', [2n, 78n, 78n], 1)] } as never;
    await expect(fetchPoolEvents(gap, { pool: POOL, fromBlock: 1n })).rejects.toThrow(/gap/);
  });
});

describe('proofs with the official artifacts', () => {
  const s0 = depositSecrets(keys, scope, 0n);
  const note = noteOf(100_000n, labelOf(scope, 1n), s0);
  const other = noteOf(30_000n, labelOf(scope, 2n), depositSecrets(keys, scope, 1n));

  it('proves a relayed withdrawal that verifies and binds the context', async () => {
    const withdrawal = { processooor: RELAY, data: encodeRelayData({ recipient: POOL, feeRecipient: RELAY, relayFeeBPS: 0n }) };
    const context = withdrawalContext(withdrawal, scope);
    const { proof, change } = await proveWithdrawal({
      note,
      amount: 40_000n,
      change: changeSecrets(keys, note.label, 0n),
      stateLeaves: [note.commitment, other.commitment],
      aspLabels: [note.label, other.label],
      context,
      artifacts: shieldedArtifacts.withdraw,
    });
    const signals = withdrawSignals(proof);
    expect(signals.context).toBe(context);
    expect(signals.withdrawnValue).toBe(40_000n);
    expect(signals.existingNullifierHash).toBe(nullifierHashOf(note.nullifier));
    expect(change.value).toBe(60_000n);
    expect(await verifyShieldedProof(vkey('withdraw'), proof)).toBe(true);
    expect(await verifyShieldedProof(vkey('withdraw'), proofFromWire(proofToWire(proof)))).toBe(true);
  }, 60_000);

  it('cannot withdraw more than the note holds or a label outside the set', () => {
    const base = { note, change: changeSecrets(keys, note.label, 0n), stateLeaves: [note.commitment], context: 1n };
    expect(() => withdrawInput({ ...base, amount: 100_001n, aspLabels: [note.label] })).toThrow(/cannot withdraw/);
    expect(() => withdrawInput({ ...base, amount: 1n, aspLabels: [other.label] })).toThrow(/ragequit/);
  });

  it('proves a ragequit that verifies', async () => {
    const proof = await proveRagequit(note, shieldedArtifacts.commitment);
    expect(proof.pubSignals).toEqual([note.commitment, nullifierHashOf(note.nullifier), note.value, note.label]);
    expect(await verifyShieldedProof(vkey('commitment'), proof)).toBe(true);
  }, 60_000);

  it('refuses malformed wire proofs', () => {
    expect(() => proofFromWire({ pA: ['1'], pB: [], pC: [], pubSignals: [] })).toThrow(/pA/);
    expect(() => proofFromWire({ pA: ['1', 'x'], pB: [['1', '1'], ['1', '1']], pC: ['1', '1'], pubSignals: [] })).toThrow(/decimal/);
  });
});
