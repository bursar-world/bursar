/**
 * The provider's side of the system: getting listed, staying listed, and leaving.
 *
 * A provider puts up collateral in the settlement asset and the registry publishes it. A principal
 * reads that figure before it allowlists anyone, and a ruling against a bad job is what can take
 * it, so the stake is the number a counterparty is really trusting. Exit runs through a delay for
 * exactly that reason: collateral that could leave between a bad job and the ruling on it would
 * not be collateral.
 *
 * Separately, the escrow keeps a settlement history and turns it into a ceiling on the next job
 * this provider can be paid for. Stake buys a listing; history buys size.
 */

import { encodeFunctionData, getContract } from 'viem';
import type { Address, Chain, GetContractReturnType, Hex, PublicClient, Transport } from 'viem';
import { agentRegistryAbi, escrowAbi, micro, reputationAbi } from '@bursar/core';
import type { Micro } from '@bursar/core';

import { connectFor, requireSigner, type Connection, type ConnectOptions } from './connection.js';
import { CallRefusedError, InvalidArgumentError } from './errors.js';
import { formatDuration, toDate, usd } from './format.js';
import { checkAddress, checkPositiveAmount } from './guards.js';
import { providerRefusal } from './refusals.js';
import { sendCall, type ExplainRevert, type Sent } from './send.js';

const NAME_PATTERN = /^[A-Za-z0-9_]{3,32}$/u;

/** A withdrawal already asked for. One at a time, and topping the stake up cancels it. */
export type PendingWithdrawal = {
  readonly amount: Micro;
  readonly requestedAt: Date;
  readonly maturesAt: Date;
};

export type ProviderStatus = {
  readonly provider: Address;
  readonly registered: boolean;
  /** Registered, live, funded to the floor and not barred. The one question a principal asks. */
  readonly active: boolean;
  readonly blacklisted: boolean;
  readonly name: string;
  readonly stake: Micro;
  /** The floor an active provider has to stay at or above. Governance can raise it. */
  readonly minStake: Micro;
  /** The most a single ruling could take from this stake right now. */
  readonly maxSlash: Micro;
  readonly registeredAt: Date | null;
  readonly withdrawal: PendingWithdrawal | null;
  /** Seconds between asking to withdraw and being able to take it. */
  readonly withdrawalDelay: bigint;
  /** True while the registry admits nothing new. A matured withdrawal is unaffected. */
  readonly registryPaused: boolean;
  readonly next: string;
};

/** Settlement history, and the per-job ceiling the escrow derives from it. */
export type ProviderReputation = {
  readonly provider: Address;
  /** Percentage of settled jobs that were released to this provider. Zero until the first settles. */
  readonly score: number;
  /** Counts as the contract holds them, in uint64. */
  readonly released: bigint;
  readonly timedOut: bigint;
  readonly disputed: bigint;
  readonly settled: bigint;
  /** The largest single lock the escrow will open for this provider right now. */
  readonly cap: Micro;
  /** The ceiling the curve tends to. A provider with a perfect record is still held to it. */
  readonly maxCap: Micro;
  readonly next: string;
};

type RegistryContract = GetContractReturnType<
  typeof agentRegistryAbi,
  PublicClient<Transport, Chain>,
  Address
>;

export class ProviderClient {
  /** The `AgentRegistry` this provider is listed in. */
  readonly address: Address;
  readonly connection: Connection;
  /** The asset a stake is posted in. USDG at six decimals, the same asset jobs settle in. */
  readonly stakeAsset: Address;
  /** The contract that keeps the settlement history and publishes the per-job ceiling. */
  readonly reputation: Address;

  readonly #registry: RegistryContract;

