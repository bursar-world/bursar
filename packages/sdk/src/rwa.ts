import { encodeFunctionData, erc20Abi, isAddressEqual, parseEventLogs } from 'viem';
import type { Address } from 'viem';
import {
  BursarError,
  DEPLOYMENTS,
  assetRegistryAbi,
  isSuperseded,
  mandateAccountAbi,
  parkAdapterAbi,
  parseRwaDeployment,
  priceGuardAbi,
  rawToUsdgMicros,
  rwaDeployment,
  stockSpendRouterAbi,
  treasuryParkAbi,
} from '@bursar/core';
import type { Deployment, Micro, RwaDeployment } from '@bursar/core';

import { requireSigner, type Connection } from './connection.js';
import { CallRefusedError, InsufficientFundsError, MandateDeniedError, denialOf } from './errors.js';
import { usd } from './format.js';
import { checkAddress, checkPositiveAmount } from './guards.js';
import { laneRefusal, type LaneCall, type LaneContext } from './lane-refusals.js';
import { micro } from './money.js';
import { revertFrom } from './revert.js';
import { sendCall, type ExplainRevert, type Sent } from './send.js';
import { WindowKind } from './types.js';
import type { MandateAccountClient } from './mandate.js';

export type RwaAsset = {
  readonly symbol: string;
  readonly address: Address;
  readonly feed: Address;
  readonly kind: 'stock' | 'treasury';
  readonly eligible: boolean;
  readonly decimals: number;
  readonly bandBps: number;
  readonly haircutBps: number;
  /** Seconds. A trade against an older feed answer is refused. */
  readonly tradeStaleness: number;
  /** Seconds. Parked value older than this counts zero. */
  readonly valuationStaleness: number;
  readonly perTradeCap: Micro;
  readonly perMandateCap: Micro;
  readonly totalCap: Micro;
};

export type FeedPrice = {
  /** USD per whole token, eight decimals. */
  readonly priceE8: bigint;
  readonly updatedAt: Date;
  /**
   * Inside the asset's valuation bound, with the token, its oracle and the access registry
   * unpaused and the asset's pinned pool trading inside its band of the feed.
   */
  readonly fresh: boolean;
};

export type BuyReceipt = Sent & {
  readonly asset: Address;
  readonly usdgIn: Micro;
  /** Raw token units delivered to the mandate. */
  readonly amountOut: bigint;
  readonly priceE8: bigint;
};

export type Holding = {
  readonly asset: RwaAsset;
  readonly raw: bigint;
  /** raw × feed price, in USDG. Zero when the price is not fresh. */
  readonly value: Micro;
  readonly price: FeedPrice;
};

export type ParkedPosition = {
  readonly symbol: string;
  readonly adapter: Address;
  readonly raw: bigint;
  /** USDG put in, less the share already unparked. */
  readonly basis: Micro;
  /** raw × feed price. Zero when the price is not fresh. */
  readonly value: Micro;
  readonly priceE8: bigint;
  readonly updatedAt: Date;
  readonly fresh: boolean;
};

/**
 * A lane handed to a client directly: the parsed `rwa` section of a `Deployment`, or the same
 * section as a record on disk holds it, with its assets keyed by symbol.
 */
export type RwaLane = RwaDeployment | { readonly [key: string]: unknown };

export class RwaUnavailableError extends BursarError {
  constructor(record: Pick<Deployment, 'network' | 'chainId'>) {
    super(
      'rwa_unavailable',
      `Deployment ${record.network} on chain ${record.chainId} records no RWA lane. Connect with a record ` +
        'that has an rwa section, or pass the lane to rwa() yourself.',
      { chainId: record.chainId, network: record.network },
    );
  }
}

export class UnknownAssetError extends BursarError {
  constructor(asset: string, known: readonly string[] = []) {
    super(
      'rwa_unknown_asset',
      `${asset} is not an asset this deployment records.` +
        (known.length === 0 ? '' : ` It records ${known.join(', ')}.`) +
        ' Name another by its token address.',
      { asset, known },
    );
  }
}

/**
 * The RWA lane a connection's record carries.
 *
 * A record the caller supplied answers for itself, and so does any record naming a lane of its own.
 * Only the record this package resolved for its chain may take the lane from an earlier record of
 * the same build. A lookup by chain id is never the fallback for a record somebody passed in: a
 * local rehearsal or a fork of mainnet carries chain id 4663 too, and the lookup would hand it the
 * mainnet router, park and assets.
 */
