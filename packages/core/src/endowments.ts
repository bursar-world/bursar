import { currentSetDeployments } from './contract-set.js';
import type { EndowmentsDeployment } from './deployment-record.js';

/**
 * The endowment factory that answers for a chain, if deployed: the newest record carrying one
 * within the contract set that answers for the chain.
 */
export function endowmentsDeployment(chainId: number): EndowmentsDeployment | undefined {
  return currentSetDeployments(chainId).find((d) => d.endowments !== undefined)?.endowments;
}