  constructor(init: {
    address: Address;
    connection: Connection;
    stakeAsset: Address;
    reputation: Address;
  }) {
    this.address = init.address;
    this.connection = init.connection;
    this.stakeAsset = init.stakeAsset;
    this.reputation = init.reputation;
    this.#registry = getContract({
      address: init.address,
      abi: agentRegistryAbi,
      client: init.connection.publicClient,
    });
  }

  /** The address this client acts as. Reads take an address; writes are this one. */
  get provider(): Address {
    return requireSigner(this.connection, 'provider').account.address;
  }

  /** Everything the registry holds against one provider, in one pass. */
  async status(who?: Address): Promise<ProviderStatus> {
    const provider = who === undefined ? this.provider : checkAddress('provider', who);
    const read = this.#registry.read;

    const [agent, registered, active, blacklisted, minStake, maxSlash, pending, delay, paused] =
      await Promise.all([
        read.getAgent([provider]),
        read.isRegistered([provider]),
        read.isActive([provider]),
        read.isBlacklisted([provider]),
        read.minStake(),
        read.maxSlash([provider]),
        read.withdrawals([provider]),
        read.WITHDRAWAL_DELAY(),
        read.paused(),
      ]);

    const [pendingAmount, requestedAt] = pending;
    const withdrawal: PendingWithdrawal | null =
      pendingAmount === 0n
        ? null
        : {
            amount: micro(pendingAmount),
            requestedAt: toDate(requestedAt),
            maturesAt: toDate(requestedAt + delay),
          };

    const status: ProviderStatus = {
      provider,
      registered,
      active,
      blacklisted,
      name: agent.name,
      stake: micro(agent.stake),
      minStake: micro(minStake),
      maxSlash: micro(maxSlash),
      registeredAt: agent.registeredAt === 0n ? null : toDate(agent.registeredAt),
      withdrawal,
      withdrawalDelay: delay,
      registryPaused: paused,
      next: '',
    };

    return { ...status, next: providerNote(status, agent.active) };
  }

  /** Settlement history and the ceiling it earns. Public: anyone can read it about anyone. */
  async reputationOf(who?: Address): Promise<ProviderReputation> {
    const provider = who === undefined ? this.provider : checkAddress('provider', who);
    const contract = getContract({
      address: this.reputation,
      abi: reputationAbi,
      client: this.connection.publicClient,
    });

    const [stats, score, cap, curve] = await Promise.all([
      contract.read.payeeStats([provider]),
      contract.read.score([provider]),
      contract.read.capOf([provider]),
      contract.read.curve(),
    ]);

    const [released, timedOut, disputed] = stats;
    const settled = released + timedOut + disputed;

    return {
      provider,
      score,
      released,
      timedOut,
      disputed,
      settled,
      cap: micro(cap),
      maxCap: micro(curve.maxCap),
      next: reputationNote(settled, score, micro(cap), micro(curve.maxCap)),
    };
  }

  /**
   * Joins the registry with a stake pulled from the signer, which has to have approved the
   * registry for it first. The name is a display handle: it is not unique and nothing resolves it.
   */
  async register(args: { name: string; stake: Micro }): Promise<Sent> {
    return this.#send(
      'register',
      encodeFunctionData({
        abi: agentRegistryAbi,
        functionName: 'register',
        args: [checkName(args.name), checkPositiveAmount('stake', args.stake)],
      }),
    );
  }

  /** Adds collateral. It also cancels a withdrawal already asked for, which the registry does itself. */
  async addStake(amount: Micro): Promise<Sent> {
    return this.#send(
      'addStake',
      encodeFunctionData({
        abi: agentRegistryAbi,
        functionName: 'addStake',
        args: [checkPositiveAmount('amount', amount)],
      }),
    );
  }

  /**
   * Starts an exit; `executeWithdrawal` finishes it after the delay and `cancelWithdrawal` calls it
   * off. An active provider has to leave the floor behind; deactivate to take it all.
   */
  async requestWithdrawal(amount: Micro): Promise<Sent> {
    return this.#send(
      'requestWithdrawal',
      encodeFunctionData({
        abi: agentRegistryAbi,
        functionName: 'requestWithdrawal',
        args: [checkPositiveAmount('amount', amount)],
      }),
    );
  }

  /** Finishes the exit. Open even while the registry is paused: matured collateral is the provider's. */
  async executeWithdrawal(): Promise<Sent> {
    return this.#send(
      'executeWithdrawal',
      encodeFunctionData({ abi: agentRegistryAbi, functionName: 'executeWithdrawal' }),
    );
  }

  /** Calls the exit off. Clears the request and leaves the collateral where it is. */
  async cancelWithdrawal(): Promise<Sent> {
    return this.#send(
      'cancelWithdrawal',
      encodeFunctionData({ abi: agentRegistryAbi, functionName: 'cancelWithdrawal' }),
    );
  }

  /**
   * Stops this provider reading as available, so the escrow refuses new locks for it. The stake
   * stays put and stays slashable: this is a closed sign, not an exit.
   */
  async deactivate(): Promise<Sent> {
    return this.#send(
      'deactivate',
      encodeFunctionData({ abi: agentRegistryAbi, functionName: 'deactivate' }),
    );
  }

  /** Puts it back on, if the stake still clears the floor and no bar stands against the address. */
  async reactivate(): Promise<Sent> {
    return this.#send(
      'reactivate',
      encodeFunctionData({ abi: agentRegistryAbi, functionName: 'reactivate' }),
    );
  }

  #send(action: string, data: Hex): Promise<Sent> {
    return sendCall(this.connection, { to: this.address, data, action, explain: this.#explain(action) });
  }

  #explain(action: string): ExplainRevert {
    return async (revert) => {
      if (!revert) return undefined;

      // The registry raises one error for three different shortfalls, and which one it is decides
      // what the provider does next: add collateral, take out less, or deactivate first.
      if (revert.errorName === 'InsufficientStake') {
        const [stake, floor] = await Promise.all([
          this.#registry.read.stakeOf([this.provider]),
          this.#registry.read.minStake(),
        ]);

        return new CallRefusedError(
          revert.errorName,
          action === 'register'
            ? `Registering takes at least ${usd(micro(floor))} of collateral and this offered less. ` +
                'Nothing was staked.'
            : `This provider holds ${usd(micro(stake))} of collateral and has to keep at least ` +
                `${usd(micro(floor))} of it while it is active. Take out less, or deactivate first and ` +
                'then withdraw the lot. Nothing was withdrawn.',
          { registry: this.address, stake: stake.toString(), minStake: floor.toString() },
        );
      }

      if (revert.errorName === 'WithdrawalNotMatured') {
        const [pending, delay] = await Promise.all([
          this.#registry.read.withdrawals([this.provider]),
          this.#registry.read.WITHDRAWAL_DELAY(),
        ]);

        return new CallRefusedError(
          revert.errorName,
          `This withdrawal matures at ${toDate(pending[1] + delay).toISOString()}. The ` +
            `${formatDuration(delay)} delay keeps collateral slashable across the gap between a bad ` +
            'job and the ruling on it, so it cannot be shortened. Nothing was withdrawn.',
          { registry: this.address, maturesAt: (pending[1] + delay).toString() },
        );
      }

      const refusal = providerRefusal(revert.errorName);

      return refusal === null
        ? undefined
        : new CallRefusedError(refusal.code, refusal.message, { registry: this.address, owner: refusal.owner });
    };
  }
}

