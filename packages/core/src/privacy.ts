import { currentSetDeployments } from './contract-set.js';
import type { PrivacyDeployment } from './deployment-record.js';

/**
 * The privacy contracts that answer for a chain, if deployed: the newest record carrying them
 * within the contract set that answers for the chain. An earlier set's are never read in their place.
 */
export function privacyDeployment(chainId: number): PrivacyDeployment | undefined {
  return currentSetDeployments(chainId).find((d) => d.privacy !== undefined)?.privacy;
}
