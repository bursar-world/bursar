import { toHex } from 'viem';
import type { Hex } from 'viem';

/**
 * A 32-byte value from the platform CSPRNG.
 *
 * Used for approval ids and x402 authorization nonces. Both are single-use markers a counterparty
 * cannot be allowed to predict: an approval id is burned on use, and an EIP-3009 nonce is what
 * makes a signed payment unreplayable.
 */
export function random32(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
