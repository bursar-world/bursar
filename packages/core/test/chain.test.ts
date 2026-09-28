import { describe, expect, it } from 'vitest';
import {
  RHC_ENV,
  RHC_MAINNET,
  RHC_MAINNET_INFRA_HASHES,
  RHC_MAINNET_USDG_CODE_HASH,
  RHC_MAINNET_USDG_DOMAIN,
  RHC_MAINNET_USDG_DOMAIN_SEPARATOR,
  RHC_TESTNET,
  MissingRhcConfig,
  TestnetHasNoSettlementAsset,
  USDG_DOMAIN_VERSION,
  caip2,
  canonicalNetwork,
  eip712DomainSeparator,
  isCaip2,
  networkChainId,
  parseCaip2,
  rhcChain,
  sameNetwork,
  rhcMainnet,
  rhcTestnet,
  usdgDomain,
  viemChain,
} from '../src/chain.js';

const MAINNET = {
  RHC_MAINNET_CHAIN_ID: '4663',
  RHC_MAINNET_RPC_URL: 'https://rpc.rhc.example',
  RHC_MAINNET_EXPLORER: 'https://explorer.example',
  RHC_MAINNET_USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  RHC_MAINNET_PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  RHC_MAINNET_MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  RHC_MAINNET_MIN_FEE_CAP: '20000000',
};

