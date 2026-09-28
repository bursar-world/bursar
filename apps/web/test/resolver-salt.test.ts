import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

import {
  commitmentFor,
  isSalt,
  newSalt,
  noteFor,
  recoveryText,
  saltFromSignature,
  saltFromSignatures,
  saltMessage,
  saltProblem,
  scoreFor,
  voteKey,
  voteStore,
} from '@/app/(app)/resolvers/salt';
import type { SaltSubject, StorageLike } from '@/app/(app)/resolvers/salt';

/**
 * The salt lifecycle, end to end.
 *
 * A sealed score is a hash and the salt is the only thing that opens it. There is no recovery path
 * in `OracleRegistry` and none in this app, and a commitment that is never revealed is slashed for
 * silence. Every property below is one a resolver's bond depends on.
 */

const RESOLVER = '0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4' as Address;
const OTHER = '0x7f2D3be9597fb538BDBA3Dbcb9BEcECCD9056d21' as Address;
const REGISTRY = '0xCb7c60037eC43b9692A5dDcA42A500181Cf549FF' as Address;
const OTHER_REGISTRY = '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4' as Address;
const SALT = '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex;

function fakeStorage(): StorageLike & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

describe('commitmentFor', () => {
  /**
   * Pinned against the live registry on chain 4663. `cast call OracleRegistry
   * 'commitmentHash(uint256,address,uint8,bytes32)' 7 0x6B6f… 62 0x1111…` answered exactly this on
   * 2026-09-22. If viem's encoding ever drifts from `abi.encode`, every reveal this app builds
   * would revert `BadReveal` and the resolver would be slashed for silence. This is the guard.
   */
  it('matches the hash the registry itself computes', () => {
    expect(commitmentFor(7n, RESOLVER, 62, SALT)).toBe(
      '0x7b6857842d6e3581719ccb3f0c34383450cefe024152aa0be38eaa61b38998ac',
    );
  });

  it('binds the dispute, so one dispute’s commitment cannot open another', () => {
    expect(commitmentFor(7n, RESOLVER, 62, SALT)).not.toBe(commitmentFor(8n, RESOLVER, 62, SALT));
  });

  it('binds the resolver, so a commitment watched in the mempool cannot be replayed', () => {
    expect(commitmentFor(7n, RESOLVER, 62, SALT)).not.toBe(commitmentFor(7n, OTHER, 62, SALT));
  });

  it('binds the score and the salt', () => {
    const other = '0x2222222222222222222222222222222222222222222222222222222222222222' as Hex;
    expect(commitmentFor(7n, RESOLVER, 62, SALT)).not.toBe(commitmentFor(7n, RESOLVER, 63, SALT));
    expect(commitmentFor(7n, RESOLVER, 62, SALT)).not.toBe(commitmentFor(7n, RESOLVER, 62, other));
  });
});

describe('newSalt', () => {
  it('is 32 bytes, which is what the contract takes', () => {
    expect(isSalt(newSalt())).toBe(true);
  });

  it('does not repeat, because a reused salt makes one commitment guessable from another', () => {
    const seen = new Set(Array.from({ length: 64 }, () => newSalt()));
    expect(seen.size).toBe(64);
  });
});

