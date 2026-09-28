import { micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { getCode, readContract } from 'viem/actions';
import { bytesToHex, hexToBytes, keccak256 } from 'viem';
import type { Address, Hex } from 'viem';

import { ADDRESSES, sameAddress } from './rhc';
import { mandateAccountAbi, mandateAccountFactoryAbi, settlementAssetAbi } from './abi';
import { rhcClient } from './client';
import { ReadBatch, runBatch } from './batch';
import { toLimitsTuple } from './limits';
import type { LimitsForm } from './limits';

/** Enough of a mandate to list it. The full reading is one account at a time through readSystem. */
export type MandateSummary = {
  readonly address: Address;
  readonly agent: Address;
  readonly paused: boolean;
  readonly revoked: boolean;
  readonly balance: Micro;
  readonly perCallCap: Micro;
  readonly dailyRemaining: Micro;
  readonly monthlyRemaining: Micro;
  readonly version: bigint;
};

/** Every mandate a principal owns. One call. */
export async function mandatesOf(principal: Address): Promise<readonly Address[]> {
  return (await readContract(rhcClient(), {
    address: ADDRESSES.mandateAccountFactory,
    abi: mandateAccountFactoryAbi,
    functionName: 'accountsOf',
    args: [principal],
  })) as readonly Address[];
}

/**
 * The runtime code every account the factory deploys runs, with its two per-account fields zeroed.
 *
 * Anything can answer `principal()` and `limits()` and look like a mandate to a reader, and a page on
 * this domain that shows owner controls for a look-alike lends the domain to whoever deployed it. The
 * factory's list cannot settle it on its own: it files an account under the principal that created
 * it, so a mandate whose ownership moved would read as foreign. The code settles it for every
 * account. The factory deploys one contract, and its only immutables are the escrow and the
 * settlement asset, which are the same for all of them, plus the EIP-712 cache: the account's own
 * address and the domain separator built from it. Zero those two and every genuine account hashes
 * to this, and a contract that matches it and names itself in the address field is a genuine account.
 */
const MANDATE_CODE = {
  length: 16_607,
  selfAddress: { offset: 8_522, length: 20 },
  domainSeparator: { offset: 8_594, length: 32 },
  maskedHash: '0x5588423c534f95c86931f78024212ef022e8f777a95cd18e4ce4d945a06cbdbe' as Hex,
} as const;

/** Whether `code` is a mandate account's runtime code, deployed at `account`. Pure, so it can be tested offline. */
export function isMandateCode(account: Address, code: Hex | undefined): boolean {
  if (code === undefined) return false;
  const bytes = hexToBytes(code);
  if (bytes.length !== MANDATE_CODE.length) return false;

  const { selfAddress, domainSeparator } = MANDATE_CODE;
  const named = bytesToHex(bytes.subarray(selfAddress.offset, selfAddress.offset + selfAddress.length));
  if (!sameAddress(named, account)) return false;

  const masked = bytes.slice();
  masked.fill(0, selfAddress.offset, selfAddress.offset + selfAddress.length);
  masked.fill(0, domainSeparator.offset, domainSeparator.offset + domainSeparator.length);
  return keccak256(masked) === MANDATE_CODE.maskedHash;
}

/** Whether the address is an account the factory deployed, whoever owns it now. */
export async function isBursarMandate(account: Address): Promise<boolean> {
  return isMandateCode(account, await getCode(rhcClient(), { address: account }));
}

/**
 * The list view, in two requests whatever the count: one for the addresses, one batch for six
 * readings against each. Six calls per mandate fanned out is where a console with a dozen mandates
 * meets the endpoint's rate meter.
 */
export async function readMandateSummaries(
  principal: Address,
  signal?: AbortSignal,
): Promise<readonly MandateSummary[]> {
  const addresses = await mandatesOf(principal);
  if (addresses.length === 0) return [];

  const batch = new ReadBatch();
  const slots = addresses.map((address) => ({
    address,
    agent: batch.add<Address>('agent', { address, abi: mandateAccountAbi as never, functionName: 'agent' }),
    paused: batch.add<boolean>('paused', { address, abi: mandateAccountAbi as never, functionName: 'paused' }),
    revoked: batch.add<boolean>('revoked', { address, abi: mandateAccountAbi as never, functionName: 'revoked' }),
    version: batch.add<bigint>('version', { address, abi: mandateAccountAbi as never, functionName: 'version' }),
    perCallCap: batch.add<bigint>('perCallCap', { address, abi: mandateAccountAbi as never, functionName: 'perCallCap' }),
    remaining: batch.add<readonly [bigint, bigint, bigint]>('remaining', { address, abi: mandateAccountAbi as never, functionName: 'remaining' }),
    balance: batch.add<bigint>('balance', { address: ADDRESSES.usdg, abi: settlementAssetAbi as never, functionName: 'balanceOf', args: [address] }),
  }));

  const results = await runBatch(rhcClient(), batch, signal);

  return slots.map((slot) => {
    const remaining = results.get(slot.remaining);
    return {
      address: slot.address,
      agent: results.get(slot.agent) ?? ('0x' as Address),
      paused: results.get(slot.paused) ?? false,
      revoked: results.get(slot.revoked) ?? false,
      balance: micro(results.get(slot.balance) ?? 0n),
      perCallCap: micro(results.get(slot.perCallCap) ?? 0n),
      dailyRemaining: micro(remaining?.[1] ?? 0n),
      monthlyRemaining: micro(remaining?.[2] ?? 0n),
      version: results.get(slot.version) ?? 0n,
    };
  });
}

/**
 * The address a mandate will deploy at, before it exists.
 *
 * The principal, the agent, the salt and the limits together fix it, so the account can be funded
 * before a single transaction is sent. Change any of the four and it is a different address.
 */
export async function predictMandate(args: {
  readonly principal: Address;
  readonly agent: Address;
  readonly salt: Hex;
  readonly limits: LimitsForm;
}): Promise<Address> {
  return (await readContract(rhcClient(), {
    address: ADDRESSES.mandateAccountFactory,
    abi: mandateAccountFactoryAbi,
    functionName: 'predict',
    args: [args.principal, args.agent, args.salt, toLimitsTuple(args.limits)],
  })) as Address;
}

/** The predicted address, and whether something already stands at it. */
export type PredictedMandate = { readonly address: Address; readonly deployed: boolean };

/**
 * The address a create would land at, with the one condition that stops the create.
 *
 * The factory refuses a salt whose address already holds code, and it is the only way `create`
 * can fail on inputs the form collects. Reading the code alongside the prediction is what lets
 * the form say so before a wallet opens, rather than after the fee has been paid.
 */
export async function predictMandateSlot(args: {
  readonly principal: Address;
  readonly agent: Address;
  readonly salt: Hex;
  readonly limits: LimitsForm;
}): Promise<PredictedMandate> {
  const address = await predictMandate(args);
  const code = await getCode(rhcClient(), { address });
  return { address, deployed: code !== undefined && code !== '0x' };
}

/** Random 32 bytes, so two mandates with identical limits still land at different addresses. */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
