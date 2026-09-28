import { formatEther } from 'viem';
import type { Address } from 'viem';

import type { Logger } from './log.js';

export type BalanceReader = {
  getBalance(args: { address: Address }): Promise<bigint>;
};

/**
 * The payee's fee budget, in wei of ETH.
 *
 * Gas is ETH and settlement is USDG, so this number and the amounts the sidecar earns are
 * different assets. It is deliberately not a `Micro`: that type is six-decimal micro-USD, and
 * letting eighteen decimals of another asset into it is how a fee budget ends up added to a
 * balance, compared against a cap, or reported as money the payee can spend.
 */
export async function readGasBalance(client: BalanceReader, address: Address): Promise<bigint> {
  return client.getBalance({ address });
}

export type GasMonitorOptions = {
  readonly address: Address;
  /** Wei of ETH. The payee pays fees in ETH whatever it earns in. */
  readonly read: () => Promise<bigint>;
  readonly minimum: bigint;
  /** Gas does not drain in seconds, and this call costs an RPC round trip on every poll. */
  readonly intervalMs: number;
  readonly logger: Logger;
  readonly now?: () => number;
};

export type GasMonitor = {
  check(): Promise<void>;
};

/**
 * Warns while the payee's fee budget sits under the floor the operator set.
 *
 * A sidecar out of ETH stops releasing and keeps watching, which looks like a quiet day rather
 * than a fault, so the only way an operator finds out is if something says so. The payee's USDG
 * balance says nothing about this: it can be earning steadily and still be unable to release.
 */
export function createGasMonitor(options: GasMonitorOptions): GasMonitor {
  const now = options.now ?? (() => Date.now());
  let nextCheck = 0;
  let wasLow = false;

  return {
    check: async () => {
      const at = now();
      if (at < nextCheck) return;
      nextCheck = at + options.intervalMs;

      const balance = await options.read();
      const fields = {
        address: options.address,
        balance: `${formatEther(balance)} ETH`,
        minimum: `${formatEther(options.minimum)} ETH`,
      };

      const low = balance < options.minimum;
      if (low) {
        options.logger.warn('gas_low', fields);
      } else if (wasLow) {
        // A healthy balance is the normal case and saying so on a timer would bury the warning
        // that matters. Crossing back over is worth one line.
        options.logger.info('gas_refilled', fields);
      }

      wasLow = low;
    },
  };
}
