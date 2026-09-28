import { describe, expect, test } from 'vitest';
import { RHC_MAINNET } from '@bursar/core';
import { canonicalNetwork, chainNetwork, networkChainId, sameNetwork } from '../src/network.js';

describe('network identity', () => {
  test('Robinhood Chain names itself in CAIP-2 form and in no other', () => {
    expect(chainNetwork(RHC_MAINNET)).toBe('eip155:4663');
  });

  test('two spellings of one chain id compare equal', () => {
    expect(sameNetwork('eip155:4663', 'EIP155:4663')).toBe(true);
    expect(networkChainId('eip155:4663')).toBe(4663);
  });

  test('different chain ids do not compare equal', () => {
    expect(sameNetwork('eip155:4663', 'eip155:8453')).toBe(false);
  });

  test('an unrecognised name is not quietly mapped onto some chain', () => {
    expect(canonicalNetwork('Base')).toBe('base');
    expect(networkChainId('base')).toBeNull();
    expect(sameNetwork('base', 'eip155:8453')).toBe(false);
  });

  test('an empty network matches nothing, including another empty one', () => {
    expect(sameNetwork('', '')).toBe(false);
    expect(sameNetwork(undefined, null)).toBe(false);
    expect(networkChainId(undefined)).toBeNull();
  });

  test('whitespace is packaging, not identity', () => {
    expect(sameNetwork('  eip155:4663  ', 'eip155:4663')).toBe(true);
  });
});
