import type { Address } from 'viem';
import type { Deployment } from './deployment-record.js';
import { deploymentByContract, deploymentsForChain } from './deployments.js';
import {
  adminTimelockAbiV1,
  escrowAbiV1,
  mandateAccountAbiV1,
  mandateAccountFactoryAbiV1,
  oracleRegistryAbiV1,
} from './abi-v1.js';
import {
  adminTimelockAbiV2,
  escrowAbiV2,
  mandateAccountAbiV2,
  mandateAccountFactoryAbiV2,
  oracleRegistryAbiV2,
} from './abi-v2.js';
import {
  adminTimelockAbi,
  escrowAbi,
  mandateAccountAbi,
  mandateAccountFactoryAbi,
  oracleRegistryAbi,
} from './generated/abi.js';

/**
 * Which build of the contracts a deployment runs. The generated ABIs describe the current source,
 * v3. v1 and v2 are the sets still on chain 4663 under rhc-mainnet and rhc-mainnet-v2, each read
 * through a frozen copy of its own ABIs.
 *
 * v2 and v3 accounts share one shape: the same limits, classes and lanes. What moved between them
 * is the escrow and the dispute layer. A v3 escrow floors the lock size, books a payout a frozen
 * address cannot take as owed, and has no dispute timeout; a v3 registry records the payer's
 * principal with the parties.
 */
export type ContractSet = 'v1' | 'v2' | 'v3';

/** The set the generated ABIs describe, and the one a record no frozen set names runs. */
export const CURRENT_CONTRACT_SET: ContractSet = 'v3';

/** Records deployed from earlier source. Named, because each frozen copy describes exactly these. */
const FROZEN_RECORDS: ReadonlyMap<string, ContractSet> = new Map([
  ['rhc-mainnet', 'v1'],
  ['rhc-mainnet-v2', 'v2'],
]);

export function contractSetOf(d: Deployment): ContractSet {
  return FROZEN_RECORDS.get(d.network) ?? CURRENT_CONTRACT_SET;
}

/**
 * The contract set behind a mandate, known from the escrow it was created against. Undefined for
 * an escrow no record names.
 */
export function contractSetOfEscrow(escrow: Address): ContractSet | undefined {
  const d = deploymentByContract('Escrow', escrow);
  return d === undefined ? undefined : contractSetOf(d);
}

/** The same, for a dispute registry. */
export function contractSetOfRegistry(registry: Address): ContractSet | undefined {
  const d = deploymentByContract('OracleRegistry', registry);
  return d === undefined ? undefined : contractSetOf(d);
}

/**
 * The records on a chain that run the same build as the one answering for it, newest first.
 *
 * Where a lane lives in a record (RWA, collateral, privacy), only these may supply it. A lane an
 * earlier set deployed runs that set's build, which the generated ABIs do not describe, so it is
 * never read in place of a lane the current set has not deployed yet.
 */
export function currentSetDeployments(chainId: number): readonly Deployment[] {
  const line = deploymentsForChain(chainId);
  const head = line[0];
  if (head === undefined) return [];
  const set = contractSetOf(head);
  return line.filter((d) => contractSetOf(d) === set);
}

export const V1_ABIS = {
  MandateAccount: mandateAccountAbiV1,
  MandateAccountFactory: mandateAccountFactoryAbiV1,
  Escrow: escrowAbiV1,
  OracleRegistry: oracleRegistryAbiV1,
  AdminTimelock: adminTimelockAbiV1,
} as const;

export const V2_ABIS = {
  MandateAccount: mandateAccountAbiV2,
  MandateAccountFactory: mandateAccountFactoryAbiV2,
  Escrow: escrowAbiV2,
  OracleRegistry: oracleRegistryAbiV2,
  AdminTimelock: adminTimelockAbiV2,
} as const;

export const V3_ABIS = {
  MandateAccount: mandateAccountAbi,
  MandateAccountFactory: mandateAccountFactoryAbi,
  Escrow: escrowAbi,
  OracleRegistry: oracleRegistryAbi,
  AdminTimelock: adminTimelockAbi,
} as const;
