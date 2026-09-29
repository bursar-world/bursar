import { contractSetOf, deploymentsForChain } from '@bursar/core';
import type { ContractSet, Deployment } from '@bursar/core';
import type { Address } from 'viem';

import { CHAIN_ID, deployment } from './rhc';

/**
 * One deployment of the escrow and dispute contracts, as a reading names it.
 *
 * The chain carries more than one. The current set takes new locks, disputes and votes; an older
 * set it supersedes still holds locks and disputes that were opened against it, and those have to
 * stay visible until they close. The console reads an older set and never writes to it.
 */
export type DeploymentTag = {
  /** The record's name, e.g. `rhc-mainnet-v2`. Stable, so it keys caches and lists. */
  readonly name: string;
  readonly contractSet: ContractSet;
  /** The set that answers for the chain. False for a set kept readable for what it still holds. */
  readonly current: boolean;
  readonly escrow: Address;
  readonly oracleRegistry: Address;
};

function tagOf(d: Deployment, current: boolean): DeploymentTag {
  return {
    name: d.network,
    contractSet: contractSetOf(d),
    current,
    escrow: d.contracts.Escrow,
    oracleRegistry: d.contracts.OracleRegistry,
  };
}

/** The set this build writes to. */
export function currentDeployment(): DeploymentTag {
  return tagOf(deployment(), true);
}

/**
 * Every live set on this chain, the current one first, then the sets it supersedes. Only the first
 * is ever written to.
 */
export function readableDeployments(): readonly DeploymentTag[] {
  const current = deployment();
  const older = deploymentsForChain(CHAIN_ID).filter(
    (d) => d.network !== current.network && d.contracts.Escrow.toLowerCase() !== current.contracts.Escrow.toLowerCase(),
  );
  return [tagOf(current, true), ...older.map((d) => tagOf(d, false))];
}

/** How a screen names a set: the current contracts, or earlier ones this console only reads. */
export function deploymentLabel(tag: DeploymentTag): string {
  return tag.current ? 'current contracts' : 'earlier contracts, read only';
}
