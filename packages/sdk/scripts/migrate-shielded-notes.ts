/**
 * Returns the notes a wallet deposited under the first key derivation, before that pool is retired.
 *
 * The first pool derived note keys from the viewing-key signature. Note keys now come from the
 * funds key, so the console no longer finds those notes. This script derives the old keys from the
 * same viewing signature, finds the wallet's notes still open in the pool, and ragequits each one:
 * the pool pays the note's whole value back to the wallet that deposited it, in the open, with no
 * association set and no relayer involved. Without --send it only lists what it would return.
 *
 *   MIGRATE_PRIVATE_KEY=0x… pnpm --filter @bursar/sdk exec tsx scripts/migrate-shielded-notes.ts [--send]
 *
 * RHC_RPC_URL overrides the public endpoint. MIGRATE_POOL, MIGRATE_SCOPE and MIGRATE_FROM_BLOCK
 * name the old pool once the deployment record has moved on to its replacement.
 */
import process from 'node:process';

import { shieldedArtifacts } from '@bursar/circuits/privacy-pools';
import { privacyDeployment, rhcChain, viemChain } from '@bursar/core';
import { createPublicClient, createWalletClient, getAddress, http, isAddressEqual, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { deriveLegacyShieldedKeys, fetchPoolEvents, recoverNotes, shieldedPoolAbi } from '../src/shielded.js';
import { proveRagequit } from '../src/shielded-prove.js';
import { viewingKeyMessage } from '../src/viewing-key.js';

const send = process.argv.includes('--send');
const key = process.env['MIGRATE_PRIVATE_KEY'];
if (!key) throw new Error('Set MIGRATE_PRIVATE_KEY to the key of the wallet that made the deposits.');

const chain = viemChain(rhcChain('mainnet'));
const rpc = process.env['RHC_RPC_URL'] ?? chain.rpcUrls.default.http[0];
const client = createPublicClient({ chain, transport: http(rpc) });
const recorded = privacyDeployment(chain.id)?.shielded;
const pool = getAddress(process.env['MIGRATE_POOL'] ?? recorded?.ShieldedPool ?? '');
const scope = BigInt(process.env['MIGRATE_SCOPE'] ?? recorded?.scope ?? '');
const fromBlock = BigInt(process.env['MIGRATE_FROM_BLOCK'] ?? recorded?.fromBlock ?? 0);

const wallet = privateKeyToAccount(key as Hex);
const keys = deriveLegacyShieldedKeys(await wallet.signMessage({ message: viewingKeyMessage(wallet.address) }));
const events = await fetchPoolEvents(client, { pool, fromBlock });
const open = recoverNotes({ keys, scope, events }).notes.filter(
  (note) => note.status === 'spendable' && isAddressEqual(note.deposit.depositor, wallet.address),
);

const usdg = (atomic: bigint) => `${atomic / 1_000_000n}.${(atomic % 1_000_000n).toString().padStart(6, '0')}`;
console.log(`${open.length} open note(s) for ${wallet.address} in ${pool}, ${usdg(open.reduce((sum, n) => sum + n.value, 0n))} USDG in all`);

const writer = createWalletClient({ account: wallet, chain, transport: http(rpc) });
for (const note of open) {
  console.log(`label ${note.label}: ${usdg(note.value)} USDG, deposited in ${note.deposit.transactionHash}`);
  if (!send) continue;
  const proof = await proveRagequit(note, shieldedArtifacts.commitment);
  const { request } = await client.simulateContract({
    account: wallet,
    address: pool,
    abi: shieldedPoolAbi,
    functionName: 'ragequit',
    args: [
      {
        pA: [proof.pA[0], proof.pA[1]],
        pB: [
          [proof.pB[0][0], proof.pB[0][1]],
          [proof.pB[1][0], proof.pB[1][1]],
        ],
        pC: [proof.pC[0], proof.pC[1]],
        pubSignals: [proof.pubSignals[0]!, proof.pubSignals[1]!, proof.pubSignals[2]!, proof.pubSignals[3]!],
      },
    ],
  });
  const hash = await writer.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`The ragequit for label ${note.label} reverted: ${hash}`);
  console.log(`  returned in ${hash}`);
}
if (!send && open.length > 0) console.log('Nothing sent. Run again with --send to return them.');
// snarkjs leaves worker threads alive.
process.exit(0);
