import type { Address } from 'viem';
import { BursarError } from './errors.js';
import { parseDeployment } from './deployment-record.js';
import { RAW_DEPLOYMENTS } from './generated/deployments.js';
import type { RawDeploymentName } from './generated/deployments.js';
import type { Deployment, MandateContractName } from './deployment-record.js';

export {
  BURSAR_CONTRACT_NAMES,
  isMandateDeploymentRecord,
  isRetiredDeploymentRecord,
  parseDeployment,
  selectDeploymentRecords,
} from './deployment-record.js';
export type {
  Deployment,
  DeploymentRecordFile,
  DeploymentRoles,
  MandateContractName,
  RwaAssetKind,
  RwaAssetRecord,
  PrivacyDeployment,
  RwaDeployment,
} from './deployment-record.js';

export type DeploymentName = RawDeploymentName;

/**
 * Parsed at import so a malformed record fails the process rather than one request. The records
 * are generated from contracts/deployments, so this only trips when a deploy wrote something
 * wrong. An empty address book is not wrong either: the workspace has to build before a chain has
 * anything on it.
 */
export const DEPLOYMENTS: Readonly<Record<DeploymentName, Deployment>> = Object.freeze(
  Object.fromEntries(
    Object.entries(RAW_DEPLOYMENTS).map(([name, record]) => [name, parseDeployment(record, name)]),
  ) as Record<DeploymentName, Deployment>,
);

/** Everything still in service. A retired record is history and is excluded. */
export function liveDeployments(): readonly Deployment[] {
  return Object.values(DEPLOYMENTS).filter((d) => d.retired === undefined);
}

function nameOf(d: Deployment): string {
  return Object.entries(DEPLOYMENTS).find(([, record]) => record === d)?.[0] ?? d.network;
}

/**
 * Whether a newer live record on the same chain names this one in `supersedes`. A superseded
 * record is still live: its contracts hold locks and disputes that have to be read and settled.
 * It only stops answering for its chain.
 */
export function isSuperseded(d: Deployment): boolean {
  const name = nameOf(d);
  return liveDeployments().some((other) => other.chainId === d.chainId && other.supersedes === name);
}

/**
 * Every live record on a chain, newest first: the one that answers for the chain, then the record
 * it supersedes, and so on down the line. What a service that has to serve old contracts as well
 * as new ones iterates.
 */
export function deploymentsForChain(chainId: number): readonly Deployment[] {
  const live = liveDeployments().filter((d) => d.chainId === chainId);
  const ordered: Deployment[] = [];
  let next = live.find((d) => !isSuperseded(d));
  while (next !== undefined && !ordered.includes(next)) {
    ordered.push(next);
    const older = next.supersedes;
    next = older === undefined ? undefined : live.find((d) => nameOf(d) === older);
  }
  return [...ordered, ...live.filter((d) => !ordered.includes(d))];
}

/**
 * The record, retired or not, that deployed a given contract at a given address. How a reader
 * holding only an address (a mandate's escrow, a lock's registry) works out which contract set,
 * and so which ABI, it is talking to.
 */
export function deploymentByContract(
  contract: MandateContractName,
  address: Address,
): Deployment | undefined {
  const wanted = address.toLowerCase();
  return Object.values(DEPLOYMENTS).find((d) => d.contracts[contract].toLowerCase() === wanted);
}

const REGENERATE = 'After a new deploy, run `pnpm --filter @bursar/core codegen`.';

export function deployment(name: DeploymentName): Deployment {
  // Own keys only, because the name can come from configuration and `constructor` is not a record.
  const found = Object.hasOwn(DEPLOYMENTS, name) ? DEPLOYMENTS[name] : undefined;
  if (!found) {
    const known = Object.keys(DEPLOYMENTS);
    throw new BursarError(
      'deployment_unknown',
      `No deployment named "${name}". ` +
        (known.length === 0
          ? `The address book is empty: nothing has been deployed yet. ${REGENERATE}`
          : `Known: ${known.join(', ')}. ${REGENERATE}`),
      { name, known },
    );
  }
  return found;
}

/**
 * The deployment serving a chain, or a refusal.
 *
 * Where a newer record supersedes an older one, the newer one answers. The older one is still
 * reachable by name and through deploymentsForChain.
 *
 * Retired records are skipped rather than returned. Their contracts are still on their chain and
 * would still answer a call, which is why a lookup must not hand one back: a service that
 * resolves by chain id and gets a superseded address book reads stale state and writes to
 * contracts nobody is watching.
 */
export function deploymentForChain(chainId: number): Deployment {
  const live = liveDeployments();
  const found = deploymentsForChain(chainId)[0];
  if (found) return found;

  const retired = Object.values(DEPLOYMENTS).find((d) => d.chainId === chainId);
  if (retired) {
    throw new BursarError(
      'deployment_retired',
      `The only record for chain ${chainId} is "${retired.network}", which is retired: ` +
        `${retired.retired ?? 'superseded'} ${REGENERATE}`,
      { chainId, network: retired.network, retired: retired.retired },
    );
  }

  throw new BursarError(
    'deployment_unknown',
    live.length === 0
      ? `No deployment record for chain ${chainId}. Nothing is deployed yet. ${REGENERATE}`
      : `No deployment record for chain ${chainId}. Deployed: ${live
          .map((d) => `${d.network} (${d.chainId})`)
          .join(', ')}.`,
    { chainId, known: live.map((d) => d.chainId) },
  );
}

export function contractAddress(name: DeploymentName, contract: MandateContractName): Address {
  return deployment(name).contracts[contract];
}
