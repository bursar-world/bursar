import { encodeFunctionData, getContract, isAddressEqual, parseEventLogs } from 'viem';
import type { Address, Hex } from 'viem';
import { mandateAccountFactoryAbi } from '@bursar/core';

import { openConnection, requireSigner, type Connection, type ConnectOptions } from './connection.js';
import { CallRefusedError, InvalidArgumentError } from './errors.js';
import { checkAddress, checkBytes32 } from './guards.js';
import { encodeLimits, mandateAccount, type MandateAccountClient } from './mandate.js';
import { random32 } from './random.js';
import { logsFrom } from './receipt.js';
import { sendCall } from './send.js';
import type { MandateLimits, MandateLimitsInput } from './types.js';

export type MandateSeed = {
  /** Who owns the mandate: sets the limits, funds it, and can take the funds back. */
  readonly principal: Address;
  /** Who spends inside it. May be the zero address, which leaves the mandate unusable until seated. */
  readonly agent: Address;
  readonly limits: MandateLimitsInput;
  /** Fixes the address the account will deploy at. Random when omitted. */
  readonly salt?: Hex;
};

export type DeployedMandate = {
  readonly address: Address;
  readonly hash: Hex;
  readonly explorer: string;
  readonly salt: Hex;
  readonly limits: MandateLimits;
};

/**
 * Deploys a mandate account at an address a principal can compute before funding it.
 *
 * The limits are part of the constructor, so there is no block in which a funded account is
 * spendable without a bound. They are also part of the init code, which means the address depends
 * on them: the same salt with different limits is a different account.
 */
export async function deployMandate(
  options: Connection | ConnectOptions,
  seed: MandateSeed,
): Promise<DeployedMandate> {
  const connection = await openConnection(options, 'deployMandate()');
  const factory = connection.addresses.mandateAccountFactory;
  const { principal, agent, salt } = checkSeed(seed);
  const limits = encodeLimits(seed.limits);

  // The factory refuses anyone but the principal with NotPrincipal. Said here, it costs no gas.
  const { account } = requireSigner(connection, 'deployMandate');
  if (!isAddressEqual(account.address, principal)) {
    throw new InvalidArgumentError(
      'principal',
      `A mandate has to be created by its principal. This connection signs as ${account.address} ` +
        `and the seed names ${principal} as principal.`,
      { principal, sender: account.address },
    );
  }

  const sent = await sendCall(connection, {
    to: factory,
    data: encodeFunctionData({
      abi: mandateAccountFactoryAbi,
      functionName: 'create',
      args: [principal, agent, salt, limits],
    }),
    action: 'create',
    explain: async (revert) =>
      revert?.errorName === 'NotPrincipal'
        ? new CallRefusedError(
            revert.errorName,
            'The factory creates a mandate only when its principal sends the transaction.',
            { factory, principal },
          )
        : revert?.errorName === 'AlreadyDeployed'
        ? new CallRefusedError(
            revert.errorName,
            'A mandate already exists at this address. The salt, the principal, the agent and the ' +
              'limits together fix it, so change one of them or use the account that is there.',
            { factory, salt },
          )
        : undefined,
  });

  const [created] = parseEventLogs({
    abi: mandateAccountFactoryAbi,
    eventName: 'Created',
    logs: logsFrom(sent.receipt.logs, factory),
  });

  // A node that prunes logs from a receipt still deployed the account, and the address it chose
  // is derivable from the same inputs the factory used.
  const address =
    created?.args.account ?? (await predictMandate(connection, { ...seed, salt }));

  return { address, hash: sent.hash, explorer: sent.explorer, salt, limits };
}

/** The address a seed will produce, readable before the account exists. */
export async function predictMandate(
  options: Connection | ConnectOptions,
  seed: MandateSeed & { salt: Hex },
): Promise<Address> {
  const connection = await openConnection(options, 'predictMandate()');
  const { principal, agent, salt } = checkSeed(seed);

  return connection.publicClient.readContract({
    address: connection.addresses.mandateAccountFactory,
    abi: mandateAccountFactoryAbi,
    functionName: 'predict',
    args: [principal, agent, salt, encodeLimits(seed.limits)],
  });
}

/**
 * The salt, the principal and the agent, checked before any of them reaches the init code.
 *
 * Those three and the limits all go into the init code, so a wrong one
 * does not fail: it deploys a different account, at a different address, that the principal is
 * about to fund.
 */
function checkSeed(seed: MandateSeed): { principal: Address; agent: Address; salt: Hex } {
  return {
    principal: checkAddress('principal', seed.principal),
    // The zero address is a mandate nobody can spend through yet, which is a normal way to open one.
    agent: checkAddress('agent', seed.agent),
    salt: seed.salt === undefined ? random32() : checkBytes32('salt', seed.salt),
  };
}

/** Every mandate this factory has deployed for a principal, oldest first. */
export async function mandatesOf(
  options: Connection | ConnectOptions,
  principal: Address,
): Promise<readonly Address[]> {
  const connection = await openConnection(options, 'mandatesOf()');

  return getContract({
    address: connection.addresses.mandateAccountFactory,
    abi: mandateAccountFactoryAbi,
    client: connection.publicClient,
  }).read.accountsOf([checkAddress('principal', principal)]);
}

/** Deploys a mandate and opens a client for it in one call. */
export async function createMandate(
  options: Connection | ConnectOptions,
  seed: MandateSeed,
): Promise<MandateAccountClient> {
  const connection = await openConnection(options, 'createMandate()');
  const deployed = await deployMandate(connection, seed);

  return mandateAccount(deployed.address, connection);
}
