import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { DEPLOYMENTS, RHC_MAINNET } from '@bursar/core';

import {
  connect,
  connectFor,
  explorerTx,
  isConnection,
  requireSigner,
  writeOptions,
} from '../src/connection.js';
import { InvalidArgumentError, NoSignerError, UnsupportedChainError } from '../src/errors.js';
import { fakeConnection, RHC_DEPLOYMENT, TEST_KEY } from './helpers/fake-connection.js';

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
