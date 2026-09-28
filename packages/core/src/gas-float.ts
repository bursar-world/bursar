import { formatEther, parseEther } from 'viem';
import type { Address } from 'viem';
import { BursarError } from './errors.js';

export type FundingRole = 'gasFloat' | 'settlement' | 'collateral' | 'treasury';

export type FundingAddresses = {
  /** Signs and pays for transactions. Holds ETH for gas, never customer funds. */
  readonly gasFloat: Address;
  /** Receives and forwards customer settlement in USDG. */
  readonly settlement: Address;
  /** Backs the collateralised lane. */
  readonly collateral: Address;
  /** Fee sink. Optional until fee routing is switched on. */
  readonly treasury?: Address;
};

/**
 * Wei of ETH.
 *
 * Branded apart from `Micro` because the two are different assets on Robinhood Chain and no
 * exchange rate lives in this package. A gas balance can be compared with a gas reserve and with
 * a fee estimate; it cannot be added to a payment, netted against a ledger row, or shown in a
 * total next to one.
 */
declare const weiOfEther: unique symbol;
export type Wei = bigint & { readonly [weiOfEther]: true };

export const WEI_PER_ETH = 10n ** 18n;

/** Brands a balance that is already in wei. No conversion happens. */
export function wei(atomic: bigint): Wei {
  return atomic as Wei;
}

/** Parses a decimal ETH string such as "0.004" into wei. */
export function parseEth(decimal: string): Wei {
  const input = decimal.trim();
  if (!/^-?\d+(\.\d{1,18})?$/.test(input)) {
    throw new BursarError(
      'gas_amount_invalid',
      `"${decimal}" is not an ETH amount with at most eighteen decimal places.`,
      { input: decimal },
    );
  }
  return parseEther(input) as Wei;
}

/**
 * Decimal ETH, trailing zeros trimmed. For an operator's screen and for log lines, not for
 * arithmetic: everything that computes stays in wei.
 */
export function formatEth(value: Wei): string {
  return formatEther(value);
}

/**
 * The reserve the build plan holds the relayer to. Release 1 costs about 0.002 ETH of gas end to
 * end at the fees observed on 4663, so a float under this is roughly one release away from empty.
 * A deployment that relays more sets its own.
 */
export const DEFAULT_GAS_FLOAT_MINIMUM_WEI: Wei = parseEther('0.004') as Wei;

export class FundingCollisionError extends BursarError {
  constructor(a: FundingRole, b: FundingRole, address: Address) {
    super(
      'funding_collision',
      `${a} and ${b} are the same address (${address}). The relayer key signs continuously and is ` +
        `hot; the settlement key holds customer funds. One address for both means one compromise ` +
        `takes both, one stuck nonce blocks both, and rotating either forces rotating the other. ` +
        `Give each role its own address.`,
      { roles: [a, b], address },
    );
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Enforced at startup: every declared role gets its own address.
 *
 * The rule outlived the chain it was written for. There it stopped a settlement from spending the
 * gas budget, because gas and working capital were one USDC balance seen at two decimal scales.
 * On Robinhood Chain gas is ETH and settlement is USDG, so that particular collision cannot
 * happen and the rule is kept for the reasons that are true of any chain: key blast radius,
 * nonce contention between a busy relayer and a payout, and being able to rotate one role without
 * standing the others down.
 */
export function assertFundingIsolation(addresses: FundingAddresses): FundingAddresses {
  const declared: [FundingRole, Address][] = [
    ['gasFloat', addresses.gasFloat],
    ['settlement', addresses.settlement],
    ['collateral', addresses.collateral],
  ];
  if (addresses.treasury !== undefined) declared.push(['treasury', addresses.treasury]);

  for (const [role, address] of declared) {
    if (!ADDRESS.test(address)) {
      throw new BursarError('funding_address_invalid', `${role} is not a 20-byte hex address: ${address}`, {
        role,
        address,
      });
    }
  }

  const seen = new Map<string, FundingRole>();
  for (const [role, address] of declared) {
    const key = address.toLowerCase();
    const previous = seen.get(key);
    if (previous) throw new FundingCollisionError(previous, role, address);
    seen.set(key, role);
  }

  return addresses;
}

export type BalanceReader = {
  getBalance(args: { address: Address }): Promise<bigint>;
};

/**
 * Reads the ETH balance of the relayer, in wei, unconverted.
 *
 * Isolation is checked first so this cannot be pointed at an address that is also holding
 * customer funds, which is a thing an operator would then be tempted to read as one number.
 */
export async function readGasFloat(client: BalanceReader, addresses: FundingAddresses): Promise<Wei> {
  assertFundingIsolation(addresses);
  return wei(await client.getBalance({ address: addresses.gasFloat }));
}

export type GasFloatStatus = {
  readonly address: Address;
  readonly balance: Wei;
  readonly minimum: Wei;
  readonly healthy: boolean;
  /** Ready to paste into an alert. */
  readonly summary: string;
};

/**
 * Gas on 4663 is cheap enough that a float looks fine right up to the point it is not: at
 * 0.054 gwei a mandate-governed payment costs a small fraction of a cent, so the balance moves
 * slowly and then the relayer stops, with nothing else looking wrong.
 */
export async function checkGasFloat(
  client: BalanceReader,
  addresses: FundingAddresses,
  minimum: Wei = DEFAULT_GAS_FLOAT_MINIMUM_WEI,
): Promise<GasFloatStatus> {
  const balance = await readGasFloat(client, addresses);
  const healthy = balance >= minimum;
  return {
    address: addresses.gasFloat,
    balance,
    minimum,
    healthy,
    summary: healthy
      ? `Gas float ${addresses.gasFloat} holds ${formatEth(balance)} ETH.`
      : `Gas float ${addresses.gasFloat} is down to ${formatEth(balance)} ETH, below the ${formatEth(minimum)} ETH reserve. Relayed transactions stop when it empties.`,
  };
}
