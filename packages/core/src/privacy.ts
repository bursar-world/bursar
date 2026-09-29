import { deploymentsForChain } from './deployments.js';
import type { PrivacyDeployment } from './deployment-record.js';

/** The privacy contracts that answer for a chain, if deployed. The newest record carrying them wins. */
export function privacyDeployment(chainId: number): PrivacyDeployment | undefined {
  return deploymentsForChain(chainId).find((d) => d.privacy !== undefined)?.privacy;
}
