import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';

import { isMandateCode, mandateCodeSet } from '@/chain/mandates';

/** Runtime code of mandates the two factories deployed on chain 4663, read with `eth_getCode`. */
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
