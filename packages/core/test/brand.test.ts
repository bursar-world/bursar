import { describe, expect, it } from 'vitest';
import { BURSAR, brand } from '../src/brand.js';

describe('brand lookup', () => {
  it('finds a configured brand', () => {
    expect(brand('bursar')).toBe(BURSAR);
  });

  it('does not hand back a prototype member as a brand', () => {
    for (const id of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(() => brand(id)).toThrow(/Unknown brand/);
    }
  });
});
