import { committedMandateAccountAbi, committedMandateFactoryAbi, escrowAbi, privacyDeployment, settlementAssetAbi } from '@bursar/core';
import type { PrivacyDeployment } from '@bursar/core';
import type { CommittedClass, TermsInput } from '@bursar/sdk';
import { getAddress, isAddress, parseEventLogs } from 'viem';
import type { Address } from 'viem';

import { rhcClient } from './client';
import { CHAIN_ID, sameAddress } from './rhc';
import { parseUsdgInput } from '@/money';

/**
 * Private mandates: the terms sit behind a commitment on chain, and the readable copy is sealed to
 * the owner's viewing key. Everything here is a reading or a pure check; the signing and the
 * sealing happen in the SDK.
 */

export function privateContracts(): PrivacyDeployment | undefined {
  return privacyDeployment(CHAIN_ID);
}

/** Every factory whose accounts this console treats as private mandates. */
export function committedFactories(contracts = privateContracts()): readonly Address[] {
  if (contracts === undefined) return [];
  return [contracts.CommittedMandateFactory, ...(contracts.CommittedMandateFactoryV1Escrow ? [contracts.CommittedMandateFactoryV1Escrow] : [])];
}

export const PERIODS = [
  { seconds: 86_400, label: 'Day' },
  { seconds: 604_800, label: 'Week' },
  { seconds: 2_592_000, label: '30 days' },
] as const;

/** The private terms as a person types them. */
export type PrivateForm = {
  readonly perCall: string;
  readonly periodCap: string;
  readonly periodLen: number;
  readonly total: string;
  readonly classes: Readonly<Record<CommittedClass, boolean>>;
  readonly counterparties: readonly Address[];
  /** ISO date. Required: a private mandate always ends. */
  readonly expiry: string;
};

export const EMPTY_PRIVATE_FORM: PrivateForm = {
  perCall: '',
  periodCap: '',
  periodLen: 86_400,
  total: '',
  classes: { service: true, hire: false },
  counterparties: [],
  expiry: '',
};

export type PrivateReading = { readonly terms: TermsInput | undefined; readonly problems: readonly string[] };

/** Turns the form into terms the SDK can commit to, or says what is missing. */
export function readPrivateForm(form: PrivateForm, now: number = Date.now()): PrivateReading {
  const problems: string[] = [];
  const amount = (text: string, name: string): bigint | undefined => {
    const parsed = parseUsdgInput(text);
    if (!parsed.ok) {
      problems.push(`Enter the ${name}.`);
      return undefined;
    }
    if (parsed.value <= 0n) {
      problems.push(`The ${name} has to be above zero.`);
      return undefined;
    }
    return parsed.value;
  };
  const perCallCap = amount(form.perCall, 'per-payment cap');
  const periodCap = amount(form.periodCap, 'period cap');
  const totalCap = amount(form.total, 'total budget');
  if (perCallCap !== undefined && periodCap !== undefined && periodCap < perCallCap) {
    problems.push('The period cap cannot be smaller than the per-payment cap.');
  }
  if (periodCap !== undefined && totalCap !== undefined && totalCap < periodCap) {
    problems.push('The total budget cannot be smaller than the period cap.');
  }
  const classes = (Object.keys(form.classes) as CommittedClass[]).filter((id) => form.classes[id]);
  if (classes.length === 0) problems.push('Allow services, agent hires, or both.');
  if (form.counterparties.length === 0) problems.push('Name at least one provider this mandate may pay.');

  const expiryMs = Date.parse(form.expiry);
  let expiry: number | undefined;
  if (form.expiry === '' || Number.isNaN(expiryMs)) problems.push('Choose the date the mandate ends.');
  else if (expiryMs <= now) problems.push('The end date has to be in the future.');
  else expiry = Math.floor(expiryMs / 1000);

  if (problems.length > 0 || perCallCap === undefined || periodCap === undefined || totalCap === undefined || expiry === undefined) {
    return { terms: undefined, problems };
  }
  return {
    terms: { perCallCap, periodCap, periodLen: form.periodLen, totalCap, classes, counterparties: form.counterparties, expiry },
    problems: [],
  };
}

