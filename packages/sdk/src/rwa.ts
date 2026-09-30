import { encodeFunctionData, erc20Abi, parseEventLogs } from 'viem';
import type { Address } from 'viem';
import {
  BursarError,
  assetRegistryAbi,
  mandateAccountAbi,
  priceGuardAbi,
  rawToUsdgMicros,
  rwaDeployment,
  stockSpendRouterAbi,
  treasuryParkAbi,
} from '@bursar/core';
import type { Micro, RwaDeployment } from '@bursar/core';

import { checkAddress, checkPositiveAmount } from './guards.js';
import { micro } from './money.js';
import { sendCall, type Sent } from './send.js';
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

export class RwaUnavailableError extends BursarError {
  constructor(chainId: number) {
    super('rwa_unavailable', `No RWA lane is deployed on chain ${chainId}.`, {
      chainId,
    });
  }
}

export class UnknownAssetError extends BursarError {
  constructor(asset: string) {
    super('rwa_unknown_asset', `${asset} is not in the asset registry.`, {
      asset,
    });
  }
}

/**
 * Stock purchases and the treasury lane for one mandate.
 *
 * Assets are named by symbol or address; a symbol resolves through the deployment record, and the
 * registry on chain is what every contract checks. Values are raw × feed price, never a projected
 * figure.
 */
export class RwaClient {
  readonly mandate: MandateAccountClient;
  readonly lane: RwaDeployment;

  constructor(mandate: MandateAccountClient, lane?: RwaDeployment) {
    const resolved = lane ?? rwaDeployment(mandate.connection.deployment.chainId);
    if (resolved === undefined) throw new RwaUnavailableError(mandate.connection.deployment.chainId);
    this.mandate = mandate;
    this.lane = resolved;
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
    const [a, symbol] = await Promise.all([
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
    ]);
    return {
      symbol: this.lane.assets.find((r) => r.address.toLowerCase() === address.toLowerCase())?.symbol ?? symbol,
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
    const [priceE8, updatedAt, fresh] = await this.#client.readContract({
      address: this.lane.PriceGuard,
      abi: priceGuardAbi,
      functionName: 'valuationPrice',
      args: [this.resolve(assetOrSymbol)],
    });
    return { priceE8, updatedAt: new Date(Number(updatedAt) * 1000), fresh };
  }

  /** The smallest fill the router accepts for `usd` at the current feed price. */
  async quote(assetOrSymbol: string, usd: Micro): Promise<{ priceE8: bigint; minOut: bigint }> {
    const asset = this.resolve(assetOrSymbol);
    const [priceE8, minOut] = await Promise.all([
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
    ]);
    return { priceE8, minOut };
  }

  /**
   * Buys `usd` of an eligible stock for the mandate. Sent by the agent. The mandate must allow the
   * `rwa` class, and its principal must have listed the asset on the router.
   */
  async buy(assetOrSymbol: string, usd: Micro): Promise<BuyReceipt> {
    const asset = this.resolve(assetOrSymbol);
    const usdgIn = checkPositiveAmount('usd', usd);
    const { priceE8, minOut } = await this.quote(asset, usdgIn);
    const sent = await sendCall(this.mandate.connection, {
      to: this.mandate.address,
      data: encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'buy',
        args: [asset, usdgIn, minOut, priceE8],
      }),
      action: 'buy',
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

  /** Principal only. Points the mandate at the stock router, if it is not already. */
  async useRouter(): Promise<Sent | undefined> {
    const current = await this.#client.readContract({
      address: this.mandate.address,
      abi: mandateAccountAbi,
      functionName: 'router',
    });
    if (current.toLowerCase() === this.lane.StockSpendRouter.toLowerCase()) return undefined;
    return sendCall(this.mandate.connection, {
      to: this.mandate.address,
      data: encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'setRouter',
        args: [this.lane.StockSpendRouter],
      }),
      action: 'setRouter',
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
    });
  }

  /**
   * Principal only. Moves `usd` from the mandate to its park vault, then parks it in `into`
   * (SGOV by default). Two transactions.
   */
  async park(usd: Micro, into = 'SGOV'): Promise<{ withdraw: Sent; park: Sent }> {
    const amount = checkPositiveAmount('usd', usd);
    const adapter = this.adapter(into);
    const vault = await this.#client.readContract({
      address: this.lane.TreasuryPark,
      abi: treasuryParkAbi,
      functionName: 'vaultOf',
      args: [this.mandate.address],
    });
    const withdraw = await this.mandate.withdraw({ to: vault, amount });
    const park = await sendCall(this.mandate.connection, {
      to: this.lane.TreasuryPark,
      data: encodeFunctionData({
        abi: treasuryParkAbi,
        functionName: 'park',
        args: [this.mandate.address, adapter, amount, 0n],
      }),
      action: 'park',
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
    });
  }

  resolve(assetOrSymbol: string): Address {
    if (assetOrSymbol.startsWith('0x')) return checkAddress('asset', assetOrSymbol as Address);
    const found = this.lane.assets.find((a) => a.symbol.toUpperCase() === assetOrSymbol.toUpperCase());
    if (found === undefined) throw new UnknownAssetError(assetOrSymbol);
    return found.address;
  }

  adapter(symbol: string): Address {
    const found = Object.entries(this.lane.adapters).find(([s]) => s.toUpperCase() === symbol.toUpperCase());
    if (found === undefined) throw new UnknownAssetError(symbol);
    return found[1];
  }
}

export function rwa(mandate: MandateAccountClient, lane?: RwaDeployment): RwaClient {
  return new RwaClient(mandate, lane);
}
