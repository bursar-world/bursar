import { encodeFunctionData, isAddressEqual, parseEventLogs, zeroAddress } from 'viem';
import type { Address } from 'viem';
import { BursarError, endowmentAbi, endowmentFactoryAbi, endowmentsDeployment, micro } from '@bursar/core';
import type { EndowmentsDeployment, Micro } from '@bursar/core';

import { approveIfShort } from './allowance.js';
import { openConnection, type Connection, type ConnectOptions } from './connection.js';
import { CallRefusedError, InvalidArgumentError, MissingEventError } from './errors.js';
import { checkAddress, checkPositiveAmount } from './guards.js';
import { logsFrom } from './receipt.js';
import type { RevertInfo } from './revert.js';
import { sendCall, type ExplainRevert, type Sent } from './send.js';
import { UnknownAssetError, laneOf } from './rwa.js';

const BPS = 10_000;
export const DEFAULT_DRAW_BPS = 400;
export const DEFAULT_EARN_SHARE_BPS = 5_000;

/** One holding of an endowment's principal, by token address or by the symbol the lane records. */
export type EndowmentHolding = {
  readonly asset: Address | string;
  readonly weightBps: number;
};

export type EndowmentTerms = {
  /** The agent's id on the ERC-8004 identity registry. */
  readonly agentId: bigint;
  /** Who the endowment passes to if the agent goes quiet. None by default. */
  readonly successorId?: bigint;
  /** Weights in basis points, summing to 10,000. One stock at full weight when left out: SPY. */
  readonly holdings?: readonly EndowmentHolding[];
  /** The yearly draw on the average valuation, in basis points. 400 by default. */
  readonly drawBps?: number;
  /** The share of the agent's earnings that joins the principal, in basis points. 5,000 by default. */
  readonly earnShareBps?: number;
};

export type EndowmentState = {
  readonly address: Address;
  readonly agentId: bigint;
  readonly successorId: bigint;
  /** Where the draw is paid. Undefined until the agent's owner accepts. */
  readonly mandate: Address | undefined;
  readonly accepted: boolean;
  readonly frozen: boolean;
  /** Everything held at the feeds. */
  readonly nav: Micro;
  /** Every price behind `nav` was inside its valuation bound. */
  readonly navFresh: boolean;
  /** The average of up to twelve quarterly valuations, which the draw is a share of. */
  readonly averageNav: Micro;
  readonly drawPerYear: Micro;
  /** What a draw would pay now, before the protocol's share. */
  readonly accrued: Micro;
  readonly cash: Micro;
  readonly sleeveTarget: Micro;
  readonly given: Micro;
  readonly unattributed: Micro;
  readonly earned: Micro;
  readonly earnedToPrincipal: Micro;
  readonly drawn: Micro;
  readonly fees: Micro;
  readonly patrons: number;
  readonly snapshotsTaken: number;
  readonly createdAt: Date;
  readonly lastDrawAt: Date | undefined;
  readonly lastActive: Date | undefined;
  readonly unacceptedSince: Date;
};

export type DrawReceipt = Sent & {
  /** What reached the mandate. */
  readonly amount: Micro;
  /** The protocol's share of the draw. */
  readonly fee: Micro;
};

export class EndowmentsUnavailableError extends BursarError {
  constructor(network: string, chainId: number) {
    super(
      'endowments_unavailable',
      `Deployment ${network} on chain ${chainId} records no endowment factory. ` +
        'Connect with a record that has an endowments section, or pass the factory address yourself.',
      { network, chainId },
    );
  }
}

