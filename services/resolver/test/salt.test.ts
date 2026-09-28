import { commitmentFor } from '@bursar/sdk';
import { describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import type { Address } from 'viem';

import { recoverScore, saltFor, saltMessage } from '../src/salt.js';
import { testKeys } from './support/keys.js';

const REGISTRY: Address = '0xCb7c60037eC43b9692A5dDcA42A500181Cf549FF';
const OTHER: Address = '0x1111111111111111111111111111111111111111';
const [first, second] = testKeys(2);
if (first === undefined || second === undefined) throw new Error('two keys');

describe('deterministic salts', () => {
  it('signs a message that names the chain, the registry and the dispute, in that order', () => {
    expect(saltMessage(4663, '0xcb7c60037ec43b9692a5ddca42a500181cf549ff', 7n)).toBe(
      'bursar-resolver-salt|4663|0xCb7c60037eC43b9692A5dDcA42A500181Cf549FF|7',
    );
  });

  it('is the hash of the signature, and the same every time', async () => {
    const salt = await saltFor(first.account, 4663, REGISTRY, 7n);
    const signature = await first.account.signMessage({ message: saltMessage(4663, REGISTRY, 7n) });

    expect(salt).toBe(keccak256(signature));
    expect(await saltFor(first.account, 4663, REGISTRY, 7n)).toBe(salt);
  });

  it('differs per key, per dispute, per registry and per chain', async () => {
    const salts = await Promise.all([
      saltFor(first.account, 4663, REGISTRY, 7n),
      saltFor(second.account, 4663, REGISTRY, 7n),
      saltFor(first.account, 4663, REGISTRY, 8n),
      saltFor(first.account, 4663, OTHER, 7n),
      saltFor(first.account, 1, REGISTRY, 7n),
    ]);
    expect(new Set(salts).size).toBe(salts.length);
  });
});

describe('score recovery', () => {
  it('finds every score the registry accepts from the commitment alone', async () => {
    const salt = await saltFor(first.account, 4663, REGISTRY, 9n);
    for (let score = 0; score <= 100; score += 1) {
      const commitment = commitmentFor({ disputeId: 9n, resolver: first.address, score, salt });
      expect(recoverScore({ commitment, disputeId: 9n, resolver: first.address, salt })).toBe(score);
    }
  });

  it('refuses a commitment this derivation did not make', async () => {
    const salt = await saltFor(first.account, 4663, REGISTRY, 9n);
    const foreign = commitmentFor({ disputeId: 9n, resolver: first.address, score: 90, salt: `0x${'77'.repeat(32)}` });

    expect(recoverScore({ commitment: foreign, disputeId: 9n, resolver: first.address, salt })).toBeNull();
  });

  it('refuses another key\'s commitment even at the same score', async () => {
    const salt = await saltFor(second.account, 4663, REGISTRY, 9n);
    const theirs = commitmentFor({ disputeId: 9n, resolver: second.address, score: 90, salt });

    expect(recoverScore({ commitment: theirs, disputeId: 9n, resolver: first.address, salt })).toBeNull();
  });
});
