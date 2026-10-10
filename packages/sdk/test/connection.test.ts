import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, http, toHex } from 'viem';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEPLOYMENTS, RHC_MAINNET, viemChain } from '@bursar/core';

import {
  connect,
  connectFor,
  explorerTx,
  isConnection,
  openConnection,
  requireSigner,
  writeOptions,
} from '../src/connection.js';
import {
  InvalidArgumentError,
  NoSignerError,
  NotAnvilError,
  NotDeployedError,
  UnsupportedChainError,
} from '../src/errors.js';
import { mandateAccount } from '../src/mandate.js';
import { fakeConnection, RHC_DEPLOYMENT, TEST_KEY } from './helpers/fake-connection.js';
import { LOCAL_RECORD } from './helpers/local-record.js';

const HASH = `0x${'ab'.repeat(32)}` as const;

/** Whether this checkout has a committed record for the chain BURSAR settles on. */
const recorded = Object.values(DEPLOYMENTS).some((record) => record.chainId === 4663);

function open(options: Parameters<typeof connect>[0] = {}) {
  return connect({ deployment: RHC_DEPLOYMENT, ...options });
}

describe('connect', () => {
  it('targets Robinhood Chain mainnet when no deployment is named', () => {
    // 4663 is the only network with a USDG contract, so it is the only one a payment can settle
    // on. Until the deploy lands there is no record for it, and naming the chain it could not
    // find is the right answer: falling back to another network's addresses is not.
    if (!recorded) {
      expect(() => connect()).toThrow(/4663/);
      return;
    }

    expect(connect().chain.chainId).toBe(4663);
  });

  it('refuses a chain id with no deployment instead of handing back mainnet', () => {
    expect(() => connect({ chainId: 8453 })).toThrow(UnsupportedChainError);
    expect(() => connect({ chainId: 46630 })).toThrow(/no deployment on chain 46630/);

    try {
      connect({ chainId: 1 });
      expect.unreachable('connect accepted chain 1');
    } catch (error) {
      expect((error as UnsupportedChainError).chainId).toBe(1);
      if (recorded) {
        expect((error as UnsupportedChainError).supported).toEqual([4663]);
        expect((error as Error).message).toMatch(/Supported: 4663 \(Robinhood Chain mainnet\)/);
      }
    }
  });

  it('opens 4663 when asked for it by chain id', () => {
    if (!recorded) return;

    expect(connect({ chainId: 4663 }).chain.chainId).toBe(4663);
  });

  it('refuses a chain id that disagrees with the deployment it was given', () => {
    expect(() => open({ chainId: 8453 })).toThrow(InvalidArgumentError);
    expect(() => open({ chainId: 8453 })).toThrow(/asked for chain 8453/);
  });

  it('reads its addresses from the deployment record, so none is pasted by hand', () => {
    const connection = open();

    expect(connection.chain.chainId).toBe(4663);
    expect(connection.addresses.escrow).toBe('0x8E298457cDFc1Cb9ef6253D36d3BD5cFEf10F915');
    expect(connection.addresses.mandateAccountFactory).toBe(
      '0xE8F7a9a841F58E0d3847b7Eb6D7583fc37e881e9',
    );
    expect(connection.addresses.settlementAsset).toBe(RHC_MAINNET.usdg);
  });

  it('refuses a record that settles in something other than the chain\'s USDG', () => {
    const wrongAsset = { ...RHC_DEPLOYMENT, settlementAsset: '0x3600000000000000000000000000000000000000' } as const;

    expect(() => connect({ deployment: wrongAsset })).toThrow(/One of the two is stale/);
  });

  it('refuses a record that names a different chain from the one it is opened on', () => {
    expect(() => connect({ deployment: { ...RHC_DEPLOYMENT, chainId: 8453 } })).toThrow(
      /records chain 8453/,
    );
  });

  it('is read-only until a signer is supplied', () => {
    expect(open().walletClient).toBeUndefined();
    expect(open({ account: TEST_KEY }).account?.address).toBe(
      privateKeyToAccount(TEST_KEY).address,
    );
  });

  it('allocates nonces locally so two writes from one key do not collide', () => {
    expect(open({ account: TEST_KEY }).account?.nonceManager).toBeDefined();
  });

  it('takes a second endpoint and keeps both in the pool', () => {
    const connection = open({
      rpc: ['https://one.example', 'https://two.example'],
    });

    expect(connection.pool?.providers.map((provider) => provider.name)).toEqual([
      'primary',
      'fallback-1',
    ]);
  });

  it('stands a keyless second provider behind the mainnet endpoint when none is named', () => {
    // The public endpoint answers some servers with a challenge page. With one provider that was
    // the whole call; now the pool moves to the second.
    const connection = open({});

    expect(connection.pool?.providers.map((provider) => provider.name)).toEqual(['deployment', 'fallback']);
    expect(new Set(connection.pool?.providers.map((provider) => new URL(provider.url).hostname)).size).toBe(2);
  });

  it('refuses an empty endpoint list rather than falling back to a default nobody chose', () => {
    expect(() => open({ rpc: [] })).toThrow(/empty list of RPC endpoints/);
  });

  it('refuses a key and a wallet client together', () => {
    const { connection } = fakeConnection();

    expect(() =>
      open({ account: TEST_KEY, walletClient: connection.walletClient }),
    ).toThrow(/not both/);
  });

  it('refuses a wallet client or a public client built for another chain', () => {
    const { connection } = fakeConnection();
    const base = { ...connection.walletClient?.chain, id: 8453 } as NonNullable<typeof connection.walletClient>['chain'];
    const wallet = { ...connection.walletClient, chain: base } as typeof connection.walletClient;
    const reader = { ...connection.publicClient, chain: base } as typeof connection.publicClient;

    expect(() => open({ walletClient: wallet })).toThrow(/walletClient on chain 8453/);
    expect(() => open({ publicClient: reader, walletClient: connection.walletClient })).toThrow(
      /publicClient on chain 8453/,
    );
  });

  it('accepts clients built for the chain the deployment is on', () => {
    const { connection } = fakeConnection();
    const reader = { ...connection.publicClient, chain: connection.walletClient?.chain } as typeof connection.publicClient;

    expect(open({ publicClient: reader, walletClient: connection.walletClient }).walletClient).toBe(
      connection.walletClient,
    );
  });

  it('lets a caller override one address without restating the rest', () => {
    const escrow = '0x9999999999999999999999999999999999999999' as const;
    const connection = open({ addresses: { escrow } });

    expect(connection.addresses.escrow).toBe(escrow);
    expect(connection.addresses.reputation).toBe('0xbC4f89F964f5d8ff20a423B5261Aa3c75552d2a4');
  });
});

