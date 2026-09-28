import { describe, expect, it } from 'vitest';
import { getAbiItem, toFunctionSelector } from 'viem';
import { BURSAR_ABIS, mandateAccountAbi, escrowAbi, settlementAssetAbi } from '../src/generated/abi.js';

describe('generated ABIs', () => {
  it('covers every deployed contract', () => {
    expect(Object.keys(BURSAR_ABIS).sort()).toEqual([
      'AdminTimelock',
      'AgentRegistry',
      'Escrow',
      'MandateAccount',
      'MandateAccountFactory',
      'OracleRegistry',
      'Reputation',
    ]);
  });

  it('keeps the mandate surface the services spend against', () => {
    const names = new Set<string>(mandateAccountAbi.filter((e) => e.type === 'function').map((e) => e.name));
    for (const fn of ['spend', 'previewSpend', 'remaining', 'limits', 'setLimitsWithAuthorization', 'deposit']) {
      expect(names.has(fn), fn).toBe(true);
    }
    expect(getAbiItem({ abi: mandateAccountAbi, name: 'Spent' })?.type).toBe('event');
  });

  it('keeps the escrow lifecycle', () => {
    const names = new Set<string>(escrowAbi.filter((e) => e.type === 'function').map((e) => e.name));
    for (const fn of ['lock', 'release', 'timeout', 'dispute', 'resolve', 'getLock']) {
      expect(names.has(fn), fn).toBe(true);
    }
  });

  it('exposes the settlement asset as USDG answers it, including EIP-3009', () => {
    const names: string[] = settlementAssetAbi.filter((e) => e.type === 'function').map((e) => e.name);
    // Every one of these was called against 0x5fc5…d168 on chain 4663 and answered. `version` is
    // deliberately not in the list: USDG is a diamond and does not route it.
    for (const fn of [
      'transferWithAuthorization',
      'receiveWithAuthorization',
      'cancelAuthorization',
      'authorizationState',
      'permit',
      'nonces',
      'DOMAIN_SEPARATOR',
      'decimals',
      // The issuer controls that answer. A settlement can fail for an issuer reason on this
      // chain, so the ABI has to carry the reads that say so.
      'paused',
      'isFrozen',
      'owner',
    ]) {
      expect(names, fn).toContain(fn);
    }

    // The bytes-signature variant is the one the x402 exact scheme submits.
    expect(
      settlementAssetAbi.some(
        (e) =>
          e.type === 'function' &&
          e.name === 'transferWithAuthorization' &&
          e.inputs.length === 7 &&
          e.inputs[6]?.type === 'bytes',
      ),
    ).toBe(true);
  });

  it('drops everything the live token would revert or does not have', () => {
    const names: string[] = settlementAssetAbi.map((e) => ('name' in e ? e.name : ''));
    // The first three are test-only entry points on the stand-in. The last three are the ones
    // USDG's diamond does not route: shipping them gives a caller a way to reach a bare
    // `FacetNotFound` with nothing in it to explain why.
    for (const absent of [
      'mint',
      'setPaused',
      'setFrozen',
      'version',
      'eip712Domain',
      'isBlacklisted',
    ]) {
      expect(names, absent).not.toContain(absent);
    }
  });

  it('is typed well enough for viem to derive a selector', () => {
    const spend = getAbiItem({ abi: mandateAccountAbi, name: 'previewSpend' });
    expect(spend).toBeDefined();
    expect(toFunctionSelector(spend as never)).toMatch(/^0x[0-9a-f]{8}$/);
  });
});
