import { encodeFunctionData, erc20Abi } from 'viem';
import type { Address } from 'viem';
import {
  BursarError,
  COLLATERAL_LANE,
  collateralDeployment,
  collateralVaultAbi,
  creditPoolAbi,
  healthRatio,
  mandateAccountAbi,
  rwaDeployment,
  settlementAssetAbi,
} from '@bursar/core';
import type { CollateralDeployment, Micro, RwaDeployment } from '@bursar/core';

import { checkAddress, checkPositiveAmount } from './guards.js';
import { micro } from './money.js';
import { sendCall, type Sent } from './send.js';
import type { MandateAccountClient } from './mandate.js';
import { UnknownAssetError } from './rwa.js';

/** Margin added to a repayment by default, so spread accrued between the read and the send is covered. */
const REPAY_MARGIN = 100n;

export type HaircutTier = {
  /** 1-based, as the vault numbers them. */
  readonly tier: number;
  readonly name: string;
  readonly sessionHaircutBps: number;
  readonly afterHoursHaircutBps: number;
  /** Seconds of feed silence after which the after-hours haircut applies on a weekday. */
  readonly sessionStaleness: number;
  /** Seconds after which a position counts zero. */
  readonly valuationStaleness: number;
};

export type CollateralAsset = {
  readonly symbol: string;
  readonly address: Address;
  readonly tier: number;
  /** The haircut that applies right now. */
  readonly haircutBps: number;
  readonly afterHours: boolean;
};

export type CollateralTiers = {
  readonly tiers: HaircutTier[];
  readonly assets: CollateralAsset[];
  /** Inside the US equities 24/5 session by the vault's clock. */
  readonly inSession: boolean;
};

export type CollateralPosition = {
  readonly symbol: string;
  readonly asset: Address;
  readonly tier: number;
  readonly raw: bigint;
  readonly priceE8: bigint;
  readonly updatedAt: Date;
  readonly fresh: boolean;
  readonly haircutBps: number;
  /** raw × feed price. Zero when the price is stale or the oracle is paused. */
  readonly value: Micro;
  /** Value after the haircut. */
  readonly adjusted: Micro;
};

export type CollateralAccount = {
  readonly mandate: Address;
  readonly lane: number;
  readonly lineOpen: boolean;
  readonly value: Micro;
  readonly adjusted: Micro;
  readonly debt: Micro;
  /** What the mandate can still draw on credit. */
  readonly headroom: Micro;
  /** 1e18 = 1.0. The maximum uint256 when nothing is owed. */
  readonly healthE18: bigint;
  /** Health as a ratio, or null when nothing is owed. */
  readonly health: number | null;
  readonly positions: CollateralPosition[];
};

export class CollateralUnavailableError extends BursarError {
  constructor(chainId: number) {
    super('collateral_unavailable', `No collateral lane is deployed on chain ${chainId}.`, { chainId });
  }
}

/** Debt exists only in the collateral lane. A prefund or direct mandate cannot open a line or draw. */
export class NotCollateralLaneError extends BursarError {
  constructor(mandate: Address, lane: number) {
    super(
      'collateral_wrong_lane',
      `${mandate} is in lane ${lane}. Only a collateral-lane mandate (lane ${COLLATERAL_LANE}) can borrow; create one with lane ${COLLATERAL_LANE}.`,
      { mandate, lane },
    );
  }
}

export class NoDebtError extends BursarError {
  constructor(mandate: Address) {
    super('collateral_no_debt', `${mandate} owes nothing.`, { mandate });
  }
}

/**
 * The collateral lane for one mandate: posted stock and treasury tokens, the credit drawn against
 * them, and repayment. Values are raw × feed price less the tier haircut, read from chain.
 */
export class CollateralClient {
  readonly mandate: MandateAccountClient;
  readonly lane: CollateralDeployment;
  readonly rwa: RwaDeployment;

  constructor(mandate: MandateAccountClient, lane?: CollateralDeployment) {
    const chainId = mandate.connection.deployment.chainId;
    const rwa = rwaDeployment(chainId);
    const resolved = lane ?? collateralDeployment(chainId);
    if (resolved === undefined || rwa === undefined) throw new CollateralUnavailableError(chainId);
    this.mandate = mandate;
    this.lane = resolved;
    this.rwa = rwa;
  }

