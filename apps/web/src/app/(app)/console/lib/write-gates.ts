import type { AnyState, SystemState } from '@/state';

/**
 * Which of the five conditions stands in the way of a write, by what the write moves.
 *
 * Connectivity gates everything: an endpoint that does not answer takes no transaction at all.
 * The settlement asset gates only the calls that move USDG. A paused token or a blocked address
 * stops a deposit, a withdrawal and the bond a dispute posts. It stops none of the controls: the
 * asset state says so itself, in the sentence about a pause, a revoke and a withdrawal still
 * confirming because fees are paid in ETH. Gating a pause on the token would take the switch away
 * from an owner at the exact moment the token being down makes them want it.
 */
export function callGates(system: SystemState): readonly AnyState[] {
  return [system.connectivity];
}

/** For a write that moves USDG, where the token's own state decides whether the transfer lands. */
export function transferGates(system: SystemState): readonly AnyState[] {
  return [system.connectivity, system.asset];
}
