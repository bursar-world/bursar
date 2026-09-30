import { readFileSync } from 'node:fs';

import { shieldedArtifacts } from '@bursar/circuits/privacy-pools';
import { encodeAbiParameters, encodeEventTopics, getContractAddress, type Address, type Hex, type Log } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FundsKeySignatureError,
  ShieldedServiceError,
  associationSetCid,
  buildAssociationSet,
  changeSecrets,
  decodeRelayData,
  depositSecrets,
  deriveLegacyShieldedKeys,
  deriveShieldedKeys,
  encodeRelayData,
  fetchPoolEvents,
  fundsKeyTypedData,
  isStaleSetRefusal,
  labelOf,
  leanProof,
  leanRoot,
  noteOf,
  nullifierHashOf,
  precommitmentOf,
  proofFromWire,
  proofToWire,
  randomShieldedKeys,
  recoverNotes,
  relayWithFreshProof,
  scopeOf,
  shieldedKeyFile,
  shieldedPoolAbi,
  viewingKeyMessage,
  withdrawInput,
  withdrawSignals,
  withdrawalContext,
  type PoolDeposit,
  type PoolEvents,
} from '../src/index.js';
import { proveRagequit, proveWithdrawal, verifyShieldedProof } from '../src/shielded-prove.js';

const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const POOL: Address = '0x9F9914dd397a9e9462Dd7cB6891Ab835119297C7';
const RELAY: Address = '0xEb4978Cab69FF3B958f6Fd1B852C1Ae3d4Ba84f2';
const WALLET = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const OTHER_WALLET = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const CONTEXT = { account: WALLET.address, chainId: 4663, pool: POOL };
const FUNDS_SIGNATURE = await WALLET.signTypedData(fundsKeyTypedData(CONTEXT));
const keys = deriveShieldedKeys(FUNDS_SIGNATURE, CONTEXT);
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
  it('derives the same keys from the same funds signature and different ones for another wallet', async () => {
    expect(deriveShieldedKeys(FUNDS_SIGNATURE, CONTEXT)).toEqual(keys);
    const other = { ...CONTEXT, account: OTHER_WALLET.address };
    const theirs = deriveShieldedKeys(await OTHER_WALLET.signTypedData(fundsKeyTypedData(other)), other);
    expect(theirs.masterSecret).not.toBe(keys.masterSecret);
  });

  it('refuses a signature that does not recover to the wallet under the funds-key request', async () => {
    const refusals: Hex[] = [
      // The viewing-key signature opens terms and scans announcements; it never reaches a note.
      await WALLET.signMessage({ message: viewingKeyMessage(WALLET.address) }),
      await OTHER_WALLET.signTypedData(fundsKeyTypedData(CONTEXT)),
      await WALLET.signTypedData(fundsKeyTypedData({ ...CONTEXT, pool: RELAY })),
      await WALLET.signTypedData(fundsKeyTypedData({ ...CONTEXT, chainId: 46630 })),
      `0x${'ab'.repeat(32)}${'cd'.repeat(32)}1b`,
      '0x1234',
    ];
    for (const signature of refusals) expect(() => deriveShieldedKeys(signature, CONTEXT)).toThrow(FundsKeySignatureError);
  });

  it('still derives the first pool’s note keys from a viewing signature, for taking those notes out', () => {
    // The values the viewing-key derivation gave before the funds key existed.
    expect(deriveLegacyShieldedKeys(`0x${'ab'.repeat(32)}${'cd'.repeat(32)}1b`)).toEqual({
      masterNullifier: 6968148174701025591958108559111589585022819118975213753984376136686489770738n,
      masterSecret: 2453207523900687570215845775606449979013423318585098943477694010259938415376n,
    });
    expect(() => deriveLegacyShieldedKeys('0x1234')).toThrow(/full wallet signature/);
  });

  it('matches the scope the live pool reports', () => {
    // ShieldedPool.SCOPE() on 4663, recorded at deploy.
    expect(scope).toBe(869543705072628544128504902837391379516070938188476514926978342993992889566n);
  });

  it('matches the scope and commitments in the forge fixture', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../contracts/test/fixtures/shielded.json', import.meta.url), 'utf8'));
    const pool = getContractAddress({ from: '0x00000000000000000000000000000000000e0002', nonce: 0n });
    const fixtureScope = scopeOf(pool, 4663, USDG);
    expect(fixtureScope.toString()).toBe(fixture.scope);
    const context = { ...CONTEXT, pool };
    const fixtureKeys = deriveShieldedKeys(await WALLET.signTypedData(fundsKeyTypedData(context)), context);
    const note = noteOf(1_000_000n, labelOf(fixtureScope, 1n), depositSecrets(fixtureKeys, fixtureScope, 0n));
    expect(note.commitment.toString()).toBe(fixture.deposit1.commitment);
    expect(precommitmentOf(depositSecrets(fixtureKeys, fixtureScope, 0n)).toString()).toBe(fixture.deposit1.precommitment);
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
    expect(recoverNotes({ keys: randomShieldedKeys(), scope, events }).notes).toEqual([]);
    expect(recoverNotes({ keys: deriveLegacyShieldedKeys(`0x${'12'.repeat(64)}1b`), scope, events }).notes).toEqual([]);
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

describe('shielded key files', () => {
  it('writes the file the MCP server reads, with fresh keys each time', () => {
    const a = randomShieldedKeys();
    expect(a).not.toEqual(randomShieldedKeys());
    const file = shieldedKeyFile(a, POOL, 4663);
    expect(file).toMatchObject({ kind: 'bursar-shielded-keys', version: 1, chainId: 4663, pool: POOL });
    expect(BigInt(file.masterNullifier)).toBe(a.masterNullifier);
    expect(BigInt(file.masterSecret)).toBe(a.masterSecret);
  });
});

describe('relaying against a moving association set', () => {
  const withdrawal = { processooor: RELAY, data: encodeRelayData({ recipient: POOL, feeRecipient: RELAY, relayFeeBPS: 0n }) };
  const proofFor = (attempt: number) => ({
    pA: [BigInt(attempt), 2n] as const,
    pB: [[3n, 4n], [5n, 6n]] as const,
    pC: [7n, 8n] as const,
    pubSignals: [1n, 2n, 3n, 4n, 5n, BigInt(attempt), 7n, 8n],
  });
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proves again when the relayer says the root moved, and sends the new proof', async () => {
    const sent: unknown[] = [];
    const replies = [
      answer(409, { error: 'stale_association_set', detail: 'The association set changed since this proof was made.' }),
      answer(400, { error: 'would_revert', detail: 'The pool would refuse this withdrawal: IncorrectASPRoot.' }),
      answer(200, { transactionHash: `0x${'cc'.repeat(32)}`, gasDropWei: '0' }),
    ];
    vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string));
      return replies.shift()!;
    });
    const attempts: number[] = [];
    const result = await relayWithFreshProof({
      relayerUrl: 'https://relayer.example',
      withdrawal,
      prove: async (attempt) => {
        attempts.push(attempt);
        return proofFor(attempt);
      },
    });
    expect(result.transactionHash).toBe(`0x${'cc'.repeat(32)}`);
    expect(attempts).toEqual([1, 2, 3]);
    expect(sent.map((body) => (body as { proof: { pubSignals: string[] } }).proof.pubSignals[5])).toEqual(['1', '2', '3']);
  });

  it('gives up after the last attempt, and never retries a refusal about anything else', async () => {
    vi.stubGlobal('fetch', async () => answer(409, { error: 'stale_association_set', detail: 'moved' }));
    const prove = vi.fn(async (attempt: number) => proofFor(attempt));
    await expect(relayWithFreshProof({ relayerUrl: 'https://relayer.example', withdrawal, prove, attempts: 2 })).rejects.toSatisfy(isStaleSetRefusal);
    expect(prove).toHaveBeenCalledTimes(2);

    vi.stubGlobal('fetch', async () => answer(403, { error: 'recipient_blocked', detail: 'blocked' }));
    prove.mockClear();
    const refusal = relayWithFreshProof({ relayerUrl: 'https://relayer.example', withdrawal, prove });
    await expect(refusal).rejects.toBeInstanceOf(ShieldedServiceError);
    await expect(refusal).rejects.toMatchObject({ status: 403, code: 'recipient_blocked' });
    expect(prove).toHaveBeenCalledTimes(1);
  });
});