/** What each of the endowment's refusals means for the caller, and what clears it. */
const REFUSALS: Readonly<Record<string, string>> = {
  NotOwner: 'Only the owner of the agent on the ERC-8004 identity registry can accept this endowment or change its mandate.',
  NotDrawer: 'Only the agent owner or the mandate’s agent can draw.',
  NotSettlor: 'Only whoever started this endowment can name its successor.',
  NotGuardian: 'Only the protocol guardian can pause or restart a draw.',
  NotAccepted: 'The agent’s owner has not accepted this endowment yet, so nothing accrues.',
  AlreadyAccepted: 'This endowment is already accepted.',
  IsFrozen: 'The draw is paused. Nothing accrues until it restarts.',
  NotSettlementAsset: 'That mandate settles in another asset. The draw is paid in USDG.',
  NothingToDraw: 'Nothing has accrued since the last draw, or the cash sleeve is empty. Try again after a refill.',
  NothingToInvest: 'The cash above the sleeve is under a dollar, so there is nothing to buy.',
  SleeveFull: 'The cash sleeve is above half its target, so there is nothing to sell.',
  NothingToSell: 'The endowment holds no stock to sell.',
  StaleValuation: 'A price behind the valuation is outside its bound. Try again when the feed answers.',
  TooSoon: 'The last valuation is under a quarter old.',
  StillActive: 'The agent has drawn in the last 180 days.',
  RefundsClosed: 'Refunds open only after 180 days without an accepting owner.',
  NothingGiven: 'This address has nothing to take back.',
  ZeroAmount: 'The amount has to be above zero.',
};

function explain(contract: Address): ExplainRevert {
  return async (revert: RevertInfo | undefined) => {
    if (revert === undefined) return undefined;
    const message = REFUSALS[revert.errorName];
    if (message === undefined) return undefined;
    return new CallRefusedError(revert.errorName, message, { endowment: contract, args: revert.args.map(String) });
  };
}

function date(seconds: bigint): Date | undefined {
  return seconds === 0n ? undefined : new Date(Number(seconds) * 1000);
}

/** One endowment: its standing, its patrons' side and its agent's side. */
export class EndowmentClient {
  readonly address: Address;
  readonly connection: Connection;

  constructor(connection: Connection, address: Address) {
    this.connection = connection;
    this.address = checkAddress('endowment', address);
  }

