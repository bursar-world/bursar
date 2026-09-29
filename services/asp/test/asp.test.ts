import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { associationSetCid, leanRoot, shieldedPoolAbi } from '@bursar/sdk';
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeEventTopics,
  toFunctionSelector,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { SetStore, computeSet, handle, syncRoot, type Pool, type PublishedSet } from '../src/index.js';

const POOL: Address = '0x9F9914dd397a9e9462Dd7cB6891Ab835119297C7';
const ENTRYPOINT: Address = '0xADc02737378a86c0fB8231964C658A7AB81eeaa2';
const REGISTRY: Address = '0xe10b6f6B275de231345c20D14Ab812db62151b00';
const ALICE: Address = '0x877c349EFb5926082C413833E8055F0991185c61';
const MALLORY: Address = '0x000000000000000000000000000000000000dEaD';
const pool: Pool = { chainId: 4663, pool: POOL, scope: 5n, registry: REGISTRY, fromBlock: 100n };

let logIndex = 0;
function depositLog(depositor: Address, label: bigint, leafIndex: number): Log[] {
  const base = {
    address: POOL,
    blockNumber: 150n,
    transactionHash: `0x${'aa'.repeat(32)}` as Hex,
    transactionIndex: 0,
    blockHash: `0x${'bb'.repeat(32)}` as Hex,
    removed: false,
  };
  const leaf = {
    ...base,
    logIndex: logIndex++,
    topics: encodeEventTopics({ abi: shieldedPoolAbi, eventName: 'LeafInserted' }) as [Hex],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [BigInt(leafIndex), label * 10n, 1n]),
  };
  const deposit = {
    ...base,
    logIndex: logIndex++,
    topics: encodeEventTopics({ abi: shieldedPoolAbi, eventName: 'Deposited', args: { _depositor: depositor } }) as [Hex, Hex],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [label * 10n, label, 100_000n, label * 7n],
    ),
  };
  return [leaf, deposit];
}

function chainWith(logs: Log[], blocked: Address[]) {
  return {
    getBlockNumber: async () => 200n,
    getLogs: vi.fn(async () => logs),
    readContract: vi.fn(async ({ args }: { args: readonly [Address] }) => blocked.includes(args[0])),
  };
}

describe('computeSet', () => {
  it('admits every deposit whose depositor is not blocked, in deposit order', async () => {
    const logs = [...depositLog(ALICE, 11n, 1), ...depositLog(MALLORY, 22n, 2), ...depositLog(ALICE, 33n, 3)];
    const client = chainWith(logs, [MALLORY]);
    const set = await computeSet(client as never, pool);
    expect(set.labels).toEqual(['11', '33']);
    expect(set.excluded).toEqual([{ label: '22', reason: 'blocked' }]);
    expect(set.root).toBe(leanRoot([11n, 33n]).toString());
    expect(set.throughBlock).toBe('200');
    const { cid, ...document } = set;
    expect(cid).toBe(associationSetCid(document));
    // One registry read per distinct depositor.
    expect(client.readContract).toHaveBeenCalledTimes(2);
  });
});

const set = (root: string, labels: string[] = ['1'], throughBlock = '10'): PublishedSet => ({
  version: 1,
  chainId: 4663,
  pool: POOL,
  scope: '5',
  labels,
  excluded: [],
  root,
  depth: 0,
  throughBlock,
  cid: `bafkrei${root.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!).padStart(52, 'a')}`,
});

const noRoots = () => {
  const error = new ContractFunctionRevertedError({ abi: [{ type: 'error', name: 'NoRootsAvailable', inputs: [] }], data: toFunctionSelector('NoRootsAvailable()'), functionName: 'latestRoot' });
  return new BaseError('reverted', { cause: error });
};

describe('syncRoot', () => {
  const account = { address: ALICE, type: 'json-rpc' } as const;

  it('skips an empty set and an unchanged root', async () => {
    const client = { readContract: vi.fn(async () => 7n), simulateContract: vi.fn(), waitForTransactionReceipt: vi.fn() };
    const wallet = { account, writeContract: vi.fn() };
    expect(await syncRoot({ client: client as never, wallet: wallet as never, chain: {} as never, entrypoint: ENTRYPOINT, set: set('0', []) })).toMatchObject({ action: 'skipped', reason: 'no admissible deposits yet' });
    expect(await syncRoot({ client: client as never, wallet: wallet as never, chain: {} as never, entrypoint: ENTRYPOINT, set: set('7') })).toMatchObject({ action: 'skipped', reason: 'the chain already holds this root' });
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it('posts the first root and a changed one, with the CID', async () => {
    for (const current of [noRoots(), 7n]) {
      const client = {
        readContract: vi.fn(async () => {
          if (current instanceof Error) throw current;
          return current;
        }),
        simulateContract: vi.fn(async (req: { args: readonly unknown[] }) => ({ request: req })),
        waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
      };
      const wallet = { account, writeContract: vi.fn(async () => `0x${'cc'.repeat(32)}`) };
      const outcome = await syncRoot({ client: client as never, wallet: wallet as never, chain: {} as never, entrypoint: ENTRYPOINT, set: set('9') });
      expect(outcome.action).toBe('posted');
      expect(client.simulateContract.mock.calls[0]![0].args).toEqual([9n, set('9').cid]);
    }
  });

  it('reports a dry run without a wallet', async () => {
    const client = { readContract: vi.fn(async () => 7n), simulateContract: vi.fn(), waitForTransactionReceipt: vi.fn() };
    expect(await syncRoot({ client: client as never, chain: {} as never, entrypoint: ENTRYPOINT, set: set('9') })).toMatchObject({ action: 'skipped', reason: 'dry run' });
  });
});

describe('http', () => {
  it('serves the set whose root the chain holds, and sets by CID', async () => {
    const store = new SetStore(join(mkdtempSync(join(tmpdir(), 'asp-')), 'sets'));
    store.put(set('7', ['1'], '10'));
    store.put(set('7', ['1'], '12'));
    store.put(set('8', ['1', '2'], '11'));
    const view = { store, chainRoot: async () => 7n as bigint | null, health: () => ({ ok: true }) };
    const current = await handle(view, 'GET', '/v1/association-set');
    expect(current.status).toBe(200);
    expect((current.body as PublishedSet).root).toBe('7');
    expect((await handle(view, 'GET', `/v1/association-set/${set('8').cid}`)).body).toMatchObject({ root: '8' });
    expect((await handle(view, 'GET', '/v1/association-set/bafkreiunknownunknownunknown')).status).toBe(404);
    expect((await handle(view, 'POST', '/v1/association-set')).status).toBe(405);
    expect((await handle({ ...view, chainRoot: async () => 99n }, 'GET', '/v1/association-set')).status).toBe(503);
    expect((await handle({ ...view, chainRoot: async () => null }, 'GET', '/v1/association-set')).status).toBe(404);
  });

  it('keeps published sets across a restart', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'asp-')), 'sets');
    new SetStore(dir).put(set('5'));
    expect(new SetStore(dir).byRoot('5')?.cid).toBe(set('5').cid);
  });
});
