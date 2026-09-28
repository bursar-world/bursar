import { random32 } from '@bursar/sdk';
import { encodeAbiParameters, isHex, keccak256, parseAbiParameters, size } from 'viem';
import type { Address, Hex } from 'viem';

import { SCORE_MAX } from './phases';

/**
 * The salt is the sharpest edge on this desk.
 *
 * A sealed score is `keccak256(abi.encode(disputeId, resolver, score, salt))`. The chain holds the
 * hash and nothing else, so the salt is the only thing that can open it. A commitment that is never
 * revealed is slashed for silence once the reveal window closes, and there is no recovery path in
 * the contract: nobody else has the value, including this deployment.
 *
 * So the salt is drawn from the wallet rather than from the browser. The resolver signs one fixed
 * message and the salt is the hash of that signature, which means the same wallet produces the same
 * salt on any machine, in any browser profile, six hours later. Nothing has to be kept for a reveal
 * to be possible. The browser's own store and the exported copy are the second and third routes to
 * the same value, not the only ones.
 *
 * A wallet that signs the same message differently each time is allowed by the signature scheme and
 * would break the first route, so the derived salt is never assumed to reopen a commitment: both
 * reveal paths recompute the commitment locally and compare it with the registry's before offering
 * a transaction.
 */

export type VoteNote = {
  /** Decimal, because a bigint has no JSON form and this is written to storage. */
  readonly disputeId: string;
  readonly resolver: Address;
  readonly score: number;
  readonly salt: Hex;
  /** Recomputed on read and compared with the chain, which catches a note from another dispute. */
  readonly commitment: Hex;
  readonly savedAt: string;
};

/** The slice of `Storage` this needs. Supplying it is what makes the store testable. */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type VoteStore = {
  read(registry: Address, resolver: Address, disputeId: bigint): VoteNote | undefined;
  save(registry: Address, note: VoteNote): void;
  forget(registry: Address, resolver: Address, disputeId: bigint): void;
};

const SALT_BYTES = 32;

/** 32 bytes from the platform CSPRNG, through the SDK so one generator serves the whole product. */
export function newSalt(): Hex {
  return random32();
}

export type SaltSubject = {
  readonly registry: Address;
  readonly chainId: number;
  readonly disputeId: bigint;
  readonly resolver: Address;
};

/**
 * The message a resolver signs to draw their salt.
 *
 * This text is fixed. Every character of it goes into the signature, the signature is hashed into
 * the salt, and the salt is what the commitment was built from, so changing a word here would stop
 * every commitment made before the change from reopening. It names the deployment, the dispute and
 * the resolver, which is what keeps one dispute's salt from being another's and what makes the
 * value reproducible: the four fields are all on screen at reveal time.
 *
 * Addresses are lowercased because a wallet may hand back either casing between sessions, and two
 * casings of one address would be two different salts.
 */
export function saltMessage({ registry, chainId, disputeId, resolver }: SaltSubject): string {
  return [
    'BURSAR resolver salt',
    'Version 1',
    `Chain ${chainId}`,
    `Registry ${registry.toLowerCase()}`,
    `Dispute ${disputeId.toString()}`,
    `Resolver ${resolver.toLowerCase()}`,
    '',
    'Signing this draws the secret that opens your sealed score on this dispute. It is not a transaction and nothing about it is sent anywhere.',
  ].join('\n');
}

/**
 * The salt behind a signature over `saltMessage`.
 *
 * The signature itself is the secret and is never shown: the salt is published at reveal, and a
 * salt is one hash away from the signature while the signature is one recovery away from nothing
 * else this resolver signs.
 */
export function saltFromSignature(signature: Hex): Hex {
  return keccak256(signature);
}

/**
 * Where a salt came from, which is the same question as what can bring it back. Only a wallet that
 * proved it signs one message the same way twice earns `wallet`; everything else has to be copied
 * out before the score is sealed.
 */
export type DrawnSalt = { readonly value: Hex; readonly source: 'wallet' | 'wallet-unstable' | 'random' };

/**
 * Two signatures over the same message, because a wallet is free to sign it two different ways and
 * the one that does hands back a salt that never reopens the commitment. The second prompt is the
 * price of finding that out now rather than at reveal, when the bond is already at stake.
 */
export function saltFromSignatures(first: Hex, second: Hex): DrawnSalt {
  return { value: saltFromSignature(first), source: first === second ? 'wallet' : 'wallet-unstable' };
}

/** `keccak256(abi.encode(uint256,address,uint8,bytes32))`, checked against the live registry. */
export function commitmentFor(disputeId: bigint, resolver: Address, score: number, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('uint256 disputeId, address resolver, uint8 score, bytes32 salt'), [
      disputeId,
      resolver,
      score,
      salt,
    ]),
  );
}

/**
 * The score behind a commitment, found by trying every score it could be.
 *
 * A score is a whole number from 0 to 100, so a salt is enough to recover the number that was
 * sealed with it. That is what closes the loop for a resolver who comes back on another machine
 * with nothing but their wallet: `revealVote` needs the score as well as the salt, and 101 hashes
 * is nothing to compute.
 */