describe('drawing the salt from a wallet', () => {
  const subject: SaltSubject = { registry: REGISTRY, chainId: 4663, disputeId: 7n, resolver: RESOLVER };

  /**
   * The message is the contract between a commitment and the reveal that opens it six hours later
   * on another machine. A character changed here is every salt drawn before the change lost, so
   * the exact text is pinned here.
   */
  it('signs an exact text that names the deployment, the dispute and the resolver', () => {
    expect(saltMessage(subject)).toBe(
      [
        'BURSAR resolver salt',
        'Version 1',
        'Chain 4663',
        `Registry ${REGISTRY.toLowerCase()}`,
        'Dispute 7',
        `Resolver ${RESOLVER.toLowerCase()}`,
        '',
        'Signing this draws the secret that opens your sealed score on this dispute. It is not a transaction and nothing about it is sent anywhere.',
      ].join('\n'),
    );
  });

  it('reads the same for either casing of an address, because a wallet hands back both', () => {
    expect(saltMessage({ ...subject, resolver: RESOLVER.toUpperCase() as Address })).toBe(saltMessage(subject));
  });

  it('separates deployments, disputes, resolvers and chains', () => {
    expect(saltMessage({ ...subject, registry: OTHER_REGISTRY })).not.toBe(saltMessage(subject));
    expect(saltMessage({ ...subject, disputeId: 8n })).not.toBe(saltMessage(subject));
    expect(saltMessage({ ...subject, resolver: OTHER })).not.toBe(saltMessage(subject));
    expect(saltMessage({ ...subject, chainId: 4663_0 })).not.toBe(saltMessage(subject));
  });

  /**
   * The whole point of the derivation. A resolver whose browser storage is gone signs the same
   * message on a machine that has never seen this deployment and gets the same 32 bytes back.
   */
  it('gives the same salt every time the same wallet signs the same message', async () => {
    const wallet = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const message = saltMessage({ ...subject, resolver: wallet.address });

    const first = saltFromSignature(await wallet.signMessage({ message }));
    const second = saltFromSignature(await wallet.signMessage({ message }));

    expect(first).toBe(second);
    expect(isSalt(first)).toBe(true);
  });

  it('gives a different salt for a different dispute on the same wallet', async () => {
    const wallet = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

    const one = saltFromSignature(await wallet.signMessage({ message: saltMessage({ ...subject, resolver: wallet.address }) }));
    const two = saltFromSignature(
      await wallet.signMessage({ message: saltMessage({ ...subject, resolver: wallet.address, disputeId: 8n }) }),
    );

    expect(one).not.toBe(two);
  });
});

/**
 * A score is 0 to 100, so the salt is the only half of a reveal that has to be carried. Recovering
 * the other half from the chain's own commitment is what leaves a resolver needing nothing but
 * their wallet.
 */
describe('scoreFor', () => {
  it('finds the score behind a commitment', () => {
    expect(scoreFor(7n, RESOLVER, SALT, commitmentFor(7n, RESOLVER, 62, SALT))).toBe(62);
    expect(scoreFor(7n, RESOLVER, SALT, commitmentFor(7n, RESOLVER, 0, SALT))).toBe(0);
    expect(scoreFor(7n, RESOLVER, SALT, commitmentFor(7n, RESOLVER, 100, SALT))).toBe(100);
  });

  it('finds nothing when the salt does not open the commitment', () => {
    const other = '0x2222222222222222222222222222222222222222222222222222222222222222' as Hex;
    expect(scoreFor(7n, RESOLVER, other, commitmentFor(7n, RESOLVER, 62, SALT))).toBeUndefined();
    expect(scoreFor(8n, RESOLVER, SALT, commitmentFor(7n, RESOLVER, 62, SALT))).toBeUndefined();
    expect(scoreFor(7n, OTHER, SALT, commitmentFor(7n, RESOLVER, 62, SALT))).toBeUndefined();
  });
});

describe('the copy a resolver takes away', () => {
  it('carries both halves of the reveal, the commitment and the way to draw the salt again', () => {
    const subject: SaltSubject = { registry: REGISTRY, chainId: 4663, disputeId: 7n, resolver: RESOLVER };
    const note = noteFor(7n, RESOLVER, 62, SALT, new Date('2026-09-23T10:00:00Z'));
    const file = recoveryText(subject, note);

    expect(file).toContain(SALT);
    expect(file).toContain('Score       62');
    expect(file).toContain(note.commitment);
    expect(file).toContain(saltMessage(subject));
  });
});

describe('voteKey', () => {
  it('separates deployments, resolvers and disputes', () => {
    expect(voteKey(REGISTRY, RESOLVER, 7n)).not.toBe(voteKey(OTHER_REGISTRY, RESOLVER, 7n));
    expect(voteKey(REGISTRY, RESOLVER, 7n)).not.toBe(voteKey(REGISTRY, OTHER, 7n));
    expect(voteKey(REGISTRY, RESOLVER, 7n)).not.toBe(voteKey(REGISTRY, RESOLVER, 8n));
  });

  it('is case-insensitive in the addresses, because a wallet may hand back either casing', () => {
    expect(voteKey(REGISTRY.toLowerCase() as Address, RESOLVER.toUpperCase() as Address, 7n)).toBe(
      voteKey(REGISTRY, RESOLVER, 7n),
    );
  });
});