  get #client() {
    return this.mandate.connection.publicClient;
  }

  /** The published haircut tiers and which tier each accepted asset sits in, read from chain. */
  async tiers(): Promise<CollateralTiers> {
    const vault = this.lane.CollateralVault;
    const [tiers, assets, block] = await Promise.all([
      this.#client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'tiers' }),
      this.#client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'collateralAssets' }),
      this.#client.getBlock(),
    ]);
    const [inSession, ...rows] = await Promise.all([
      this.#client.readContract({
        address: vault,
        abi: collateralVaultAbi,
        functionName: 'inSession',
        args: [block.timestamp],
      }),
      ...assets.map(async (address) => {
        const [tier, [haircutBps, afterHours]] = await Promise.all([
          this.#client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'tierOf', args: [address] }),
          this.#client.readContract({
            address: vault,
            abi: collateralVaultAbi,
            functionName: 'haircutOf',
            args: [address],
          }),
        ]);
        return { symbol: this.#symbol(address), address, tier, haircutBps, afterHours };
      }),
    ]);
    return {
      tiers: tiers.map((t, i) => ({
        tier: i + 1,
        name: t.name,
        sessionHaircutBps: t.sessionHaircutBps,
        afterHoursHaircutBps: t.afterHoursHaircutBps,
        sessionStaleness: t.sessionStaleness,
        valuationStaleness: t.valuationStaleness,
      })),
      assets: rows.filter((r) => r.tier !== 0),
      inSession,
    };
  }

  /** Collateral, debt, headroom and health for this mandate. */
  async position(): Promise<CollateralAccount> {
    const vault = this.lane.CollateralVault;
    const address = this.mandate.address;
    const [[value, adjusted, debt, headroom, healthE18], positions, lineOpen, lane] = await Promise.all([
      this.#client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'account', args: [address] }),
      this.#client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'positions', args: [address] }),
      this.#client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'isLine', args: [address] }),
      this.#lane(),
    ]);
    return {
      mandate: address,
      lane,
      lineOpen,
      value: micro(value),
      adjusted: micro(adjusted),
      debt: micro(debt),
      headroom: micro(headroom),
      healthE18,
      health: healthRatio(healthE18),
      positions: positions
        .filter((p) => p.raw > 0n)
        .map((p) => ({
          symbol: this.#symbol(p.asset),
          asset: p.asset,
          tier: p.tier,
          raw: p.raw,
          priceE8: p.priceE8,
          updatedAt: new Date(Number(p.updatedAt) * 1000),
          fresh: p.fresh,
          haircutBps: p.haircutBps,
          value: micro(p.value),
          adjusted: micro(p.adjusted),
        })),
    };
  }

  async debt(): Promise<Micro> {
    return micro(
      await this.#client.readContract({
        address: this.lane.CreditPool,
        abi: creditPoolAbi,
        functionName: 'debtOf',
        args: [this.mandate.address],
      }),
    );
  }

  /**
   * Principal only. Opens the credit line and points the mandate's shortfall hook at the vault, so a
   * spend the mandate's USDG cannot cover draws the difference on credit. Refuses a mandate outside
   * the collateral lane before sending anything.
   */
  async openLine(): Promise<{ openLine?: Sent; setCreditLane?: Sent }> {
    await this.#requireCollateralLane();
    const open = await this.#client.readContract({
      address: this.lane.CollateralVault,
      abi: collateralVaultAbi,
      functionName: 'isLine',
      args: [this.mandate.address],
    });
    const openLine = open
      ? undefined
      : await sendCall(this.mandate.connection, {
          to: this.lane.CollateralVault,
          data: encodeFunctionData({
            abi: collateralVaultAbi,
            functionName: 'openLine',
            args: [this.mandate.address],
          }),
          action: 'openLine',
        });
    const setCreditLane = await this.setCreditLane();
    return { ...(openLine ? { openLine } : {}), ...(setCreditLane ? { setCreditLane } : {}) };
  }

  /** Principal only. Names the vault as the mandate's shortfall hook, if it is not already. */
  async setCreditLane(): Promise<Sent | undefined> {
    await this.#requireCollateralLane();
    const current = await this.#client.readContract({
      address: this.mandate.address,
      abi: mandateAccountAbi,
      functionName: 'treasuryPark',
    });
    if (current.toLowerCase() === this.lane.CollateralVault.toLowerCase()) return undefined;
    return sendCall(this.mandate.connection, {
      to: this.mandate.address,
      data: encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'setTreasuryPark',
        args: [this.lane.CollateralVault],
      }),
      action: 'setTreasuryPark',
    });
  }

  /** Posts `raw` token units from the signer to this mandate's line. Approves the vault first when needed. */
  async deposit(assetOrSymbol: string, raw: bigint): Promise<{ approve?: Sent; deposit: Sent }> {
    const asset = this.resolve(assetOrSymbol);
    if (raw <= 0n) throw new BursarError('collateral_amount_invalid', 'A deposit must move a positive amount.', { raw });
    await this.#requireCollateralLane();
    const approve = await this.#approve(asset, this.lane.CollateralVault, raw);
    const deposit = await sendCall(this.mandate.connection, {
      to: this.lane.CollateralVault,
      data: encodeFunctionData({
        abi: collateralVaultAbi,
        functionName: 'deposit',
        args: [this.mandate.address, asset, raw],
      }),
      action: 'deposit',
    });
    return { ...(approve ? { approve } : {}), deposit };
  }

  /** Principal only. Takes collateral back; refused if what stays would not carry the debt. */
  async withdraw(assetOrSymbol: string, raw: bigint, to: Address): Promise<Sent> {
    const asset = this.resolve(assetOrSymbol);
    return sendCall(this.mandate.connection, {
      to: this.lane.CollateralVault,
      data: encodeFunctionData({
        abi: collateralVaultAbi,
        functionName: 'withdraw',
        args: [this.mandate.address, asset, raw, checkAddress('to', to)],
      }),
      action: 'withdraw',
    });
  }

  /**
   * Pays down the mandate's debt from the signer's USDG. Without an amount it pays the whole debt,
   * with a small margin for spread accrued before the transaction lands; the pool takes no more
   * than is owed.
   */
  async repay(amount?: Micro): Promise<{ approve?: Sent; repay: Sent; amount: Micro }> {
    let value: bigint;
    if (amount === undefined) {
      const owed = await this.debt();
      if (owed === 0n) throw new NoDebtError(this.mandate.address);
      value = owed + REPAY_MARGIN;
    } else {
      value = checkPositiveAmount('amount', amount);
    }
    const usdg = this.mandate.connection.deployment.settlementAsset;
    const approve = await this.#approve(usdg, this.lane.CreditPool, value);
    const repay = await sendCall(this.mandate.connection, {
      to: this.lane.CreditPool,
      data: encodeFunctionData({ abi: creditPoolAbi, functionName: 'repay', args: [this.mandate.address, value] }),
      action: 'repay',
    });
    return { ...(approve ? { approve } : {}), repay, amount: micro(value) };
  }

  /** Anyone. Sells the slice of `asset` that restores health, through the asset's pinned pool, for a bounty. */
  async liquidate(assetOrSymbol: string): Promise<Sent> {
    return sendCall(this.mandate.connection, {
      to: this.lane.CollateralVault,
      data: encodeFunctionData({
        abi: collateralVaultAbi,
        functionName: 'liquidate',
        args: [this.mandate.address, this.resolve(assetOrSymbol)],
      }),
      action: 'liquidate',
    });
  }

  resolve(assetOrSymbol: string): Address {
    if (assetOrSymbol.startsWith('0x')) return checkAddress('asset', assetOrSymbol as Address);
    const found = this.rwa.assets.find((a) => a.symbol.toUpperCase() === assetOrSymbol.toUpperCase());
    if (found === undefined) throw new UnknownAssetError(assetOrSymbol);
    return found.address;
  }

  #symbol(address: Address): string {
    return this.rwa.assets.find((a) => a.address.toLowerCase() === address.toLowerCase())?.symbol ?? address;
  }

  async #lane(): Promise<number> {
    return this.#client.readContract({ address: this.mandate.address, abi: mandateAccountAbi, functionName: 'lane' });
  }

  async #requireCollateralLane(): Promise<void> {
    const lane = await this.#lane();
    if (lane !== COLLATERAL_LANE) throw new NotCollateralLaneError(this.mandate.address, lane);
  }

  async #approve(token: Address, spender: Address, amount: bigint): Promise<Sent | undefined> {
    const signer = this.mandate.connection.walletClient?.account?.address;
    if (signer !== undefined) {
      const allowance = await this.#client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [signer, spender],
      });
      if (allowance >= amount) return undefined;
    }
    return sendCall(this.mandate.connection, {
      to: token,
      data: encodeFunctionData({
        abi: token === this.mandate.connection.deployment.settlementAsset ? settlementAssetAbi : erc20Abi,
        functionName: 'approve',
        args: [spender, amount],
      }),
      action: 'approve',
    });
  }
}

export function collateral(mandate: MandateAccountClient, lane?: CollateralDeployment): CollateralClient {
  return new CollateralClient(mandate, lane);
}