  get #client() {
    return this.connection.publicClient;
  }

  async state(): Promise<EndowmentState> {
    const s = await this.#client.readContract({ address: this.address, abi: endowmentAbi, functionName: 'state' });
    return {
      address: this.address,
      agentId: s.agentId,
      successorId: s.successorId,
      mandate: s.mandate === zeroAddress ? undefined : s.mandate,
      accepted: s.accepted,
      frozen: s.frozen,
      nav: micro(s.nav),
      navFresh: s.navFresh,
      averageNav: micro(s.averageNav),
      drawPerYear: micro(s.drawPerYear),
      accrued: micro(s.accrued),
      cash: micro(s.cash),
      sleeveTarget: micro(s.sleeveTarget),
      given: micro(s.given),
      unattributed: micro(s.unattributed),
      earned: micro(s.earned),
      earnedToPrincipal: micro(s.earnedToPrincipal),
      drawn: micro(s.drawn),
      fees: micro(s.fees),
      patrons: Number(s.patrons),
      snapshotsTaken: Number(s.snapshotsTaken),
      createdAt: new Date(Number(s.createdAt) * 1000),
      lastDrawAt: date(BigInt(s.lastDrawAt)),
      lastActive: date(BigInt(s.lastActive)),
      unacceptedSince: new Date(Number(s.unacceptedSince) * 1000),
    };
  }

  /** The stocks the principal is held in, with their target weights. */
  async assets(): Promise<{ asset: Address; weightBps: number }[]> {
    const [assets, weights] = await this.#client.readContract({
      address: this.address,
      abi: endowmentAbi,
      functionName: 'assets',
    });
    return assets.map((asset, i) => ({ asset, weightBps: weights[i] ?? 0 }));
  }

  /** Adds `amount` USDG from the signer to the principal. The first gift of a dollar or more mints a patron mark. */
  async give(amount: Micro): Promise<{ approve?: Sent; give: Sent }> {
    const value = checkPositiveAmount('amount', amount);
    const approve = await approveIfShort(this.connection, {
      token: this.connection.deployment.settlementAsset,
      spender: this.address,
      amount: value,
      action: 'give',
    });
    const give = await this.#send('give', encodeFunctionData({ abi: endowmentAbi, functionName: 'give', args: [value] }));
    return { ...(approve ? { approve } : {}), give };
  }

  /** Pays what the agent earned in; part joins the principal and the rest goes to the agent's mandate. */
  async earn(amount: Micro): Promise<{ approve?: Sent; earn: Sent }> {
    const value = checkPositiveAmount('amount', amount);
    const approve = await approveIfShort(this.connection, {
      token: this.connection.deployment.settlementAsset,
      spender: this.address,
      amount: value,
      action: 'earn',
    });
    const earn = await this.#send('earn', encodeFunctionData({ abi: endowmentAbi, functionName: 'earn', args: [value] }));
    return { ...(approve ? { approve } : {}), earn };
  }

  /** Agent owner only. Starts the draw into `mandate`, which has to settle in USDG. */
  async accept(mandate: Address): Promise<Sent> {
    return this.#send(
      'accept',
      encodeFunctionData({ abi: endowmentAbi, functionName: 'accept', args: [checkAddress('mandate', mandate)] }),
    );
  }

  /** Agent owner only. Points the draw at another mandate. */
  async setMandate(mandate: Address): Promise<Sent> {
    return this.#send(
      'setMandate',
      encodeFunctionData({ abi: endowmentAbi, functionName: 'setMandate', args: [checkAddress('mandate', mandate)] }),
    );
  }

  /** The agent owner or the mandate's agent. Pays what has accrued into the mandate. */
  async draw(): Promise<DrawReceipt> {
    const sent = await this.#send('draw', encodeFunctionData({ abi: endowmentAbi, functionName: 'draw' }));
    const [drawn] = parseEventLogs({
      abi: endowmentAbi,
      eventName: 'Drawn',
      logs: logsFrom(sent.receipt.logs, this.address),
    });
    if (drawn === undefined) throw new MissingEventError('Drawn', this.address, sent.hash);
    return { ...sent, amount: micro(drawn.args.amount), fee: micro(drawn.args.fee) };
  }

  /** Anyone. Buys stock with the cash above the sleeve, one trade's worth. */
  async invest(): Promise<Sent> {
    return this.#send('invest', encodeFunctionData({ abi: endowmentAbi, functionName: 'invest' }));
  }

  /** Anyone. Sells stock back into the sleeve once it is below half its target. */
  async refill(): Promise<Sent> {
    return this.#send('refill', encodeFunctionData({ abi: endowmentAbi, functionName: 'refill' }));
  }

  /** Anyone, once a quarter. Records the valuation the draw averages and sets the next quarter's draw. */
  async snapshot(): Promise<Sent> {
    return this.#send('snapshot', encodeFunctionData({ abi: endowmentAbi, functionName: 'snapshot' }));
  }

  #send(action: string, data: `0x${string}`): Promise<Sent> {
    return sendCall(this.connection, { to: this.address, data, action, explain: explain(this.address) });
  }
}

/** Starts endowments and lists them. */
export class EndowmentFactoryClient {
  readonly address: Address;
  readonly connection: Connection;

  constructor(connection: Connection, address: Address) {
    this.connection = connection;
    this.address = checkAddress('factory', address);
  }

  at(endowment: Address): EndowmentClient {
    return new EndowmentClient(this.connection, endowment);
  }

  async count(): Promise<number> {
    return Number(
      await this.connection.publicClient.readContract({ address: this.address, abi: endowmentFactoryAbi, functionName: 'count' }),
    );
  }

  /** Endowments oldest first, `limit` from `offset`. */
  async list(offset = 0, limit = 100): Promise<Address[]> {
    const total = await this.count();
    const end = Math.min(total, offset + limit);
    const reads: Promise<Address>[] = [];
    for (let i = offset; i < end; i++) {
      reads.push(
        this.connection.publicClient.readContract({
          address: this.address,
          abi: endowmentFactoryAbi,
          functionName: 'all',
          args: [BigInt(i)],
        }),
      );
    }
    return Promise.all(reads);
  }

