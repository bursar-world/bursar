import type { Address } from 'viem';
import { BursarError } from './errors.js';
import { parseDeployment } from './deployment-record.js';
import { RAW_DEPLOYMENTS } from './generated/deployments.js';
import type { RawDeploymentName } from './generated/deployments.js';
import type { Deployment, MandateContractName } from './deployment-record.js';

export {
  BURSAR_CONTRACT_NAMES,
  isMandateDeploymentRecord,
  isPlannedDeploymentRecord,
  isRetiredDeploymentRecord,
  parseCollateralDeployment,
  parseDeployment,
  parseRwaDeployment,
  selectDeploymentRecords,
} from './deployment-record.js';
export type {
  Deployment,
  DeploymentRecordFile,
  DeploymentRoles,
  DeploymentStatus,
  MandateContractName,
  RwaAssetKind,
  RwaAssetRecord,
  CollateralDeployment,
  PrivacyDeployment,
  ShieldedDeployment,
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

/**
 * Everything still in service: the records that answer for their chains and the superseded ones
 * behind them. A retired record is history and is excluded.
 */
export function liveDeployments(): readonly Deployment[] {
  return Object.values(DEPLOYMENTS).filter(inService);
}

function inService(d: Deployment): boolean {
  return d.status === 'live' || d.status === 'superseded';
}

function nameOf(d: Deployment): string {
  return Object.entries(DEPLOYMENTS).find(([, record]) => record === d)?.[0] ?? d.network;
}

/**
 * Whether the record is marked superseded, or a newer record on the same chain names it in
 * `supersedes`. A superseded record's contracts still hold locks and disputes that have to be read
 * and settled, so it stays readable; it only stops answering for its chain.
 */
export function isSuperseded(d: Deployment): boolean {
  if (d.status === 'superseded') return true;
  const name = nameOf(d);
  return Object.values(DEPLOYMENTS).some((other) => other.chainId === d.chainId && other.supersedes === name);
}

/** The record that answers for a chain: live, and superseded by nothing. */
function answering(chainId: number): Deployment | undefined {
  return Object.values(DEPLOYMENTS).find((d) => d.chainId === chainId && d.status === 'live' && !isSuperseded(d));
}

/**
 * Every record a service on a chain still reads, newest first: the one that answers for the chain,
 * then the record it supersedes, and so on down the line. What a service that has to serve old
 * contracts as well as new ones iterates.
 *
 * The line is followed through retired records too. Retiring a set stops it taking new work; the
 * locks and disputes already opened on it are still on chain and still have to be settled. A
 * retired record nothing supersedes is history and is left out.
 */
export function deploymentsForChain(chainId: number): readonly Deployment[] {
  const onChain = Object.values(DEPLOYMENTS).filter((d) => d.chainId === chainId);
  const ordered: Deployment[] = [];
  let next = answering(chainId);
  while (next !== undefined && !ordered.includes(next)) {
    ordered.push(next);
    const older = next.supersedes;
    next = older === undefined ? undefined : onChain.find((d) => nameOf(d) === older);
  }
  return [...ordered, ...onChain.filter((d) => inService(d) && !ordered.includes(d))];
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
  const found = answering(chainId);
  if (found) return found;

  // The newest record is the one no other record on the chain supersedes.
  const onChain = Object.values(DEPLOYMENTS).filter((d) => d.chainId === chainId);
  const newest = onChain.find((d) => !onChain.some((other) => other.supersedes === nameOf(d))) ?? onChain[0];
  if (newest) {
    const state =
      newest.status === 'superseded'
        ? `is superseded by "${newest.supersededBy ?? 'a newer record'}", which this address book does not carry.`
        : `is retired.${newest.retired === undefined ? '' : ` ${newest.retired}`}`;
    throw new BursarError(
      'deployment_retired',
      `No live record for chain ${chainId}. "${newest.network}" ${state} ${REGENERATE}`,
      { chainId, network: newest.network, retired: newest.retired },
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
