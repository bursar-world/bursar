import { readFileSync } from 'node:fs';

import { RHC_MAINNET, parseDeployment } from '@bursar/core';
import type { Deployment } from '@bursar/core';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';

import { isMandateCode, mandateBuild, mandateCodeSet } from '@/chain/mandates';

/**
 * Runtime code of mandates the factories deployed on chain 4663, read with `eth_getCode`. The v3
 * one was deployed by a v3 factory on a local chain with id 4663, against an escrow at 0x3333…3333,
 * because no v3 escrow existed yet.
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.hex`, import.meta.url), 'utf8').trim() as Hex;
const FIRST: Address = '0xB4Bd99d8604fDB876fA1B38a3f8bA024D20ccD0b';
const SECOND: Address = '0xb840f3BD8Ccb2B7fcB731EEE1fDa5B40A4e656c1';
const V2_EXAMPLE: Address = '0x420BeB507F72173E7d78e0f956968f64fb508356';
const COLLATERAL: Address = '0x4686C3566E1C50b4cC14c37A1088b7892d7D7407';

describe('isMandateCode', () => {
  it('recognises every account the factory deployed, whatever its address', () => {
    expect(isMandateCode(FIRST, fixture('mandate-b4bd'))).toBe(true);
    expect(isMandateCode(SECOND, fixture('mandate-b840'))).toBe(true);
  });

  it('refuses genuine code claimed at an address it does not name, which is a copy', () => {
    expect(isMandateCode(SECOND, fixture('mandate-b4bd'))).toBe(false);
  });

  it('refuses code that differs anywhere outside the two per-account fields', () => {
    const code = fixture('mandate-b4bd');
    const flipped = `${code.slice(0, 200)}${code[200] === 'f' ? '0' : 'f'}${code.slice(201)}` as Hex;
    expect(isMandateCode(FIRST, flipped)).toBe(false);
  });

  it('refuses an address with no code or code of another length', () => {
    expect(isMandateCode(FIRST, undefined)).toBe(false);
    expect(isMandateCode(FIRST, '0x')).toBe(false);
    expect(isMandateCode(FIRST, `${fixture('mandate-b4bd')}00` as Hex)).toBe(false);
  });
});

describe('mandateCodeSet', () => {
  it('says which build an account runs', () => {
    expect(mandateCodeSet(FIRST, fixture('mandate-b4bd'))).toBe('v1');
    expect(mandateCodeSet(V2_EXAMPLE, fixture('mandate-420b'))).toBe('v2');
    expect(isMandateCode(V2_EXAMPLE, fixture('mandate-420b'))).toBe(true);
  });

  it('recognises an account from the v2.1 factory, which speaks the v2 abi', () => {
    expect(mandateCodeSet(COLLATERAL, fixture('mandate-4686'))).toBe('v2');
    expect(mandateCodeSet(V2_EXAMPLE, fixture('mandate-4686'))).toBeUndefined();
  });

  it('refuses v2 code claimed at another address', () => {
    expect(mandateCodeSet(FIRST, fixture('mandate-420b'))).toBeUndefined();
  });

  it('refuses v2 code altered outside the two per-account fields', () => {
    const code = fixture('mandate-420b');
    const flipped = `${code.slice(0, 200)}${code[200] === 'f' ? '0' : 'f'}${code.slice(201)}` as Hex;
    expect(mandateCodeSet(V2_EXAMPLE, flipped)).toBeUndefined();
  });
});

const V3_ACCOUNT: Address = '0xBEeECa05C0F894b525B7Afe33a5a51C64289B963';
const V3_ESCROW: Address = '0x3333333333333333333333333333333333333333';
const fill = (digit: string) => `0x${digit.repeat(40)}`;

/** A v3 record for chain 4663 with every address made up except the escrow the fixture names. */
function v3Record(overrides: { network?: string; escrow?: string; settlementAsset?: string } = {}): Deployment {
  return parseDeployment({
    network: overrides.network ?? 'rhc-mainnet-v3',
    chainId: 4663,
    rpc: 'https://rpc.example.invalid',
    explorer: 'https://explorer.example.invalid',
    settlementAsset: overrides.settlementAsset ?? RHC_MAINNET.usdg,
    settlementDecimals: 6,
    deployer: fill('b'),
    contracts: {
      AdminTimelock: fill('1'),
      Reputation: fill('2'),
      Escrow: overrides.escrow ?? V3_ESCROW,
      OracleRegistry: fill('4'),
      AgentRegistry: fill('5'),
      MandateAccountFactory: fill('6'),
    },
    roles: { timelockSigners: [fill('7')], guardian: fill('c'), treasury: fill('d'), slashSink: fill('e') },
    verifiedOnChain: {},
    supersedes: 'rhc-mainnet-v2',
  });
}

describe('a v3 account', () => {
  it('is recognised once a v3 record names the escrow and the asset its code holds', () => {
    expect(mandateCodeSet(V3_ACCOUNT, fixture('mandate-v3'), [v3Record()])).toBe('v3');
  });

  it('is not recognised while no v3 record names its escrow', () => {
    expect(mandateCodeSet(V3_ACCOUNT, fixture('mandate-v3'), [])).toBeUndefined();
    expect(mandateCodeSet(V3_ACCOUNT, fixture('mandate-v3'), [v3Record({ escrow: fill('9') })])).toBeUndefined();
  });

  it('is refused when the record names the escrow but another settlement asset', () => {
    expect(mandateCodeSet(V3_ACCOUNT, fixture('mandate-v3'), [v3Record({ settlementAsset: fill('a') })])).toBeUndefined();
  });

  it('is refused when only an earlier set names that escrow', () => {
    expect(mandateCodeSet(V3_ACCOUNT, fixture('mandate-v3'), [v3Record({ network: 'rhc-mainnet-v2' })])).toBeUndefined();
  });

  it('is refused when one escrow slot names the record and another names something else', () => {
    const code = fixture('mandate-v3');
    // The second escrow slot, 3,275 bytes in, rewritten to a different address.
    const at = 2 + 3_275 * 2;
    const forged = `${code.slice(0, at)}${'44'.repeat(20)}${code.slice(at + 40)}` as Hex;
    expect(mandateCodeSet(V3_ACCOUNT, forged, [v3Record()])).toBeUndefined();
  });

  it('is refused at an address it does not name', () => {
    expect(mandateCodeSet(FIRST, fixture('mandate-v3'), [v3Record()])).toBeUndefined();
  });
});

describe('which builds draw from their park inside a payment', () => {
  it('is the v2.1 build and v3, and neither v1 nor the first v2 build', () => {
    expect(mandateBuild(V3_ACCOUNT, fixture('mandate-v3'), [v3Record()])?.draws).toBe(true);
    expect(mandateBuild(COLLATERAL, fixture('mandate-4686'))?.draws).toBe(true);
    expect(mandateBuild(V2_EXAMPLE, fixture('mandate-420b'))?.draws).toBe(false);
    expect(mandateBuild(FIRST, fixture('mandate-b4bd'))?.draws).toBe(false);
  });
});
