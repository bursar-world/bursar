/**
 * The registry, from the side that sells capability through it.
 *
 * A provider puts up collateral in the settlement asset and the registry publishes it. A principal
 * reads that figure before it allows anyone to be paid, and governance can take part of it from a
 * provider that failed its counterparties, on a timelocked proposal, so it is the number a
 * counterparty is trusting. A dispute ruling never reaches it: a ruling moves the refund and the
 * provider's history. Leaving runs through a delay for the same reason: collateral that could walk
 * out between a bad job and the proposal that answers it would not be collateral.
 *
 * Separately, the escrow keeps a settlement history and turns it into a ceiling on the next
 * payment this provider can be held for. Collateral buys a listing; history buys size.
 */

import { agentRegistryAbi, reputationAbi } from '@bursar/core';
import type { RhcPublicClient } from '@bursar/core';
import type { Address } from 'viem';

import { ToolError, invalidArguments } from './errors.js';
import { instant, moneyFromUint } from './format.js';
import type { RoleRelay } from './relay.js';
import type {
  ActionView,
  PendingWithdrawalView,
  ProviderGateway,
  ProviderReputationView,
  ProviderStatusView,
} from './types.js';

export type ProviderGatewayOptions = {
  readonly client: RhcPublicClient;
  /** The address the relay signs as, and the one the registry lists. */
  readonly provider: Address;
  readonly registry: Address;
  readonly reputation: Address;
  /** Absent when no signer is configured. The reads still answer; the writes are not advertised. */
  readonly relay: RoleRelay | null;
};

const NAME_PATTERN = /^[A-Za-z0-9_]{3,32}$/u;

export function createProviderGateway(options: ProviderGatewayOptions): ProviderGateway {
  const { client, provider, registry, reputation, relay } = options;

  const registryContract = { address: registry, abi: agentRegistryAbi } as const;
  const reputationContract = { address: reputation, abi: reputationAbi } as const;

  function requireRelay(): RoleRelay {
    if (relay === null) {
      throw new ToolError(
        'relay_unconfigured',
        'This server is reading the registry only. Set BURSAR_RELAY_URL to the signer that holds the ' +
          'provider address it is listed under, then restart it.',
      );
    }

    return relay;
  }

  async function status(): Promise<ProviderStatusView> {
    const [block, reads] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.multicall({
        allowFailure: false,
        contracts: [
          { ...registryContract, functionName: 'getAgent', args: [provider] },
          { ...registryContract, functionName: 'isRegistered', args: [provider] },
          { ...registryContract, functionName: 'isActive', args: [provider] },
          { ...registryContract, functionName: 'isBlacklisted', args: [provider] },
          { ...registryContract, functionName: 'minStake' },
          { ...registryContract, functionName: 'maxSlash', args: [provider] },
          { ...registryContract, functionName: 'withdrawals', args: [provider] },
          { ...registryContract, functionName: 'WITHDRAWAL_DELAY' },
          { ...registryContract, functionName: 'paused' },
        ],
      }),
    ]);

    const [agent, registered, active, blacklisted, minStake, maxSlash, pending, delay, paused] = reads;
    const [pendingAmount, requestedAt] = pending;
    const now = block.timestamp;
    const maturesAt = requestedAt + delay;

    const withdrawal: PendingWithdrawalView | null =
      pendingAmount === 0n
        ? null
        : {
            amount: moneyFromUint(pendingAmount),
            requestedAt: instant(requestedAt),
            maturesAt: instant(maturesAt),
            matured: now >= maturesAt,
          };

    return {
      provider,
      registry,
      registered,
      active,
      blacklisted,
      name: agent.name,
      stake: moneyFromUint(agent.stake),
      minStake: moneyFromUint(minStake),
      maxSlash: moneyFromUint(maxSlash),
      withdrawal,
      withdrawalDelaySeconds: Number(delay),
      registryPaused: paused,
      next: statusNote({
        registered,
        listed: agent.active,
        blacklisted,
        stake: agent.stake,
        minStake,
        maxSlash,
        withdrawal,
      }),
      observedAt: instant(now),
    };
  }

  async function reputationOf(): Promise<ProviderReputationView> {
    const [block, reads] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.multicall({
        allowFailure: false,
        contracts: [
          { ...reputationContract, functionName: 'payeeStats', args: [provider] },
          { ...reputationContract, functionName: 'score', args: [provider] },
          { ...reputationContract, functionName: 'capOf', args: [provider] },
          { ...reputationContract, functionName: 'curve' },
        ],
      }),
    ]);

    const [stats, score, cap, curve] = reads;
    const [released, timedOut, disputed] = stats;
    const settled = released + timedOut + disputed;

    return {
      provider,
      score,
      released: released.toString(),
      timedOut: timedOut.toString(),
      disputed: disputed.toString(),
      settled: settled.toString(),
      cap: moneyFromUint(cap),
      maxCap: moneyFromUint(curve.maxCap),
      next: reputationNote(settled, score, cap, curve.maxCap),
      observedAt: instant(block.timestamp),
    };
  }

  async function send(
    request: Parameters<RoleRelay['providerCall']>[0],
    action: string,
    next: string,
  ): Promise<ActionView> {
    const receipt = await requireRelay().providerCall(request);

    return { txHash: receipt.txHash, action, next };
  }

  return {
    status,
    reputation: reputationOf,

    register: async ({ name, stake }) => {
      if (!NAME_PATTERN.test(name)) {
        throw invalidArguments(
          'name is 3 to 32 characters of letters, digits and underscore. The registry refuses anything ' +
            'else rather than rendering it, because a handle carrying invisible characters can be read ' +
            "as another provider's.",
          { name },
        );
      }

      return send(
        { provider, action: 'register', name, stake: stake.toString() },
        'provider_register',
        'This provider is listed and reading as available, so a principal can allow it and the escrow ' +
          'will hold payments for it. The collateral is at risk from here: governance can take part of ' +
          'it from a provider that failed its counterparties. provider_reputation reports the ceiling on ' +
          'a single payment, which starts at the floor of the curve and rises with delivered work.',
      );
    },

    addStake: (amount) =>
      send({ provider, action: 'add-stake', amount: amount.toString() }, 'provider_add_stake',
        'The collateral is larger, and a withdrawal that was waiting has been called off: asking to ' +
          'leave and adding collateral in the same breath is contradictory, so the registry clears the ' +
          'request. provider_status reports what is posted now.'),

    requestWithdrawal: (amount) =>
      send({ provider, action: 'request-withdrawal', amount: amount.toString() }, 'provider_request_withdrawal',
        'The delay has started. The collateral stays posted and stays slashable until it ' +
          'leaves. provider_status reports when it matures, and provider_execute_withdrawal takes it ' +
          'after that.'),

    executeWithdrawal: () =>
      send({ provider, action: 'execute-withdrawal' }, 'provider_execute_withdrawal',
        'The collateral has been paid out. If that took the stake under the registry floor this ' +
          'provider is no longer reading as available, and provider_add_stake followed by ' +
          'provider_reactivate is how it comes back.'),

    cancelWithdrawal: () =>
      send({ provider, action: 'cancel-withdrawal' }, 'provider_cancel_withdrawal',
        'The request is cleared and the collateral stays where it was. Nothing moved.'),

    deactivate: () =>
      send({ provider, action: 'deactivate' }, 'provider_deactivate',
        'This provider no longer reads as available, so the escrow refuses new payments for it. Work ' +
          'already paid for is unaffected and still has to be delivered. The collateral is still ' +
          'posted and still slashable: this is a closed sign, not an exit.'),

    reactivate: () =>
      send({ provider, action: 'reactivate' }, 'provider_reactivate',
        'This provider reads as available again and the escrow will hold new payments for it.'),
  };
}

