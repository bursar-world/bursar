/**
 * One source of ABIs. @bursar/core generates them from the compiled contracts, so nothing here
 * re-types a function signature that already exists there, including the compliance surface.
 */
import { settlementAssetAbi } from '@bursar/core';

export {
  adminTimelockAbi,
  agentRegistryAbi,
  escrowAbi,
  mandateAccountAbi,
  mandateAccountFactoryAbi,
  oracleRegistryAbi,
  reputationAbi,
  settlementAssetAbi,
} from '@bursar/core';

import { multicall3Abi } from 'viem';

export { multicall3Abi };

/**
 * `arbBlockNumber()`, the only function on ArbSys this product reads.
 *
 * Robinhood Chain is an Arbitrum Orbit chain, and `block.number` inside its EVM answers the
 * settlement chain's height rather than its own: Multicall3's `getBlockNumber` comes back around
 * 26,040,000 while `eth_blockNumber` and the explorer are around 70,584,000. A figure labelled as
 * this chain's block has to come from here. It is a view call to a precompile, so it reads inside
 * the same aggregate as everything else and every number on a screen still comes from one block.
 *
 * `getCurrentBlockTimestamp` on Multicall3 is `block.timestamp`, which the sequencer does set to
 * this chain's own time. Clocks and countdowns keep reading it.
 */
export const arbSysAbi = [
  {
    type: 'function',
    name: 'arbBlockNumber',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

/**
 * The three compliance functions, narrowed out of the settlement asset's own ABI.
 *
 * A regulated dollar token carries a surface the transfer interface does not describe: one
 * address can be blocked, and the whole token can be paused. A transfer reverts on either
 * whatever the balance says and whatever a mandate allows, so the product has to read them.
 *
 * The token is a diamond, and a selector it does not route reverts `FacetNotFound` (`0x800ab12c`)
 * rather than answering false. `isFrozen` is the per-address control; `isBlacklisted` does not
 * exist, and there is no `pauser` and no `blacklister`. `owner` is the address that holds both
 * controls. Calling any of the absent ones would put every compliance reading at unknown, and an
 * asset state that can never be clear is worse than none. Narrowing from core rather than
 * re-declaring is what keeps this list and the generated one from drifting apart.
 *
 * The product says blocked, which is what it means to the person reading it. These are the
 * contract's own names and stay at this layer.
 */
const COMPLIANCE_FUNCTIONS = ['isFrozen', 'paused', 'owner'] as const;

type ComplianceFunction = (typeof COMPLIANCE_FUNCTIONS)[number];

export const settlementComplianceAbi = settlementAssetAbi.filter(
  (entry): entry is Extract<(typeof settlementAssetAbi)[number], { name: ComplianceFunction }> =>
    entry.type === 'function' &&
    (COMPLIANCE_FUNCTIONS as readonly string[]).includes(entry.name),
);