export type CommittedRead = {
  readonly address: Address;
  readonly factory: Address;
  readonly principal: Address;
  readonly agent: Address;
  readonly escrow: Address;
  readonly verifier: Address;
  readonly paused: boolean;
  readonly revoked: boolean;
  readonly version: bigint;
  readonly nonce: bigint;
  readonly termsCommitment: bigint;
  readonly balance: bigint;
};

/**
 * Reads a private mandate, or undefined when the address is not one this console's factories made.
 * A contract that answers the same getters and was not listed by the factory is not vouched for.
 */
export async function readCommittedMandate(address: Address): Promise<CommittedRead | undefined> {
  const contracts = privateContracts();
  const factories = committedFactories(contracts);
  if (factories.length === 0) return undefined;
  const client = rhcClient();
  const abi = committedMandateAccountAbi;

  let factory: Address;
  try {
    factory = await client.readContract({ address, abi, functionName: 'factory' });
  } catch {
    return undefined;
  }
  if (!factories.some((known) => sameAddress(known, factory))) return undefined;

  const [principal, agent, escrow, verifier, paused, revoked, version, nonce, termsCommitment, asset] = await Promise.all([
    client.readContract({ address, abi, functionName: 'principal' }),
    client.readContract({ address, abi, functionName: 'agent' }),
    client.readContract({ address, abi, functionName: 'escrow' }),
    client.readContract({ address, abi, functionName: 'verifier' }),
    client.readContract({ address, abi, functionName: 'paused' }),
    client.readContract({ address, abi, functionName: 'revoked' }),
    client.readContract({ address, abi, functionName: 'version' }),
    client.readContract({ address, abi, functionName: 'nonce' }),
    client.readContract({ address, abi, functionName: 'termsCommitment' }),
    client.readContract({ address, abi, functionName: 'settlementAsset' }),
  ]);
  const listed = await client.readContract({ address: factory, abi: committedMandateFactoryAbi, functionName: 'accountsOf', args: [principal] });
  if (!listed.some((entry) => sameAddress(entry, address))) return undefined;
  const balance = await client.readContract({ address: asset, abi: settlementAssetAbi, functionName: 'balanceOf', args: [address] });

  return { address, factory, principal, agent, escrow, verifier, paused, revoked, version, nonce, termsCommitment, balance };
}

export type ProvenPayment = {
  readonly escrowId: bigint;
  readonly payee: Address;
  readonly amount: bigint;
  readonly status: number;
  readonly inputURI: string;
  readonly inputCommit: `0x${string}`;
  readonly outputCommit: `0x${string}`;
  readonly hash: `0x${string}`;
};

/** Every payment the account opened with a proof, newest first, with what the escrow says of each. */
export async function readProvenPayments(mandate: CommittedRead, fromBlock: bigint): Promise<readonly ProvenPayment[]> {
  const client = rhcClient();
  const logs = await client.getLogs({ address: mandate.address, fromBlock, toBlock: 'latest' });
  const spends = parseEventLogs({ abi: committedMandateAccountAbi, logs, eventName: 'ProvenSpend' });
  const rows = await Promise.all(
    spends.map(async (log) => {
      const lock = await client.readContract({ address: mandate.escrow, abi: escrowAbi, functionName: 'getLock', args: [log.args.escrowId] });
      return {
        escrowId: log.args.escrowId,
        payee: lock.payee,
        amount: lock.amount,
        status: lock.status,
        inputURI: lock.inputURI,
        inputCommit: lock.inputCommit,
        outputCommit: lock.outputCommit,
        hash: log.transactionHash,
      };
    }),
  );
  return rows.sort((a, b) => Number(b.escrowId - a.escrowId));
}

/** A provider list pasted or typed as addresses, one per line or separated by commas. */
export function readAddressList(text: string): { readonly addresses: readonly Address[]; readonly rejected: readonly string[] } {
  const addresses: Address[] = [];
  const rejected: string[] = [];
  for (const entry of text.split(/[\s,]+/).filter((piece) => piece !== '')) {
    if (!isAddress(entry, { strict: false })) {
      rejected.push(entry);
      continue;
    }
    const value = getAddress(entry);
    if (!addresses.some((known) => sameAddress(known, value))) addresses.push(value);
  }
  return { addresses, rejected };
}

export const TERMS_FILE_TYPE = 'application/json';

export function termsFileName(address: Address): string {
  return `bursar-private-terms-${address.slice(2, 10).toLowerCase()}.json`;
}