function statusNote(state: {
  registered: boolean;
  listed: boolean;
  blacklisted: boolean;
  stake: bigint;
  minStake: bigint;
  maxSlash: bigint;
  withdrawal: PendingWithdrawalView | null;
}): string {
  if (state.blacklisted) {
    return (
      'This address is barred from the registry, so nothing it stakes reads as available and no ' +
      "mandate can pay it. Only the registry's admin lifts a bar."
    );
  }

  if (!state.registered) {
    return (
      'This address is not listed, so the escrow will not hold a payment for it. provider_register ' +
      `takes a name and at least ${moneyFromUint(state.minStake).usdg} USDG of collateral, approved to ` +
      'the registry first. The collateral is at risk: governance can take part of it from a provider ' +
      'that failed its counterparties.'
    );
  }

  if (state.withdrawal) {
    return state.withdrawal.matured
      ? `${state.withdrawal.amount.usdg} USDG is ready to withdraw. provider_execute_withdrawal takes ` +
          'it; provider_add_stake or provider_cancel_withdrawal calls it off.'
      : `${state.withdrawal.amount.usdg} USDG is on its way out and matures at ` +
          `${state.withdrawal.maturesAt}. It stays slashable until it leaves.`;
  }

  if (!state.listed) {
    return (
      'This provider is deactivated, so the escrow takes no new payments for it. The collateral is ' +
      'still posted and still slashable. provider_reactivate puts it back on.'
    );
  }

  if (state.stake < state.minStake) {
    return (
      `The collateral behind this provider is ${moneyFromUint(state.stake).usdg} USDG against a floor ` +
      `of ${moneyFromUint(state.minStake).usdg}, so it does not read as available. provider_add_stake ` +
      'covers the difference.'
    );
  }

  return (
    `Listed and available, with ${moneyFromUint(state.stake).usdg} USDG of collateral posted and up to ` +
    `${moneyFromUint(state.maxSlash).usdg} USDG of it at risk in any single slash, which governance ` +
    'makes on a timelocked proposal. A dispute ruling never reaches the collateral.'
  );
}

function reputationNote(settled: bigint, score: number, cap: bigint, maxCap: bigint): string {
  if (settled === 0n) {
    return (
      'No jobs have settled for this provider yet, so the escrow will hold at most ' +
      `${moneyFromUint(cap).usdg} USDG in a single payment for it. That ceiling rises with jobs ` +
      'delivered and falls with jobs that time out or are contested.'
    );
  }

  return (
    `${score} of every 100 settled jobs were delivered and paid, across ${settled.toString()} of them. ` +
    `The escrow will hold at most ${moneyFromUint(cap).usdg} USDG in a single payment for this ` +
    `provider right now, against a ceiling of ${moneyFromUint(maxCap).usdg}. A delivery only counts ` +
    'once it is finalized, which happens after the window to contest it closes, so a provider that ' +
    'never finalizes holds its own ceiling down.'
  );
}