describe('the store', () => {
  it('gives back what was kept', () => {
    const storage = fakeStorage();
    const store = voteStore(storage);
    store.save(REGISTRY, noteFor(7n, RESOLVER, 62, SALT, new Date('2026-09-22T10:00:00Z')));

    const read = store.read(REGISTRY, RESOLVER, 7n);
    expect(read?.salt).toBe(SALT);
    expect(read?.score).toBe(62);
    expect(read?.commitment).toBe(commitmentFor(7n, RESOLVER, 62, SALT));
  });

  it('offers a note only to the dispute, resolver and registry it was written for', () => {
    const storage = fakeStorage();
    const store = voteStore(storage);
    store.save(REGISTRY, noteFor(7n, RESOLVER, 62, SALT, new Date()));

    expect(store.read(REGISTRY, RESOLVER, 8n)).toBeUndefined();
    expect(store.read(REGISTRY, OTHER, 7n)).toBeUndefined();
    expect(store.read(OTHER_REGISTRY, RESOLVER, 7n)).toBeUndefined();
  });

  it('forgets on request', () => {
    const storage = fakeStorage();
    const store = voteStore(storage);
    store.save(REGISTRY, noteFor(7n, RESOLVER, 62, SALT, new Date()));
    store.forget(REGISTRY, RESOLVER, 7n);

    expect(store.read(REGISTRY, RESOLVER, 7n)).toBeUndefined();
  });

  /**
   * A note that no longer recomputes has been edited or truncated in storage. Offering it as a
   * pre-filled reveal would hand the resolver a transaction that reverts and burn one of the hours
   * they have left, so it is discarded and they are put on the manual path instead.
   */
  it('discards a note whose commitment no longer recomputes', () => {
    const storage = fakeStorage();
    const store = voteStore(storage);
    const note = noteFor(7n, RESOLVER, 62, SALT, new Date());
    storage.setItem(voteKey(REGISTRY, RESOLVER, 7n), JSON.stringify({ ...note, score: 63 }));

    expect(store.read(REGISTRY, RESOLVER, 7n)).toBeUndefined();
  });

  it('discards a note that is not JSON, a short salt, or a score out of range', () => {
    const storage = fakeStorage();
    const store = voteStore(storage);

    storage.setItem(voteKey(REGISTRY, RESOLVER, 1n), 'not json');
    storage.setItem(voteKey(REGISTRY, RESOLVER, 2n), JSON.stringify({ disputeId: '2', salt: '0x11', score: 62, commitment: '0x00', savedAt: '' }));
    storage.setItem(
      voteKey(REGISTRY, RESOLVER, 3n),
      JSON.stringify({ ...noteFor(3n, RESOLVER, 62, SALT, new Date()), score: 900 }),
    );

    expect(store.read(REGISTRY, RESOLVER, 1n)).toBeUndefined();
    expect(store.read(REGISTRY, RESOLVER, 2n)).toBeUndefined();
    expect(store.read(REGISTRY, RESOLVER, 3n)).toBeUndefined();
  });

  it('survives a browser that refuses to be read', () => {
    const store = voteStore({
      getItem: () => {
        throw new Error('site data is off');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    });

    expect(store.read(REGISTRY, RESOLVER, 7n)).toBeUndefined();
  });

  /**
   * A refused write has to reach the caller. The commit panel sends the transaction only after the
   * salt is kept, and swallowing a quota error here would put a commitment on chain whose salt
   * exists nowhere.
   */
  it('reports a browser that refuses to be written to', () => {
    const store = voteStore({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => undefined,
    });

    expect(() => store.save(REGISTRY, noteFor(7n, RESOLVER, 62, SALT, new Date()))).toThrow('quota exceeded');
  });
});

describe('saltProblem', () => {
  it('accepts the 32 bytes the contract takes', () => {
    expect(saltProblem(SALT)).toBeUndefined();
    expect(saltProblem(`  ${SALT}  `)).toBeUndefined();
  });

  it('names what is wrong instead of refusing silently', () => {
    expect(saltProblem('')).toContain('Paste the salt');
    expect(saltProblem('1111')).toContain('starts with 0x');
    expect(saltProblem('0xzzzz')).toContain('hexadecimal');
    expect(saltProblem('0x1111')).toContain('32 bytes');
  });
});

describe('what a drawn salt says can bring it back', () => {
  const a = '0xaa' as Hex;
  const b = '0xbb' as Hex;

  it('trusts a wallet that signed the same message the same way twice', () => {
    expect(saltFromSignatures(a, a)).toEqual({ value: saltFromSignature(a), source: 'wallet' });
  });

  it('refuses to call a salt reproducible when the two signatures disagree', () => {
    const drawn = saltFromSignatures(a, b);
    expect(drawn.source).toBe('wallet-unstable');
    expect(drawn.value).toBe(saltFromSignature(a));
  });
});
