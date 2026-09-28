import { commitmentFor, SCORE_MAX } from '@bursar/sdk';
import { getAddress, keccak256 } from 'viem';
import type { Address, Hex, LocalAccount } from 'viem';

/**
 * The salt a key seals its score with, derived rather than drawn.
 *
 * A random salt lives in one place, and losing that place loses the vote and part of the bond.
 * This one is the hash of the key's own signature over a fixed message naming the chain, the
 * registry and the dispute. viem signs with RFC 6979, so the same key signs the same message to
 * the same bytes every time: any process holding the keystore recomputes it, and a process holding
 * nothing but the chain cannot. The journal keeps a copy for convenience and is never the only one.
 *
 * The message is the protocol. Changing a character of it strands every sealed vote.
 */
export function saltMessage(chainId: number, registry: Address, disputeId: bigint): string {
  return `bursar-resolver-salt|${chainId}|${getAddress(registry)}|${disputeId.toString()}`;
}

export async function saltFor(account: LocalAccount, chainId: number, registry: Address, disputeId: bigint): Promise<Hex> {
  return keccak256(await account.signMessage({ message: saltMessage(chainId, registry, disputeId) }));
}

/**
 * The score a sealed commitment was made with, found by trying every score the registry accepts.
 *
 * With the salt recomputed, the score is the only unknown and there are 101 of it. This is what
 * lets a runner that has lost its journal, or never had one, still reveal: it asks the chain what
 * was sealed and works out which score seals to that. Null means no score opens it with this salt,
 * which says the commitment was not made by this derivation and must not be revealed from here.
 */
export function recoverScore(args: {
  readonly commitment: Hex;
  readonly disputeId: bigint;
  readonly resolver: Address;
  readonly salt: Hex;
}): number | null {
  const target = args.commitment.toLowerCase();
  for (let score = 0; score <= SCORE_MAX; score += 1) {
    if (commitmentFor({ disputeId: args.disputeId, resolver: args.resolver, score, salt: args.salt }).toLowerCase() === target) {
      return score;
    }
  }
  return null;
}