export function scoreFor(disputeId: bigint, resolver: Address, salt: Hex, commitment: Hex): number | undefined {
  const sealed = commitment.toLowerCase();
  for (let score = 0; score <= SCORE_MAX; score += 1) {
    if (commitmentFor(disputeId, resolver, score, salt).toLowerCase() === sealed) return score;
  }
  return undefined;
}

export function isSalt(value: string): value is Hex {
  return isHex(value) && size(value) === SALT_BYTES;
}

/**
 * What a typed salt is wrong about, in the words of the person who typed it. Returned rather than
 * thrown: this runs on every keystroke in the manual reveal field.
 */
export function saltProblem(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return 'Paste the salt you kept when you sealed the score.';
  if (!trimmed.startsWith('0x')) return 'A salt starts with 0x.';
  if (!isHex(trimmed)) return 'A salt is hexadecimal: 0x followed by 64 characters, 0 to 9 and a to f.';
  if (size(trimmed as Hex) !== SALT_BYTES) {
    return `A salt is 32 bytes. That is ${size(trimmed as Hex)}.`;
  }
  return undefined;
}

/**
 * Scoped by registry as well as by resolver, so a note from one deployment can never be offered
 * against another's dispute of the same number. Lowercased, because a wallet may hand back either
 * casing for the same address between sessions.
 */
export function voteKey(registry: Address, resolver: Address, disputeId: bigint): string {
  return `bursar.resolver-vote.${registry.toLowerCase()}.${resolver.toLowerCase()}.${disputeId.toString()}`;
}

/**
 * The copy a resolver takes away, as a file that still reads a year later.
 *
 * It carries both halves of the reveal and the message that draws the salt again, so whoever holds
 * it can finish the vote with the file alone or with the wallet alone. It also carries the score,
 * which is what makes it worth keeping somewhere private: a sealed score is only sealed until
 * somebody reads this.
 */
export function recoveryText(subject: SaltSubject, note: VoteNote): string {
  return [
    'BURSAR resolver commitment',
    '',
    `Chain       ${subject.chainId}`,
    `Registry    ${subject.registry}`,
    `Dispute     ${note.disputeId}`,
    `Resolver    ${note.resolver}`,
    `Score       ${note.score}`,
    `Salt        ${note.salt}`,
    `Commitment  ${note.commitment}`,
    `Drawn       ${note.savedAt}`,
    '',
    'The score and the salt are what reveal this commitment. A commitment that is never revealed is',
    'slashed, and nobody can reveal it for you. Keep this until the dispute is closed, and keep it',
    'where you keep keys: anyone holding it can read the score before it is published.',
    '',
    'The same salt comes back from this wallet by signing exactly this message:',
    '',
    saltMessage(subject),
    '',
  ].join('\n');
}

export function noteFor(disputeId: bigint, resolver: Address, score: number, salt: Hex, savedAt: Date): VoteNote {
  return {
    disputeId: disputeId.toString(),
    resolver,
    score,
    salt,
    commitment: commitmentFor(disputeId, resolver, score, salt),
    savedAt: savedAt.toISOString(),
  };
}

/**
 * A store over any `Storage`.
 *
 * Nothing here throws. A browser in private mode refuses `setItem` with a quota error, and a
 * commit that failed because storage is full has to say so as a condition the resolver can act on,
 * not as an uncaught exception halfway through a transaction. `save` reports what happened and the
 * panel refuses to send the commit when it did not land.
 */
export function voteStore(storage: StorageLike): VoteStore {
  return {
    read(registry, resolver, disputeId) {
      const raw = safeGet(storage, voteKey(registry, resolver, disputeId));
      if (raw === null) return undefined;
      return parseNote(raw, resolver, disputeId);
    },
    save(registry, note) {
      storage.setItem(voteKey(registry, note.resolver, BigInt(note.disputeId)), JSON.stringify(note));
    },
    forget(registry, resolver, disputeId) {
      try {
        storage.removeItem(voteKey(registry, resolver, disputeId));
      } catch {
        // A store that will not forget is not a reason to fail the screen. The note stays, and the
        // only thing it costs is a stale row in a browser the resolver owns.
      }
    },
  };
}

/**
 * The note as the chain would read it, or nothing.
 *
 * A note whose commitment does not recompute from its own fields has been edited or truncated in
 * storage, and offering it as a pre-filled reveal would hand the resolver a transaction that
 * reverts `BadReveal`. Discarding it puts them on the manual path, which is where they can still
 * recover from the copy they kept.
 */
function parseNote(raw: string, resolver: Address, disputeId: bigint): VoteNote | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const shaped = parsed as Record<string, unknown>;

  const salt = shaped.salt;
  const score = shaped.score;
  const savedAt = shaped.savedAt;
  if (typeof salt !== 'string' || !isSalt(salt)) return undefined;
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 100) return undefined;
  if (typeof savedAt !== 'string') return undefined;
  if (shaped.disputeId !== disputeId.toString()) return undefined;

  const commitment = commitmentFor(disputeId, resolver, score, salt);
  if (shaped.commitment !== commitment) return undefined;

  return { disputeId: disputeId.toString(), resolver, score, salt, commitment, savedAt };
}

function safeGet(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The browser's own store, or nothing.
 *
 * `localStorage` is absent on the server and throws on access where a browser has disabled site
 * data entirely. Both mean the same thing to this screen: the salt cannot be kept for the
 * resolver, and the panel says so rather than pretending it was saved.
 */
export function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}