describe('requireSigner', () => {
  it('names the call it could not sign', () => {
    expect(() => requireSigner(open(), 'setPaused')).toThrow(NoSignerError);
    expect(() => requireSigner(open(), 'setPaused')).toThrow(/setPaused sends a transaction/);
  });

  it('tells a caller who opened through connect() to pass the signer there', () => {
    expect(() => requireSigner(open(), 'pay')).toThrow(/Pass account .* to connect\(\)\./);
  });

  it('names the entry point that built the connection, not a connect() the caller never wrote', () => {
    const connection = connectFor({ deployment: RHC_DEPLOYMENT }, 'mandateAccount()');

    expect(() => requireSigner(connection, 'pay')).toThrow(
      /mandateAccount\(\) was given no account and no walletClient\. Pass account .* to mandateAccount\(\)\./,
    );
    expect(() => requireSigner(connection, 'pay')).not.toThrow(/connect\(\)/);
  });

  it('keeps a connection it was handed as it is', () => {
    const connection = open();

    expect(connectFor(connection, 'mandateAccount()')).toBe(connection);
  });

  it('hands back the wallet and account when there is one', () => {
    const { connection, account } = fakeConnection();

    expect(requireSigner(connection, 'pay').account.address).toBe(account.address);
  });
});

describe('writeOptions', () => {
  it('declares the chain, so viem refuses to sign against a node that swapped under it', () => {
    const { connection } = fakeConnection();
    const options = writeOptions(requireSigner(connection, 'pay'), connection.chain);

    expect(options.chain.id).toBe(4663);
  });
});

describe('isConnection', () => {
  it('tells an open connection from the options that would build one', () => {
    expect(isConnection(open())).toBe(true);
    expect(isConnection({ rpc: 'https://one.example' })).toBe(false);
    expect(isConnection({})).toBe(false);
  });
});

describe('explorerTx', () => {
  it('links a person to the human explorer the deployment records', () => {
    expect(explorerTx(open(), HASH)).toBe(`https://robinhoodchain.blockscout.com/tx/${HASH}`);
  });
});

/**
 * A JSON-RPC node that answers from a table and remembers every method it was asked. Anything the
 * table leaves out is an error answer, so a call these checks should have stopped shows up in
 * `asked` and fails.
 */
type Answer = { readonly result: unknown } | { readonly error: { code: number; message: string } };

let server: Server;
let url: string;
let asked: string[] = [];
let answers: Readonly<Record<string, (params: readonly unknown[]) => Answer>> = {};

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; method: string; params?: unknown[] };
      asked.push(body.method);
      const answer = answers[body.method]?.(body.params ?? []) ?? {
        error: { code: -32601, message: `${body.method} is not answered here` },
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...answer }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

/** A node on 4663 that calls itself `client` and holds code everywhere but at `missing`. */
function node(client: string | undefined, missing: readonly Address[] = []): void {
  asked = [];
  answers = {
    eth_chainId: () => ({ result: toHex(RHC_MAINNET.chainId) }),
    eth_getCode: ([address]) => ({
      result: missing.some((gap) => gap.toLowerCase() === String(address).toLowerCase()) ? '0x' : '0x6080',
    }),
    eth_getBalance: () => ({ result: '0x0' }),
    ...(client === undefined ? {} : { web3_clientVersion: () => ({ result: client }) }),
  };
}

