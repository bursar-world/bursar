import process from 'node:process';

import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Hex } from 'viem';

import { openKeystore } from './keystore.js';

/** `<PREFIX>_PRIVATE_KEY`, or `<PREFIX>_KEYSTORE` with `<PREFIX>_PASSWORD_FILE`. Null when neither is set. */
export function signerFromEnv(prefix: string, env: NodeJS.ProcessEnv = process.env): PrivateKeyAccount | null {
  const raw = env[`${prefix}_PRIVATE_KEY`];
  if (raw) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${prefix}_PRIVATE_KEY is not a 32-byte hex key.`);
    return privateKeyToAccount(raw as Hex);
  }
  const keystore = env[`${prefix}_KEYSTORE`];
  const passwordFile = env[`${prefix}_PASSWORD_FILE`];
  if (!keystore && !passwordFile) return null;
  if (!keystore || !passwordFile) throw new Error(`Set both ${prefix}_KEYSTORE and ${prefix}_PASSWORD_FILE.`);
  return privateKeyToAccount(openKeystore(keystore, passwordFile));
}