describe('Robinhood Chain config', () => {
  it('pins the mainnet values read back from chain 4663', () => {
    expect(RHC_MAINNET).toMatchObject({
      name: 'Robinhood Chain',
      network: 'mainnet',
      chainId: 4663,
      rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
      usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      usdgDecimals: 6,
      permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    });
    expect(caip2(RHC_MAINNET.chainId)).toBe('eip155:4663');
    // ArbGasInfo.getMinimumGasPrice() on 4663: 0.02 gwei.
    expect(RHC_MAINNET.minFeeCap).toBe(20_000_000n);
  });

  it('sends people to the explorer they can pass the challenge on, and never an API host', () => {
    expect(RHC_MAINNET.explorer).toBe('https://robinhoodchain.blockscout.com');
    expect(RHC_MAINNET.explorer).not.toContain('api.blockscout.com');
  });

  it('records the infrastructure hashes as read on 4663', () => {
    // Multicall3 is byte-identical everywhere. Permit2 caches the chain id in an immutable, so it
    // cannot be, and a copied hash would fail here rather than on the first signature.
    expect(RHC_MAINNET_INFRA_HASHES.multicall3).toBe(
      '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891',
    );
    expect(RHC_MAINNET_INFRA_HASHES.permit2).not.toBe(RHC_MAINNET_INFRA_HASHES.multicall3);
    expect(RHC_MAINNET_USDG_CODE_HASH).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('serves mainnet from the verified values with nothing in the environment', () => {
    expect(rhcMainnet({})).toBe(RHC_MAINNET);
    expect(rhcChain('mainnet', {})).toBe(RHC_MAINNET);
  });

  it('defaults to mainnet, because it is the only network that settles', () => {
    expect(rhcChain(undefined, {})).toBe(RHC_MAINNET);
  });

  it('lets a deployment move one field without naming the other six', () => {
    const moved = rhcMainnet({ RHC_MAINNET_RPC_URL: 'http://127.0.0.1:8545' });

    expect(moved.rpcUrl).toBe('http://127.0.0.1:8545');
    expect(moved.chainId).toBe(RHC_MAINNET.chainId);
    expect(moved.usdg).toBe(RHC_MAINNET.usdg);
    expect(moved.minFeeCap).toBe(RHC_MAINNET.minFeeCap);
  });

  it('takes every override when all of them are supplied', () => {
    const chain = rhcMainnet(MAINNET);
    expect(chain).toMatchObject({ name: 'Robinhood Chain', network: 'mainnet', chainId: 4663, usdgDecimals: 6 });
    expect(chain.explorer).toBe('https://explorer.example');
    expect(rhcChain('mainnet', MAINNET).rpcUrl).toBe('https://rpc.rhc.example');
  });

  it('names the seven variables a deployment can move, and only for mainnet', () => {
    expect(Object.keys(RHC_ENV)).toEqual(['mainnet']);
    expect(Object.values(RHC_ENV.mainnet)).toEqual([
      'RHC_MAINNET_CHAIN_ID',
      'RHC_MAINNET_RPC_URL',
      'RHC_MAINNET_EXPLORER',
      'RHC_MAINNET_USDG',
      'RHC_MAINNET_PERMIT2',
      'RHC_MAINNET_MULTICALL3',
      'RHC_MAINNET_MIN_FEE_CAP',
    ]);
  });

  it('refuses a blank override rather than quietly taking the default it was meant to replace', () => {
    expect(() => rhcMainnet({ RHC_MAINNET_USDG: '' })).toThrow(MissingRhcConfig);
    expect(() => rhcMainnet({ RHC_MAINNET_USDG: '   ' })).toThrow(/RHC_MAINNET_USDG is set to an empty value/);
    expect(() => rhcMainnet({ RHC_MAINNET_USDG: '0xbad' })).toThrow(/not a 20-byte hex address/);
    expect(() => rhcMainnet({ RHC_MAINNET_CHAIN_ID: 'soon' })).toThrow(/positive integer chain id/);
    expect(() => rhcMainnet({ RHC_MAINNET_MIN_FEE_CAP: '20 gwei' })).toThrow(/whole number of wei/);
  });

  it('carries the codes the rest of the workspace branches on', () => {
    const blank = capture(() => rhcMainnet({ RHC_MAINNET_USDG: '' }));
    const invalid = capture(() => rhcMainnet({ RHC_MAINNET_USDG: '0xbad' }));

    expect((blank as MissingRhcConfig).code).toBe('rhc_unconfigured');
    expect((invalid as MissingRhcConfig).code).toBe('rhc_config_invalid');
  });
});

/**
 * Robinhood Chain publishes mainnet and leaves testnet without a settlement asset, so testnet is
 * the configuration that cannot work.
 */
describe('selecting testnet', () => {
  it('records 46630 as a network with no settlement asset, in the type as well as the value', () => {
    expect(RHC_TESTNET.chainId).toBe(46630);
    expect(RHC_TESTNET.rpcUrl).toBe('https://rpc.testnet.chain.robinhood.com');
    expect(RHC_TESTNET.usdg).toBeNull();
  });

  it('refuses, and says USDG is not there and that tests run against a fork of 4663', () => {
    const error = capture(() => rhcTestnet()) as TestnetHasNoSettlementAsset;

    expect(error).toBeInstanceOf(TestnetHasNoSettlementAsset);
    expect(error.code).toBe('rhc_testnet_no_settlement_asset');
    expect(error.message).toContain('USDG is not deployed');
    expect(error.message).toContain('46630');
    expect(error.message).toContain('fork of 4663');
    expect(error.message).toContain('RHC_MAINNET_RPC_URL');
  });

  it('refuses through the by-name selector too', () => {
    expect(() => rhcChain('testnet')).toThrow(TestnetHasNoSettlementAsset);
    expect(() => rhcChain('testnet', MAINNET)).toThrow(TestnetHasNoSettlementAsset);
  });
});

/**
 * USDG is a diamond proxy. `version()` reverts with `FacetNotFound`, so the version cannot be
 * read and has to be pinned, which means the pin has to be checked against something. The
 * separator the token publishes is that something.
 */
describe('the USDG EIP-712 domain', () => {
  it('pins name "Global Dollar" and version "1" without asking the token', () => {
    expect(RHC_MAINNET_USDG_DOMAIN).toEqual({
      name: 'Global Dollar',
      version: '1',
      chainId: 4663,
      verifyingContract: RHC_MAINNET.usdg,
    });
    expect(USDG_DOMAIN_VERSION).toBe('1');
  });

  it('computes the separator the token returned from DOMAIN_SEPARATOR()', () => {
    expect(RHC_MAINNET_USDG_DOMAIN_SEPARATOR).toBe(
      '0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036',
    );
    expect(eip712DomainSeparator(RHC_MAINNET_USDG_DOMAIN)).toBe(RHC_MAINNET_USDG_DOMAIN_SEPARATOR);
  });

  it('produces a different separator for any other version, which is why the pin is checked', () => {
    const guessed = eip712DomainSeparator({ ...RHC_MAINNET_USDG_DOMAIN, version: '2' });
    expect(guessed).not.toBe(RHC_MAINNET_USDG_DOMAIN_SEPARATOR);
  });

  it('derives the domain from whichever chain record is in play, fork included', () => {
    expect(usdgDomain(rhcMainnet(MAINNET))).toEqual({
      name: 'Global Dollar',
      version: '1',
      chainId: 4663,
      verifyingContract: MAINNET.RHC_MAINNET_USDG,
    });
  });
});

describe('Robinhood Chain config, continued', () => {
  it('speaks CAIP-2, which is how a self-hosted facilitator names a network', () => {
    expect(caip2(RHC_MAINNET.chainId)).toBe('eip155:4663');
    expect(parseCaip2('eip155:4663')).toEqual({ namespace: 'eip155', chainId: 4663 });
    expect(isCaip2('eip155:1')).toBe(true);
    expect(isCaip2('solana:5eykt4')).toBe(false);
    expect(() => parseCaip2('solana:5eykt4')).toThrow(/EVM chains only/);
    expect(() => caip2(0)).toThrow(/positive integer/);
  });

  /**
   * The agent, the facilitator and the console all read this, and a payment settles only when
   * they agree. `@bursar/sdk` and `@bursar/x402` used to answer it from two copies.
   */
  it('reads one chain under either spelling, and reads silence as no claim at all', () => {
    expect(sameNetwork('eip155:4663', 'EIP155:4663')).toBe(true);
    expect(sameNetwork('eip155:4663', 'eip155:04663')).toBe(true);
    expect(sameNetwork('  eip155:4663  ', 'eip155:4663')).toBe(true);
    expect(sameNetwork('eip155:4663', 'eip155:8453')).toBe(false);
    expect(sameNetwork('', '')).toBe(false);
    expect(sameNetwork(undefined, null)).toBe(false);
  });

  it('normalizes a network string and never renames one', () => {
    expect(canonicalNetwork('  EIP155:4663 ')).toBe('eip155:4663');
    expect(canonicalNetwork('Base')).toBe('base');
    expect(canonicalNetwork(undefined)).toBe('');
  });

  /** A v1 server may name a chain in words. No alias table turns that word into an id. */
  it('answers a chain id only for CAIP-2', () => {
    expect(networkChainId('eip155:4663')).toBe(4663);
    expect(networkChainId('base')).toBeNull();
    expect(networkChainId(undefined)).toBeNull();
    expect(sameNetwork('base', 'eip155:8453')).toBe(false);
  });

  it('describes gas as ETH, not as the settlement asset', () => {
    const chain = viemChain(RHC_MAINNET);

    expect(chain.id).toBe(4663);
    expect(chain.nativeCurrency).toEqual({ name: 'Ether', symbol: 'ETH', decimals: 18 });
    expect(chain.nativeCurrency.symbol).not.toBe('USDG');
    expect(chain.testnet).toBe(false);
    expect(chain.contracts?.multicall3?.address).toBe(RHC_MAINNET.multicall3);
    expect(chain.blockExplorers?.default?.url).toBe(RHC_MAINNET.explorer);
  });
});

function capture(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe('parsing that does not round or guess', () => {
  it('refuses a CAIP-2 reference too long to be a safe integer', () => {
    const huge = `eip155:${'9'.repeat(20)}`;
    expect(() => parseCaip2(huge)).toThrow(/cannot represent|can represent/);
    // isCaip2 has to agree, or sameNetwork would throw on a string it just accepted.
    expect(isCaip2(huge)).toBe(false);
    expect(networkChainId(huge)).toBeNull();
  });

  it('refuses a chain id override that Number() would have read anyway', () => {
    for (const value of ['0x1237', '4663.0', '4.663e3']) {
      expect(() => rhcMainnet({ RHC_MAINNET_CHAIN_ID: value })).toThrow(/positive integer chain id/);
    }
  });

  it('parses URL overrides and refuses anything that is not http or https', () => {
    expect(() => rhcMainnet({ RHC_MAINNET_RPC_URL: 'rpc.rhc.example' })).toThrow(/is not a URL/);
    expect(() => rhcMainnet({ RHC_MAINNET_EXPLORER: 'javascript:alert(1)' })).toThrow(/http or https/);
    expect(rhcMainnet({ RHC_MAINNET_RPC_URL: 'http://127.0.0.1:8545' }).rpcUrl).toBe('http://127.0.0.1:8545');
  });

  it('does not echo an RPC URL, which often carries a provider key, in its refusal', () => {
    expect(() => rhcMainnet({ RHC_MAINNET_RPC_URL: 'file:///secret-key' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-key') }),
    );
  });
});
