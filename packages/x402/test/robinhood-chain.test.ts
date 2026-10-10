import { describe, expect, test } from 'vitest';
import { getAddress } from 'viem';
import { RHC_MAINNET, RHC_MAINNET_USDG_DOMAIN_SEPARATOR } from '@bursar/core';
import { computeDomainSeparator } from '../src/domain.js';
import { ROBINHOOD_CHAIN, robinhoodChainMoneyParser, usdgPrice } from '../src/robinhood-chain.js';

describe('Robinhood Chain for the reference SDKs', () => {
  test('names the chain and the asset the way the reference tables do', () => {
    expect(ROBINHOOD_CHAIN.network).toBe('eip155:4663');
    expect(ROBINHOOD_CHAIN.asset).toEqual({
      asset: getAddress(RHC_MAINNET.usdg),
      name: 'Global Dollar',
      version: '1',
      decimals: 6,
      symbol: 'USDG',
    });
  });

  test('carries the domain USDG publishes', () => {
    const { asset, name, version } = ROBINHOOD_CHAIN.asset;
    expect(computeDomainSeparator({ name, version, chainId: ROBINHOOD_CHAIN.chainId, verifyingContract: asset })).toBe(
      RHC_MAINNET_USDG_DOMAIN_SEPARATOR,
    );
  });

  test('quotes a dollar figure in atomic USDG with the signing domain', () => {
    expect(usdgPrice('$0.01')).toEqual({ asset: RHC_MAINNET.usdg, amount: '10000', extra: { name: 'Global Dollar', version: '1' } });
    expect(usdgPrice(1.5).amount).toBe('1500000');
    expect(() => usdgPrice('0.0000001')).toThrow();
  });

  test('answers for Robinhood Chain and defers elsewhere', async () => {
    expect(await robinhoodChainMoneyParser(0.01, 'eip155:4663')).toMatchObject({ amount: '10000' });
    expect(await robinhoodChainMoneyParser(0.01, 'eip155:8453')).toBeNull();
  });
});
