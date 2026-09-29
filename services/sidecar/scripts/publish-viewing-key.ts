/**
 * Prints the payee's ERC-6538 meta-address and the `registerKeys` calldata that publishes it, so
 * payers can seal job inputs to this payee. Prints only; send the transaction from the payee key.
 *
 *   PAYEE_PRIVATE_KEY=0x… pnpm --filter @bursar/sidecar exec tsx scripts/publish-viewing-key.ts
 */
import { ERC6538_REGISTRY } from '@bursar/sdk';
import { privateKeyToAccount } from 'viem/accounts';

import { viewingKeyRegistration } from '../src/viewing.js';

const key = process.env['PAYEE_PRIVATE_KEY'];
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error('Set PAYEE_PRIVATE_KEY to the payee key (0x-prefixed, 32 bytes).');
  process.exit(1);
}

const account = privateKeyToAccount(key as `0x${string}`);
const { meta, calldata, viewingPublicKey } = await viewingKeyRegistration(account);

console.log(`payee            ${account.address}`);
console.log(`viewing key      ${viewingPublicKey}`);
console.log(`meta-address     ${meta}`);
console.log(`registry         ${ERC6538_REGISTRY}`);
console.log(`calldata         ${calldata}`);
console.log(`cast send ${ERC6538_REGISTRY} ${calldata} --rpc-url $RHC_RPC_URL --keystore <payee keystore>`);
