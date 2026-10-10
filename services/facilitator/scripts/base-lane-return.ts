/**
 * Returns a lock the Base lane's address holds as payee, by cancelling it on Robinhood Chain.
 *
 *   ETH_PASSWORD=<file> BURSAR_FLOAT_KEYSTORE=<keystore> npx tsx scripts/base-lane-return.ts <lockId>
 *
 * For a lock the lane never signed for, which the worker therefore never sees: a pay refused before
 * a row was written, or a lock opened against a facilitator that was down. The USDG goes back to the
 * mandate and its windows are credited, the same as a return the worker makes. Nothing prints a key.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { RHC_MAINNET, deploymentsForChain, escrowAbi } from '@bursar/core';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { decryptKeystore } from '../src/collateral/keystore.js';
import { createLockWriter } from '../src/base/viem.js';

const id = BigInt(process.argv[2] ?? '0');
if (id <= 0n) throw new Error('usage: base-lane-return.ts <lockId>');
const RPC = process.env['RHC_RPC_PRIMARY'] ?? 'https://robinhood.drpc.org';
const live = deploymentsForChain(4663)[0];
if (!live) throw new Error('no record for chain 4663');
const ESCROW = live.contracts.Escrow;
const passwordFile = process.env['ETH_PASSWORD'];
if (!passwordFile) throw new Error('ETH_PASSWORD must name the file holding the keystore password');
const key = decryptKeystore(readFileSync(process.env['BURSAR_FLOAT_KEYSTORE'] ?? join(homedir(), '.config', 'bursar', 'keystore', 'facilitator-base'), 'utf8'), readFileSync(passwordFile, 'utf8').trim());
const lane = privateKeyToAccount(key).address;

const client = createPublicClient({ transport: http(RPC) });
const lock = await client.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'getLock', args: [id] });
console.log(`lock ${id}: status ${lock.status}, payee ${lock.payee}, amount ${lock.amount}, deadline ${lock.deadline}`);
if (lock.status !== 1) throw new Error('the lock is not open');
if (lock.payee.toLowerCase() !== lane.toLowerCase()) throw new Error(`the lock is payable to ${lock.payee}, not to the lane's address ${lane}`);

const hash = await createLockWriter({ key, chain: RHC_MAINNET, rpcUrl: RPC }).cancel(ESCROW, id);
console.log(`returned: ${RHC_MAINNET.explorer}/tx/${hash}`);