function checkName(name: string): string {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new InvalidArgumentError(
      'name',
      'A provider name is 3 to 32 characters of letters, digits and underscore. The registry refuses ' +
        'anything else rather than rendering it, because a handle carrying invisible characters can be ' +
        "read as another provider's.",
      { name: String(name) },
    );
  }

  return name;
}

function providerNote(status: ProviderStatus, listed: boolean): string {
  if (status.blacklisted) {
    return (
      'This address is barred from the registry, so nothing it stakes reads as available and no ' +
      "mandate can pay it. Only the registry's admin lifts a bar."
    );
  }

  if (!status.registered) {
    return (
      `This address is not listed, so the escrow refuses a lock for it. Registering takes a name and ` +
      `at least ${usd(status.minStake)} of collateral approved to the registry. The collateral is at ` +
      'risk: a ruling against a job can take part of it.'
    );
  }

  if (status.withdrawal) {
    const matured = status.withdrawal.maturesAt.getTime() <= Date.now();

    return matured
      ? `${usd(status.withdrawal.amount)} is ready to withdraw. executeWithdrawal takes it; ` +
          'addStake or cancelWithdrawal calls it off.'
      : `${usd(status.withdrawal.amount)} is on its way out and matures at ` +
          `${status.withdrawal.maturesAt.toISOString()}. It stays slashable until it leaves.`;
  }

  if (!listed) {
    return (
      'This provider is deactivated, so the escrow takes no new locks for it. The collateral is ' +
      'still posted and still slashable. reactivate puts it back on.'
    );
  }

  if (status.stake < status.minStake) {
    return (
      `The collateral behind this provider is ${usd(status.stake)} against a floor of ` +
      `${usd(status.minStake)}, so it does not read as available. addStake covers the difference.`
    );
  }

  return (
    `Listed and available, with ${usd(status.stake)} of collateral posted and up to ` +
    `${usd(status.maxSlash)} of it at risk in any single ruling.`
  );
}

function reputationNote(settled: bigint, score: number, cap: Micro, maxCap: Micro): string {
  if (settled === 0n) {
    return (
      `No jobs have settled for this provider yet, so the escrow will open a lock of at most ` +
      `${usd(cap)}. The ceiling rises with released jobs and falls with jobs that time out or are ` +
      'disputed.'
    );
  }

  return (
    `${score} of every 100 settled jobs were released to this provider, across ${settled} of them. ` +
    `The escrow will open a lock of at most ${usd(cap)} for it right now, against a ceiling of ` +
    `${usd(maxCap)}. Finalizing a release is what records it, so a provider that never finalizes ` +
    'holds its own ceiling down.'
  );
}

/** Opens a provider client against the registry this deployment's escrow reads. */
export async function provider(options: Connection | ConnectOptions = {}): Promise<ProviderClient> {
  const connection = connectFor(options, 'provider()');
  const escrow = getContract({
    address: connection.addresses.escrow,
    abi: escrowAbi,
    client: connection.publicClient,
  }).read;

  const [address, reputation] = await Promise.all([escrow.registry(), escrow.reputation()]);

  if (/^0x0+$/u.test(address)) {
    throw new CallRefusedError(
      'NotRegistered',
      `Escrow ${connection.addresses.escrow} has no provider registry wired to it, so it admits any ` +
        'payee and there is nothing to register with.',
      { escrow: connection.addresses.escrow },
    );
  }

  const stakeAsset = await getContract({
    address,
    abi: agentRegistryAbi,
    client: connection.publicClient,
  }).read.settlementAsset();

  return new ProviderClient({ address, connection, stakeAsset, reputation });
}
