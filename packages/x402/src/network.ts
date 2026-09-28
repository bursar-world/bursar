import { caip2 } from '@bursar/core';
import type { RhcChain, Caip2 } from '@bursar/core';

/**
 * Network identity lives in `@bursar/core`, where the client, the services and the console all
 * reach it. It is re-exported here so `@bursar/x402` still answers the question it has always
 * answered, and so the facilitator and the agent cannot disagree about what one chain is.
 */
export { canonicalNetwork, networkChainId, sameNetwork } from '@bursar/core';

/**
 * Network identity, in the one spelling Robinhood Chain has.
 *
 * The protocol's first version predates CAIP-2 and named chains ("base", "base-sepolia"), so
 * implementations carry an alias table. Robinhood Chain has no such name: it appears in no
 * facilitator's network list, and no client has ever been handed anything but `eip155:4663`.
 * Inventing a short name now would create two spellings for one chain and break the clients that
 * integrate against the only one that exists. Both protocol versions see the CAIP-2 form here.
 */
export function chainNetwork(chain: RhcChain): Caip2 {
  return caip2(chain.chainId);
}