  async endowmentsOf(agentId: bigint): Promise<readonly Address[]> {
    return this.connection.publicClient.readContract({
      address: this.address,
      abi: endowmentFactoryAbi,
      functionName: 'endowmentsOf',
      args: [agentId],
    });
  }

  /**
   * Starts an endowment for an agent and, with a gift, makes the signer its first patron. Approves
   * the factory for the gift first when needed.
   */
  async create(terms: EndowmentTerms, gift: Micro = micro(0n)): Promise<{ approve?: Sent; create: Sent; endowment: Address }> {
    const holdings = terms.holdings ?? [{ asset: 'SPY', weightBps: BPS }];
    if (holdings.length === 0) throw new InvalidArgumentError('holdings', 'An endowment holds at least one stock.');
    const sum = holdings.reduce((total, h) => total + h.weightBps, 0);
    if (sum !== BPS) {
      throw new InvalidArgumentError('holdings', `Weights have to sum to 10,000 basis points, received ${sum}.`);
    }
    const assets = holdings.map((h) => this.#resolve(h.asset));
    const approve =
      gift > 0n
        ? await approveIfShort(this.connection, {
            token: this.connection.deployment.settlementAsset,
            spender: this.address,
            amount: gift,
            action: 'create',
          })
        : undefined;
    const create = await sendCall(this.connection, {
      to: this.address,
      data: encodeFunctionData({
        abi: endowmentFactoryAbi,
        functionName: 'create',
        args: [
          {
            agentId: terms.agentId,
            successorId: terms.successorId ?? 0n,
            assets,
            weightsBps: holdings.map((h) => h.weightBps),
            drawBps: terms.drawBps ?? DEFAULT_DRAW_BPS,
            earnShareBps: terms.earnShareBps ?? DEFAULT_EARN_SHARE_BPS,
          },
          gift,
        ],
      }),
      action: 'create',
      explain: explain(this.address),
    });
    const [created] = parseEventLogs({
      abi: endowmentFactoryAbi,
      eventName: 'Created',
      logs: logsFrom(create.receipt.logs, this.address),
    });
    if (created === undefined) throw new MissingEventError('Created', this.address, create.hash);
    return { ...(approve ? { approve } : {}), create, endowment: created.args.endowment };
  }

  #resolve(asset: Address | string): Address {
    if (asset.startsWith('0x')) return checkAddress('asset', asset as Address);
    const lane = laneOf(this.connection);
    const recorded = lane?.assets.find((a) => a.symbol.toLowerCase() === asset.toLowerCase());
    if (recorded === undefined) throw new UnknownAssetError(asset, lane?.assets.map((a) => a.symbol) ?? []);
    return recorded.address;
  }
}

function factoryOf(connection: Connection): EndowmentsDeployment {
  const record = connection.deployment;
  const found = record.endowments ?? endowmentsDeployment(record.chainId);
  if (found === undefined) throw new EndowmentsUnavailableError(record.network, record.chainId);
  return found;
}

/** The endowment factory the connection's record names, or the one at `at`. */
export async function endowments(options: Connection | ConnectOptions = {}, at?: Address): Promise<EndowmentFactoryClient> {
  const connection = await openConnection(options, 'endowments()');
  return new EndowmentFactoryClient(connection, at ?? factoryOf(connection).EndowmentFactory);
}

/** One endowment by address. */
export async function endowment(at: Address, options: Connection | ConnectOptions = {}): Promise<EndowmentClient> {
  const connection = await openConnection(options, 'endowment()');
  return new EndowmentClient(connection, at);
}

/** Whether `endowment` pays its draw into `mandate`. */
export function drawsInto(state: Pick<EndowmentState, 'mandate'>, mandate: Address): boolean {
  return state.mandate !== undefined && isAddressEqual(state.mandate, mandate);
}
