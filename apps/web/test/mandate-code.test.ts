import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';

import { isMandateCode } from '@/chain/mandates';

/** Runtime code of two mandates the factory deployed on chain 4663, read with `cast code`. */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.hex`, import.meta.url), 'utf8').trim() as Hex;
const FIRST: Address = '0xB4Bd99d8604fDB876fA1B38a3f8bA024D20ccD0b';
const SECOND: Address = '0xb840f3BD8Ccb2B7fcB731EEE1fDa5B40A4e656c1';

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