const MANDATE: Address = '0x1234567890123456789012345678901234567890';

describe('connect, on a record it was handed', () => {
  it('refuses a rehearsal record for any chain but 4663', () => {
    const elsewhere = { ...LOCAL_RECORD, network: 'local-31337', chainId: 31337 };

    expect(() => connect({ deployment: elsewhere })).toThrow(InvalidArgumentError);
    expect(() => connect({ deployment: elsewhere })).toThrow(/start anvil with --chain-id 4663/);

    // The chain config can be pointed at another id; a rehearsal record still cannot.
    process.env['RHC_MAINNET_CHAIN_ID'] = '31337';
    try {
      expect(() => connect({ deployment: elsewhere })).toThrow(/local rehearsal record for chain 31337/);
    } finally {
      delete process.env['RHC_MAINNET_CHAIN_ID'];
    }
  });

  it('refuses a rehearsal record on a node that is not anvil, before anything reaches it', async () => {
    node('nitro/v3.12.0-rc.3+ebe9e83-20260916T211740Z/linux-amd64/go1.25.12');
    const connection = connect({ deployment: LOCAL_RECORD, rpc: url, account: TEST_KEY });

    const refused = await mandateAccount(MANDATE, connection).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(NotAnvilError);
    expect((refused as NotAnvilError).node).toMatch(/^nitro\//);
    expect((refused as Error).message).toMatch(/^Deployment local-4663 is a local rehearsal record, and the node/);
    expect(asked).toEqual(['eth_chainId', 'web3_clientVersion']);

    // A read straight off the client is held back by the same check.
    const read = await connection.publicClient.getBalance({ address: MANDATE }).catch((error: unknown) => error);
    expect(String(read)).toContain('local rehearsal record');
    expect(asked).not.toContain('eth_getBalance');
  });

  it('refuses a rehearsal record on a node that will not say what it is', async () => {
    node(undefined);

    const refused = await openConnection({ deployment: LOCAL_RECORD, rpc: url }, 'test()').catch(
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(NotAnvilError);
    expect((refused as NotAnvilError).node).toBe('');
    expect((refused as Error).message).toContain('does not say what it is');
  });

  it('asks a client the caller built the same question', async () => {
    node('Geth/v10.0.0/drpc');
    const publicClient = createPublicClient({ chain: viemChain(RHC_MAINNET), transport: http(url, { retryCount: 0 }) });

    await expect(openConnection({ deployment: LOCAL_RECORD, publicClient }, 'test()')).rejects.toBeInstanceOf(
      NotAnvilError,
    );
  });

  it('refuses a record naming a contract with no code, and names the first one', async () => {
    node('anvil/v1.8.1', [LOCAL_RECORD.contracts.AgentRegistry, LOCAL_RECORD.contracts.Escrow]);

    const refused = await openConnection({ deployment: LOCAL_RECORD, rpc: url }, 'test()').catch(
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(NotDeployedError);
    expect((refused as NotDeployedError).contract).toBe('Escrow');
    expect((refused as NotDeployedError).address).toBe(LOCAL_RECORD.contracts.Escrow);
    expect((refused as Error).message).toBe(
      `Deployment local-4663 names ${LOCAL_RECORD.contracts.Escrow} as its Escrow, and the node this ` +
        'connection reaches holds no code there. The record was written for another chain, for an anvil ' +
        'node that has since restarted, or by a deploy that never landed. Point rpc at the chain the ' +
        'record describes, or deploy again and use the record that run writes.',
    );
  });

  it('checks the lane contracts a record names as well as the core set', async () => {
    node('anvil/v1.8.1', [LOCAL_RECORD.rwa.collateral.CreditPool]);

    await expect(openConnection({ deployment: LOCAL_RECORD, rpc: url }, 'test()')).rejects.toThrow(
      `names ${LOCAL_RECORD.rwa.collateral.CreditPool} as its CreditPool`,
    );
  });

  it('asks once, and lets a rehearsal record through on anvil with every contract in place', async () => {
    node('anvil/v1.8.1');
    const connection = connect({ deployment: LOCAL_RECORD, rpc: url });

    await openConnection(connection, 'test()');
    await openConnection(connection, 'test()');
    await connection.publicClient.getBalance({ address: MANDATE });

    expect(asked.filter((method) => method === 'web3_clientVersion')).toHaveLength(1);
    expect(asked.filter((method) => method === 'eth_getCode')).toHaveLength(16);
    expect(asked.at(-1)).toBe('eth_getBalance');
  });

  it('asks a record that is not a rehearsal for code but not for anvil', async () => {
    node(undefined);

    await openConnection({ deployment: RHC_DEPLOYMENT, rpc: url }, 'test()');

    expect(asked).not.toContain('web3_clientVersion');
    expect(asked.filter((method) => method === 'eth_getCode')).toHaveLength(7);
  });

  it('asks nothing about a record out of the address book', async () => {
    if (!recorded) return;
    node(undefined);

    await openConnection({ rpc: url }, 'test()');

    expect(asked).toEqual([]);
  });
});
