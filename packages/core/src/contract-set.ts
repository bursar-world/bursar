import type { Address } from 'viem';
import type { Deployment } from './deployment-record.js';
import { deploymentByContract } from './deployments.js';
import {
  adminTimelockAbiV1,
  escrowAbiV1,
  mandateAccountAbiV1,
  mandateAccountFactoryAbiV1,
  oracleRegistryAbiV1,
} from './abi-v1.js';
import {
  adminTimelockAbi,
  escrowAbi,
  mandateAccountAbi,
  mandateAccountFactoryAbi,
  oracleRegistryAbi,
} from './generated/abi.js';

/**
 * Which build of the contracts a deployment runs. The generated ABIs describe the current source;
 * v1 is the set still on chain 4663 under rhc-mainnet, read through a frozen copy of its ABIs.
 */
export type ContractSet = 'v1' | 'v2';

/** Records deployed from the v1 source. Named, because the frozen ABIs describe exactly these. */
const V1_RECORDS: ReadonlySet<string> = new Set(['rhc-mainnet']);

export function contractSetOf(d: Deployment): ContractSet {
  return V1_RECORDS.has(d.network) ? 'v1' : 'v2';
}

/**
 * The contract set behind a mandate, known from the escrow it was created against. Undefined for
 * an escrow no record names.
 */
export function contractSetOfEscrow(escrow: Address): ContractSet | undefined {
  const d = deploymentByContract('Escrow', escrow);
  return d === undefined ? undefined : contractSetOf(d);
}

export const V1_ABIS = {
  MandateAccount: mandateAccountAbiV1,
  MandateAccountFactory: mandateAccountFactoryAbiV1,
  Escrow: escrowAbiV1,
  OracleRegistry: oracleRegistryAbiV1,
  AdminTimelock: adminTimelockAbiV1,
} as const;

export const V2_ABIS = {
  MandateAccount: mandateAccountAbi,
  MandateAccountFactory: mandateAccountFactoryAbi,
  Escrow: escrowAbi,
  OracleRegistry: oracleRegistryAbi,
  AdminTimelock: adminTimelockAbi,
} as const;
