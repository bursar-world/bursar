import { hashTypedData } from 'viem';
import type { Address, Hex } from 'viem';

/**
 * A Safe signs a typed message the way the contract checks it: every owner signs a `SafeMessage`
 * wrapping the mandate's own digest, and the Safe answers ERC-1271 for the bundle. Inside the
 * Safe app, the first owner's signature comes back as an empty result while the others are still
 * to confirm; the finished bundle is what the Safe transaction service holds for that message.
 */
export const SAFE_TRANSACTION_SERVICE = 'https://api.safe.global/tx-service/robinhood/api/v1';
export const SAFE_APP_PREFIX = 'robinhood';

export function safeAppHome(safe: Address): string {
  return `https://app.safe.global/home?safe=${SAFE_APP_PREFIX}:${safe}`;
}

/** The Safe app with the console open inside it, where the Safe connects on its own. */
export function safeAppOpen(safe: Address, consoleUrl: string): string {
  return `https://app.safe.global/apps/open?safe=${SAFE_APP_PREFIX}:${safe}&appUrl=${encodeURIComponent(consoleUrl)}`;
}

/** The hash the owners sign for a digest the Safe is asked to validate, as the fallback handler computes it. */
export function safeMessageHash(safe: Address, chainId: number, digest: Hex): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: { SafeMessage: [{ name: 'message', type: 'bytes' }] },
    primaryType: 'SafeMessage',
    message: { message: digest },
  });
}

export type SafeMessageState = {
  readonly confirmations: number;
  /** The bundle the Safe accepts, once enough owners have signed. */
  readonly signature: Hex | undefined;
};

/** What the transaction service holds for a message, or undefined when it has not seen it. */
export async function readSafeMessage(messageHash: Hex): Promise<SafeMessageState | undefined> {
  const response = await fetch(`${SAFE_TRANSACTION_SERVICE}/messages/${messageHash}/`, { headers: { accept: 'application/json' } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`The Safe transaction service answered ${response.status}.`);
  const body = (await response.json()) as { confirmations?: unknown[]; preparedSignature?: string | null };
  const prepared = body.preparedSignature;
  return {
    confirmations: Array.isArray(body.confirmations) ? body.confirmations.length : 0,
    signature: typeof prepared === 'string' && /^0x[0-9a-fA-F]+$/u.test(prepared) && prepared !== '0x' ? (prepared as Hex) : undefined,
  };
}

export const SAFE_THRESHOLD_ABI = [
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;