export function laneOf(connection: Connection): RwaDeployment | undefined {
  const record = connection.deployment;
  if (record.rwa !== undefined) return record.rwa;

  if (!(Object.values(DEPLOYMENTS) as Deployment[]).includes(record)) return undefined;
  return record.status === 'live' && !isSuperseded(record) ? rwaDeployment(record.chainId) : undefined;
}

/** How a lane client names tokens in an error: by the symbol its lane records, else by address. */
export function laneContext(connection: Connection, lane: RwaDeployment | undefined): LaneContext {
  return {
    symbolOf: (token) => {
      if (isAddressEqual(token, connection.deployment.settlementAsset)) return 'USDG';
      return lane?.assets.find((a) => isAddressEqual(a.address, token))?.symbol ?? token;
    },
  };
}

/** Turns a revert on one of the lane's calls into the sentence for it, or leaves it for the caller. */
export function explainLane(
  call: LaneCall,
  context: LaneContext,
  details: Record<string, unknown> = {},
): ExplainRevert {
  return async (revert) => {
    if (!revert) return undefined;
    const refusal = laneRefusal(revert, call, context);
    return refusal === null
      ? undefined
      : new CallRefusedError(refusal.code, refusal.message, { ...details, owner: refusal.owner });
  };
}

/**
 * The same reading for a read that reverted, such as a quote against a stale feed, which viem
 * would otherwise hand back as a decoding error with the contract's name for it buried inside.
 */
export async function readingLane<T>(read: Promise<T>, call: LaneCall, context: LaneContext): Promise<T> {
  try {
    return await read;
  } catch (error) {
    const revert = revertFrom(error);
    const refusal = revert === undefined ? null : laneRefusal(revert, call, context);
    if (refusal === null) throw error;
    throw new CallRefusedError(refusal.code, refusal.message, { owner: refusal.owner });
  }
}

/** A principal-only call on the mandate, refused for the sender, named with who can send it. */
function explainPrincipalCall(mandate: MandateAccountClient, action: string): ExplainRevert {
  return async (revert) => {
    if (revert?.errorName !== 'NotPrincipal') return undefined;
    const principal = await mandate.connection.publicClient.readContract({
      address: mandate.address,
      abi: mandateAccountAbi,
      functionName: 'principal',
    });
    return new CallRefusedError(
      revert.errorName,
      `Only the principal of mandate ${mandate.address} can send ${action}, and that is ${principal}.`,
      { mandate: mandate.address, principal },
    );
  };
}

/**
 * Stock purchases and the treasury lane for one mandate.
 *
 * Every address comes from the lane: the one passed in, or the one the mandate's connection
 * records. Assets are named by symbol or address; a symbol resolves through that lane, and the
 * registry on chain is what every contract checks. Values are raw × feed price, never a projected
 * figure.
 */
export class RwaClient {
  readonly mandate: MandateAccountClient;
  readonly lane: RwaDeployment;
  readonly #context: LaneContext;

  constructor(mandate: MandateAccountClient, lane?: RwaLane) {
    const resolved = lane === undefined ? laneOf(mandate.connection) : parseRwaDeployment(lane);
    if (resolved === undefined) throw new RwaUnavailableError(mandate.connection.deployment);
    this.mandate = mandate;
    this.lane = resolved;
    this.#context = laneContext(mandate.connection, resolved);
  }

