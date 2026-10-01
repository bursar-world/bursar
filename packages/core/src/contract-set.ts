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
 * v4. v1, v2 and v3 are the sets on chain 4663 under rhc-mainnet, rhc-mainnet-v2 and
 * rhc-mainnet-v3. v1 and v2 are each read through a frozen copy of their own ABIs.
 *
 * v2 and v3 accounts share one shape: the same limits, classes and lanes. What moved between them
 * is the escrow and the dispute layer. A v3 escrow floors the lock size, books a payout a frozen
 * address cannot take as owed, and has no dispute timeout; a v3 registry records the payer's
 * principal with the parties.
 *
 * v3 has no frozen copy, because the generated ABIs describe everything a v3 contract answers the
 * way it answers it. What v4 added is what a v3 contract lacks: reputation weighed by settled
 * volume and counterparties, the price guard's observations and the draw rule the vault reads off
 * them, collateral seized on a write-off, the shielded pool's window per depositor, and a
 * withdrawal request the provider registry takes while paused. A reader asks
 * `contractSetAtLeast(set, 'v4')` before it calls any of those.
 */
export type ContractSet = 'v1' | 'v2' | 'v3' | 'v4';

/** Oldest first. */
const SETS: readonly ContractSet[] = ['v1', 'v2', 'v3', 'v4'];

/** The set the generated ABIs describe, and the one a record no earlier set names runs. */
export const CURRENT_CONTRACT_SET: ContractSet = 'v4';

/** Records deployed from earlier source. Named, because what each set has and lacks is true of exactly these. */
const FROZEN_RECORDS: ReadonlyMap<string, ContractSet> = new Map([
  ['rhc-mainnet', 'v1'],
  ['rhc-mainnet-v2', 'v2'],
  ['rhc-mainnet-v3', 'v3'],
]);

export function contractSetOf(d: Deployment): ContractSet {
  return FROZEN_RECORDS.get(d.network) ?? CURRENT_CONTRACT_SET;
}

/**
 * Whether `set` is `floor` or a later build. What a reader asks before it uses something `floor`
 * introduced, so the answer stays right when the next set lands.
 */
export function contractSetAtLeast(set: ContractSet, floor: ContractSet): boolean {
  return SETS.indexOf(set) >= SETS.indexOf(floor);
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
 * earlier set deployed runs that set's build: it admits only that set's accounts, and it may lack
 * what a reader of the answering set goes on to call. So it is never read in place of a lane the
 * answering set has not deployed yet.
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

/** None of the five moved between v3 and v4, so one set of ABIs reads both. */
export const V4_ABIS = V3_ABIS;