  get #client() {
    return this.mandate.connection.publicClient;
  }

  /** Every asset in the registry, read from chain. */
  async assets(): Promise<RwaAsset[]> {
    const list = await this.#client.readContract({
      address: this.lane.AssetRegistry,
      abi: assetRegistryAbi,
      functionName: 'assets',
    });
    return Promise.all(list.map((address) => this.asset(address)));
  }

  async asset(assetOrSymbol: string): Promise<RwaAsset> {
    const address = this.resolve(assetOrSymbol);
    const [a, symbol] = await readingLane(
      Promise.all([
        this.#client.readContract({
          address: this.lane.AssetRegistry,
          abi: assetRegistryAbi,
          functionName: 'get',
          args: [address],
        }),
        this.#client.readContract({
          address,
          abi: erc20Abi,
          functionName: 'symbol',
        }),
      ]),
      'buy',
      this.#context,
    );
    return {
      symbol: this.lane.assets.find((r) => isAddressEqual(r.address, address))?.symbol ?? symbol,
      address,
      feed: a.feed,
      kind: a.isTreasury ? 'treasury' : 'stock',
      eligible: a.eligible,
      decimals: a.decimals,
      bandBps: a.bandBps,
      haircutBps: a.haircutBps,
      tradeStaleness: a.tradeStaleness,
      valuationStaleness: a.valuationStaleness,
      perTradeCap: micro(a.perTradeCap),
      perMandateCap: micro(a.perMandateCap),
      totalCap: micro(a.totalCap),
    };
  }

  async price(assetOrSymbol: string): Promise<FeedPrice> {
    const [priceE8, updatedAt, fresh] = await readingLane(
      this.#client.readContract({
        address: this.lane.PriceGuard,
        abi: priceGuardAbi,
        functionName: 'valuationPrice',
        args: [this.resolve(assetOrSymbol)],
      }),
      'buy',
      this.#context,
    );
    return { priceE8, updatedAt: new Date(Number(updatedAt) * 1000), fresh };
  }

  /**
   * The smallest fill the router accepts for `usd` at the current feed price. A price the guard
   * will not trade on (stale, paused, out of its pool band) throws the reading for it.
   */
  async quote(assetOrSymbol: string, usd: Micro): Promise<{ priceE8: bigint; minOut: bigint }> {
    const asset = this.resolve(assetOrSymbol);
    const [priceE8, minOut] = await readingLane(
      Promise.all([
        this.#client.readContract({
          address: this.lane.PriceGuard,
          abi: priceGuardAbi,
          functionName: 'tradePrice',
          args: [asset, this.mandate.address],
        }),
        this.#client.readContract({
          address: this.lane.StockSpendRouter,
          abi: stockSpendRouterAbi,
          functionName: 'minOutFor',
          args: [this.mandate.address, asset, usd],
        }),
      ]),
      'buy',
      this.#context,
    );
    return { priceE8, minOut };
  }

  /**
   * Buys `usd` of an eligible stock for the mandate. Sent by the agent. The mandate must allow the
   * `rwa` class and point at this lane's router, and its principal must have listed the asset on
   * the router. A purchase counts against the mandate's limits like any spend and carries no
   * approval, so one at or above the approval threshold is refused.
   */
  async buy(assetOrSymbol: string, usd: Micro): Promise<BuyReceipt> {
    const asset = this.resolve(assetOrSymbol);
    const usdgIn = checkPositiveAmount('usd', usd);
    requireSigner(this.mandate.connection, 'buy');
    const { priceE8, minOut } = await this.quote(asset, usdgIn);
    const sent = await sendCall(this.mandate.connection, {
      to: this.mandate.address,
      data: encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'buy',
        args: [asset, usdgIn, minOut, priceE8],
      }),
      action: 'buy',
      explain: this.#explainBuy(usdgIn),
    });
    const [bought] = parseEventLogs({
      abi: mandateAccountAbi,
      eventName: 'Bought',
      logs: sent.receipt.logs,
    });
    return {
      ...sent,
      asset,
      usdgIn,
      amountOut: bought?.args.amountOut ?? 0n,
      priceE8,
    };
  }

  /** Principal only. Points the mandate at this lane's stock router, if it is not already. */
  async useRouter(): Promise<Sent | undefined> {
    const current = await this.#client.readContract({
      address: this.mandate.address,
      abi: mandateAccountAbi,
      functionName: 'router',
    });
    if (isAddressEqual(current, this.lane.StockSpendRouter)) return undefined;
    return sendCall(this.mandate.connection, {
      to: this.mandate.address,
      data: encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'setRouter',
        args: [this.lane.StockSpendRouter],
      }),
      action: 'setRouter',
      explain: explainPrincipalCall(this.mandate, 'setRouter'),
    });
  }

  /**
   * Principal only. Which assets the agent may buy, and the slippage limit against the feed price
   * in basis points (zero uses each asset's band).
   */
  async setPolicy(input: { slippageBps: number; allow?: string[]; deny?: string[] }): Promise<Sent> {
    const allow = (input.allow ?? []).map((a) => this.resolve(a));
    const deny = (input.deny ?? []).map((a) => this.resolve(a));
    return sendCall(this.mandate.connection, {
      to: this.lane.StockSpendRouter,
      data: encodeFunctionData({
        abi: stockSpendRouterAbi,
        functionName: 'setPolicy',
        args: [
          this.mandate.address,
          input.slippageBps,
          [...allow, ...deny],
          [...allow.map(() => true), ...deny.map(() => false)],
        ],
      }),
      action: 'setPolicy',
      explain: explainLane('policy', this.#context, { router: this.lane.StockSpendRouter }),
    });
  }

  async policy(): Promise<{ slippageBps: number; allowed: Address[] }> {
    const assets = this.lane.assets.filter((a) => a.kind === 'stock');
    const [slippageBps, ...flags] = await Promise.all([
      this.#client.readContract({
        address: this.lane.StockSpendRouter,
        abi: stockSpendRouterAbi,
        functionName: 'maxSlippageBps',
        args: [this.mandate.address],
      }),
      ...assets.map((a) =>
        this.#client.readContract({
          address: this.lane.StockSpendRouter,
          abi: stockSpendRouterAbi,
          functionName: 'assetAllowed',
          args: [this.mandate.address, a.address],
        }),
      ),
    ]);
    return {
      slippageBps,
      allowed: assets.filter((_, i) => flags[i]).map((a) => a.address),
    };
  }

  /** Stock tokens the mandate holds, valued at raw × feed price. */
  async holdings(): Promise<Holding[]> {
    const assets = (await this.assets()).filter((a) => a.kind === 'stock');
    return Promise.all(
      assets.map(async (asset) => {
        const [raw, price] = await Promise.all([
          this.#client.readContract({
            address: asset.address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [this.mandate.address],
          }),
          this.price(asset.address),
        ]);
        const value = price.fresh ? rawToUsdgMicros(raw, price.priceE8, asset.decimals) : 0n;
        return { asset, raw, value: micro(value), price };
      }),
    );
  }

  /** Parked positions, one per adapter the lane knows. */
  async parked(): Promise<ParkedPosition[]> {
    return Promise.all(
      Object.entries(this.lane.adapters).map(async ([symbol, adapter]) => {
        const [raw, basis, value, priceE8, updatedAt, fresh] = await this.#client.readContract({
          address: this.lane.TreasuryPark,
          abi: treasuryParkAbi,
          functionName: 'position',
          args: [this.mandate.address, adapter],
        });
        return {
          symbol,
          adapter,
          raw,
          basis: micro(basis),
          value: micro(value),
          priceE8,
          updatedAt: new Date(Number(updatedAt) * 1000),
          fresh,
        };
      }),
    );
  }

  /** USDG held, plus USDG waiting to be parked, plus fresh parked value after the haircut. */
  async spendingPower(): Promise<Micro> {
    return micro(
      await this.#client.readContract({
        address: this.lane.TreasuryPark,
        abi: treasuryParkAbi,
        functionName: 'spendingPower',
        args: [this.mandate.address],
      }),
    );
  }

  async buffer(): Promise<Micro> {
    return micro(
      await this.#client.readContract({
        address: this.lane.TreasuryPark,
        abi: treasuryParkAbi,
        functionName: 'buffer',
        args: [this.mandate.address],
      }),
    );
  }

  /** Principal only. USDG the mandate must keep liquid; parking below it is refused. */
  async setBuffer(amount: Micro): Promise<Sent> {
    return sendCall(this.mandate.connection, {
      to: this.lane.TreasuryPark,
      data: encodeFunctionData({
        abi: treasuryParkAbi,
        functionName: 'setBuffer',
        args: [this.mandate.address, amount],
      }),
      action: 'setBuffer',
      explain: explainLane('park', this.#context, { park: this.lane.TreasuryPark }),
    });
  }

  /**
   * Principal only. Moves `usd` from the mandate to its park vault, then parks it in `into`
   * (SGOV by default). Two transactions.
   *
   * The buffer and the fund's caps are checked before either is sent. The park checks them only
   * once the USDG has already left the mandate for the vault, and a park refused there leaves it
   * sitting in the vault.
   */
  async park(usd: Micro, into = 'SGOV'): Promise<{ withdraw: Sent; park: Sent }> {
    const amount = checkPositiveAmount('usd', usd);
    const adapter = this.adapter(into);
    const [vault, balance, buffer, [, basis], totalBasis, [perMandateCap, totalCap]] = await Promise.all([
      this.#client.readContract({
        address: this.lane.TreasuryPark,
        abi: treasuryParkAbi,
        functionName: 'vaultOf',
        args: [this.mandate.address],
      }),
      this.mandate.balance(),
      this.buffer(),
      this.#client.readContract({
        address: this.lane.TreasuryPark,
        abi: treasuryParkAbi,
        functionName: 'position',
        args: [this.mandate.address, adapter],
      }),
      this.#client.readContract({
        address: this.lane.TreasuryPark,
        abi: treasuryParkAbi,
        functionName: 'totalBasis',
        args: [adapter],
      }),
      this.#client.readContract({ address: adapter, abi: parkAdapterAbi, functionName: 'caps' }),
    ]);

    const refused = (errorName: string, args: readonly unknown[]): Error => {
      const refusal = laneRefusal({ errorName, args }, 'park', this.#context);
      return new CallRefusedError(errorName, refusal?.message ?? errorName, {
        park: this.lane.TreasuryPark,
        owner: refusal?.owner,
      });
    };

    if (amount > balance) throw new InsufficientFundsError(this.mandate.address, balance, amount);
    if (balance - amount < buffer) throw refused('BelowBuffer', [balance - amount, buffer]);
    if (basis + amount > perMandateCap) throw refused('MandateCapExceeded', [basis + amount, perMandateCap]);
    if (totalBasis + amount > totalCap) throw refused('TotalCapExceeded', [totalBasis + amount, totalCap]);

    const withdraw = await this.mandate.withdraw({ to: vault, amount });
    const park = await sendCall(this.mandate.connection, {
      to: this.lane.TreasuryPark,
      data: encodeFunctionData({
        abi: treasuryParkAbi,
        functionName: 'park',
        args: [this.mandate.address, adapter, amount, 0n],
      }),
      action: 'park',
      explain: explainLane('park', this.#context, { park: this.lane.TreasuryPark }),
    });
    return { withdraw, park };
  }

  /**
   * Principal or agent. Sells `raw` (or the whole position) back to USDG, delivered to the mandate.
   * Open from an adapter governance has disabled too: disabling one stops new parks, never exits.
   */
  async unpark(from = 'SGOV', raw?: bigint): Promise<Sent> {
    const adapter = this.adapter(from);
    const amount = raw ?? (await this.parked()).find((p) => p.adapter === adapter)?.raw ?? 0n;
    if (amount <= 0n) throw new BursarError('rwa_nothing_parked', `Nothing is parked in ${from}.`, { from });
    return sendCall(this.mandate.connection, {
      to: this.lane.TreasuryPark,
      data: encodeFunctionData({
        abi: treasuryParkAbi,
        functionName: 'unpark',
        args: [this.mandate.address, adapter, amount, 0n],
      }),
      action: 'unpark',
      explain: explainLane('park', this.#context, { park: this.lane.TreasuryPark }),
    });
  }

  resolve(assetOrSymbol: string): Address {
    if (assetOrSymbol.startsWith('0x')) return checkAddress('asset', assetOrSymbol as Address);
    const found = this.lane.assets.find((a) => a.symbol.toUpperCase() === assetOrSymbol.toUpperCase());
    if (found === undefined) throw new UnknownAssetError(assetOrSymbol, this.lane.assets.map((a) => a.symbol));
    return found.address;
  }

  adapter(symbol: string): Address {
    const found = Object.entries(this.lane.adapters).find(([s]) => s.toUpperCase() === symbol.toUpperCase());
    if (found === undefined) throw new UnknownAssetError(symbol, Object.keys(this.lane.adapters));
    return found[1];
  }

  /**
   * A purchase is a spend in the `rwa` class, so the account's own limits refuse it first and are
   * quoted the way `pay` quotes them. What gets past them is the router's, the price guard's, or,
   * for a mandate short of USDG, whatever covers the difference.
   */
  #explainBuy(usdgIn: Micro): ExplainRevert {
    const lane = explainLane('buy', this.#context, { mandate: this.mandate.address });

    return async (revert, error) => {
      if (!revert) return undefined;

      if (revert.errorName === 'ApprovalRequired') {
        const { approvalThreshold } = await this.mandate.limits();
        return new CallRefusedError(
          revert.errorName,
          `A purchase carries no approval, and this one is ${usd(usdgIn)}, at or above the mandate's ` +
            `approval threshold of ${usd(approvalThreshold)}. Buy less than the threshold in one call, ` +
            'or have the principal raise it with setLimits.',
          { mandate: this.mandate.address, amount: usdgIn.toString(), threshold: approvalThreshold.toString() },
        );
      }

      const reason = denialOf(revert);
      if (reason) {
        const [limits, remaining, daily, monthly, total] = await Promise.all([
          this.mandate.limits(),
          this.mandate.remaining(),
          this.mandate.window(WindowKind.Daily),
          this.mandate.window(WindowKind.Monthly),
          this.mandate.total(),
        ]);
        return new MandateDeniedError({
          reason,
          errorName: revert.errorName,
          mandate: this.mandate.address,
          amount: usdgIn,
          snapshot: { limits, remaining, daily, monthly, total },
        });
      }

      if (revert.errorName === 'ERC20InsufficientBalance') {
        return new InsufficientFundsError(this.mandate.address, await this.mandate.balance(), usdgIn);
      }

      return lane(revert, error);
    };
  }
}

export function rwa(mandate: MandateAccountClient, lane?: RwaLane): RwaClient {
  return new RwaClient(mandate, lane);
}
