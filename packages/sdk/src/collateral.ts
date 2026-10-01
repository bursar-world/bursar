import { encodeFunctionData, isAddressEqual, parseEventLogs } from 'viem';
import type { Address } from 'viem';
import {
  BursarError,
  COLLATERAL_LANE,
  CURRENT_CONTRACT_SET,
  collateralVaultAbi,
  contractSetAtLeast,
  contractSetOfEscrow,
  creditPoolAbi,
  drawHaltOf,
  healthRatio,
  mandateAccountAbi,
  parseCollateralDeployment,
  parseRwaDeployment,
} from '@bursar/core';
import type { CollateralDeployment, Deployment, DrawHalt, Micro, RwaDeployment } from '@bursar/core';

import { approveIfShort } from './allowance.js';
import { CallRefusedError, InvalidArgumentError } from './errors.js';
import { checkAddress, checkPositiveAmount } from './guards.js';
import { boundDraw, drawHaltRefusal, laneRefusal, observationBounds } from './lane-refusals.js';
import type { LaneContext, ObservationBounds } from './lane-refusals.js';
import { micro } from './money.js';
import { logsFrom } from './receipt.js';
import type { Refusal } from './refusals.js';
import { sendCall, type ExplainRevert, type Sent } from './send.js';
import type { MandateAccountClient } from './mandate.js';
import { UnknownAssetError, explainLane, laneContext, laneOf, type RwaLane } from './rwa.js';

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

/**
 * Whether a draw would count a position in one asset right now, and the first condition it fails
 * when it would not. The same answer for every line, because the conditions are the asset's: its
 * feed, its pool and the price guard's reading of the two.
 */
export type DrawStanding = {
  readonly symbol: string;
  readonly asset: Address;
  /** `None` while a draw counts the position. */
  readonly halt: DrawHalt;
  /** The condition in a sentence, with what clears it. Null while the position counts. */
  readonly refusal: Refusal | null;
};

/** Collateral a write-off took from a line, waiting for the pool's lender to claim it. */
export type SeizedCollateral = {
  readonly symbol: string;
  readonly asset: Address;
  readonly raw: bigint;
};

export type CollateralPosition = {
  readonly symbol: string;
  readonly asset: Address;
  readonly tier: number;
  readonly raw: bigint;
  readonly priceE8: bigint;
  readonly updatedAt: Date;
  /**
   * The position counts: its price is inside the valuation bound, the token, its oracle and the
   * access registry are unpaused, and the asset's pool trades inside its band of the feed.
   */
  readonly fresh: boolean;
  /** The haircut that applies now. Draws and withdrawals are checked at the after-hours one. */
  readonly haircutBps: number;
  /** raw × feed price. Zero whenever the position is not fresh. */
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
  /**
   * What the mandate can still draw on credit. Measured with every position at its after-hours
   * haircut whatever the clock says, so a line drawn in session does not fall under 1.0 when the
   * market closes.
   */
  readonly headroom: Micro;
  /**
   * The liquidation trigger, 1e18 = 1.0, at the haircuts that apply now. It counts a position whose
   * pool has left its band at the feed, so it can read higher than `adjusted` over `debt`. The
   * maximum uint256 when nothing is owed.
   */
  readonly healthE18: bigint;
  /** Health as a ratio, or null when nothing is owed. */
  readonly health: number | null;
  readonly positions: CollateralPosition[];
};

/**
 * A collateral lane handed to the client directly: the `rwa` section of a record, which carries the
 * lane and the assets it takes, or only its `collateral` part. Either shape a record comes in is
 * read, parsed or as it sits on disk.
 */
export type CollateralLane = RwaLane | CollateralDeployment;

export class CollateralUnavailableError extends BursarError {
  constructor(record: Pick<Deployment, 'network' | 'chainId'>) {
    super(
      'collateral_unavailable',
      `Deployment ${record.network} on chain ${record.chainId} records no collateral lane. Connect with a ` +
        'record whose rwa section has a collateral part, or pass the lane to collateral() yourself.',
      { chainId: record.chainId, network: record.network },
    );
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

/** The vault answered a draw condition this build does not name. Newer contracts, older package. */
export class UnknownDrawHaltError extends BursarError {
  constructor(asset: Address, value: number) {
    super(
      'collateral_halt_unknown',
      `The vault reports draw condition ${value} for ${asset}, which this build of @bursar/sdk does not name. ` +
        'The position may count for nothing toward a draw. Update the package before reading it as anything.',
      { asset, value },
    );
  }
}

/** The lane runs a build from before v4, which does not hold draws to an observation or seize collateral. */
export class CollateralSetError extends BursarError {
  constructor(what: string, record: Pick<Deployment, 'network'>) {
    super(
      'collateral_set_too_early',
      `${what} is not something the collateral lane of ${record.network} does: it runs a build from before v4. ` +
        'Connect with a record whose lane runs v4 or later.',
      { network: record.network },
    );
  }
}

/**
 * The lane and the asset list its symbols resolve through.
 *
 * A collateral part handed over on its own borrows the connection's asset list only when that
 * record's lane is the same one, vault for vault. Borrowed from any other record, a symbol would
 * resolve to that record's token on this chain.
 */
function resolveLanes(
  mandate: MandateAccountClient,
  lane: CollateralLane | undefined,
): { collateral: CollateralDeployment | undefined; rwa: RwaDeployment | undefined } {
  const recorded = laneOf(mandate.connection);
  if (lane === undefined) return { collateral: recorded?.collateral, rwa: recorded };

  if ('AssetRegistry' in lane) {
    const rwa = parseRwaDeployment(lane);
    return { collateral: rwa.collateral, rwa };
  }

  const collateral = parseCollateralDeployment(lane);
  const vault = recorded?.collateral?.CollateralVault;
  const same = vault !== undefined && isAddressEqual(vault, collateral.CollateralVault);
  return { collateral, rwa: same ? recorded : undefined };
}

/**
 * The collateral lane for one mandate: posted stock and treasury tokens, the credit drawn against
 * them, and repayment. Values are raw × feed price less the tier haircut, read from chain.
 *
 * Every address comes from the lane: the one passed in, or the one the mandate's connection
 * records.
 */
export class CollateralClient {
  readonly mandate: MandateAccountClient;
  readonly lane: CollateralDeployment;
  /** The RWA lane the collateral lane belongs to, whose asset list symbols resolve through. */
  readonly rwa: RwaDeployment | undefined;
  readonly #context: LaneContext;

  constructor(mandate: MandateAccountClient, lane?: CollateralLane) {
    const resolved = resolveLanes(mandate, lane);
    if (resolved.collateral === undefined) {
      if (lane === undefined) throw new CollateralUnavailableError(mandate.connection.deployment);
      throw new InvalidArgumentError(
        'lane',
        'The lane passed to collateral() has no collateral part, so there is no vault or credit pool to reach.',
      );
    }
    this.mandate = mandate;
    this.lane = resolved.collateral;
    this.rwa = resolved.rwa;
    this.#context = laneContext(mandate.connection, resolved.rwa);
  }

  get #client() {
    return this.mandate.connection.publicClient;
  }

  /**
   * Whether the lane's vault is a v4 build: one that holds a draw to the price guard's reading of
   * the pool and seizes what a written-off line still holds. A lane handed over directly is read
   * as the build of the connection it was handed to.
   */
  get #observes(): boolean {
    const set = contractSetOfEscrow(this.mandate.connection.addresses.escrow) ?? CURRENT_CONTRACT_SET;
    return contractSetAtLeast(set, 'v4');
  }

  #requireObserves(what: string): void {
    if (!this.#observes) throw new CollateralSetError(what, this.mandate.connection.deployment);
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
        return { symbol: this.#context.symbolOf(address), address, tier, haircutBps, afterHours };
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
          symbol: this.#context.symbolOf(p.asset),
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
   * Why `headroom` can read zero with collateral posted: for each asset the vault accepts, whether
   * a draw would count a position in it right now, and the first condition it fails when not. Empty
   * on a lane from before v4, whose vault counts a position on its valuation alone.
   */
  async drawStanding(): Promise<DrawStanding[]> {
    if (!this.#observes) return [];
    const vault = this.lane.CollateralVault;
    const [assets, bounds] = await Promise.all([
      this.#client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'collateralAssets' }),
      this.observationBounds(),
    ]);
    const halts = await Promise.all(
      assets.map((asset) =>
        this.#client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'drawHalt', args: [asset] }),
      ),
    );
    return assets.map((asset, index) => {
      const value = halts[index] ?? 0;
      const halt = drawHaltOf(value);
      if (halt === undefined) throw new UnknownDrawHaltError(asset, value);
      return {
        symbol: this.#context.symbolOf(asset),
        asset,
        halt,
        refusal: drawHaltRefusal(halt, asset, this.#context, bounds),
      };
    });
  }

  /** The price guard's bounds on a reading of a pool. Undefined on a lane from before v4. */
  async observationBounds(): Promise<ObservationBounds | undefined> {
    if (!this.#observes) return undefined;
    return observationBounds(this.#client, this.lane.CollateralVault);
  }

  /**
   * Collateral that write-offs have taken from lines and not yet paid to the pool's lender, per
   * asset the vault accepts, with the empty ones left out. Empty on a lane from before v4, which
   * left a written-off line holding what could not be sold.
   */
  async seized(): Promise<SeizedCollateral[]> {
    if (!this.#observes) return [];
    const vault = this.lane.CollateralVault;
    const assets = await this.#client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'collateralAssets' });
    const raws = await Promise.all(
      assets.map((asset) =>
        this.#client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'seized', args: [asset] }),
      ),
    );
    return assets
      .map((asset, index) => ({ symbol: this.#context.symbolOf(asset), asset, raw: raws[index] ?? 0n }))
      .filter((entry) => entry.raw > 0n);
  }

  /**
   * Anyone. Pays what write-offs seized in one asset to the pool's lender, who carried the loss;
   * the caller is paid nothing. Refused before anything is sent when nothing in that asset waits.
   */
  async claimSeized(assetOrSymbol: string): Promise<Sent> {
    this.#requireObserves('Claiming seized collateral');
    const asset = this.resolve(assetOrSymbol);
    const waiting = await this.#client.readContract({
      address: this.lane.CollateralVault,
      abi: collateralVaultAbi,
      functionName: 'seized',
      args: [asset],
    });
    if (waiting === 0n) {
      const refusal = laneRefusal({ errorName: 'NothingSeized', args: [asset] }, 'vault', this.#context);
      throw new CallRefusedError('NothingSeized', refusal?.message ?? 'NothingSeized', {
        vault: this.lane.CollateralVault,
        asset,
        owner: refusal?.owner,
      });
    }
    return sendCall(this.mandate.connection, {
      to: this.lane.CollateralVault,
      data: encodeFunctionData({ abi: collateralVaultAbi, functionName: 'claimSeized', args: [asset] }),
      action: 'claimSeized',
      explain: this.#explain('vault'),
    });
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
          explain: this.#explain('vault'),
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
    if (isAddressEqual(current, this.lane.CollateralVault)) return undefined;
    return sendCall(this.mandate.connection, {
      to: this.mandate.address,
      data: encodeFunctionData({
        abi: mandateAccountAbi,
        functionName: 'setTreasuryPark',
        args: [this.lane.CollateralVault],
      }),
      action: 'setTreasuryPark',
      explain: this.#explain('vault'),
    });
  }

  /** Posts `raw` token units from the signer to this mandate's line. Approves the vault first when needed. */
  async deposit(assetOrSymbol: string, raw: bigint): Promise<{ approve?: Sent; deposit: Sent }> {
    const asset = this.resolve(assetOrSymbol);
    if (raw <= 0n) throw new BursarError('collateral_amount_invalid', 'A deposit must move a positive amount.', { raw });
    await this.#requireCollateralLane();
    const approve = await approveIfShort(this.mandate.connection, {
      token: asset,
      spender: this.lane.CollateralVault,
      amount: raw,
      action: 'deposit',
    });
    const deposit = await sendCall(this.mandate.connection, {
      to: this.lane.CollateralVault,
      data: encodeFunctionData({
        abi: collateralVaultAbi,
        functionName: 'deposit',
        args: [this.mandate.address, asset, raw],
      }),
      action: 'deposit',
      explain: this.#explain('vault'),
    });
    return { ...(approve ? { approve } : {}), deposit };
  }

  /**
   * Principal only. Takes collateral back; refused if what stays would not carry the debt with every
   * position at its after-hours haircut.
   */
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
      explain: this.#explain('vault'),
    });
  }

  /**
   * Pays down the mandate's debt from the signer's USDG. Without an amount it pays the whole debt,
   * offering a small margin for spread accrued before the transaction lands; the pool takes no
   * more than is owed, and `amount` is what it took.
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
    const approve = await approveIfShort(this.mandate.connection, {
      token: usdg,
      spender: this.lane.CreditPool,
      amount: value,
      action: 'repay',
    });
    const repay = await sendCall(this.mandate.connection, {
      to: this.lane.CreditPool,
      data: encodeFunctionData({ abi: creditPoolAbi, functionName: 'repay', args: [this.mandate.address, value] }),
      action: 'repay',
      explain: this.#explain('repay'),
    });
    const [repaid] = parseEventLogs({
      abi: creditPoolAbi,
      eventName: 'Repaid',
      logs: logsFrom(repay.receipt.logs, this.lane.CreditPool),
    });
    return { ...(approve ? { approve } : {}), repay, amount: micro(repaid?.args.amount ?? value) };
  }

  /**
   * Anyone. Sells the slice of `asset` that restores health, through the asset's pinned pool, for a
   * bounty. The sale needs a fresh, unpaused price with the pool inside its band before and after the
   * trade; otherwise it reverts and the sale waits for the price. A line with nothing left to sell
   * has its debt written off instead.
   */
  async liquidate(assetOrSymbol: string): Promise<Sent> {
    return sendCall(this.mandate.connection, {
      to: this.lane.CollateralVault,
      data: encodeFunctionData({
        abi: collateralVaultAbi,
        functionName: 'liquidate',
        args: [this.mandate.address, this.resolve(assetOrSymbol)],
      }),
      action: 'liquidate',
      explain: this.#explain('vault'),
    });
  }

  resolve(assetOrSymbol: string): Address {
    if (assetOrSymbol.startsWith('0x')) return checkAddress('asset', assetOrSymbol as Address);
    const known = this.rwa?.assets ?? [];
    const found = known.find((a) => a.symbol.toUpperCase() === assetOrSymbol.toUpperCase());
    if (found === undefined) throw new UnknownAssetError(assetOrSymbol, known.map((a) => a.symbol));
    return found.address;
  }

  /**
   * A vault call refused on health is read against the vault's draw rule first, so a withdrawal
   * the vault refused because a position counted for nothing names that position and the condition
   * it fails, rather than the general rule.
   */
  #explain(call: 'vault' | 'repay'): ExplainRevert {
    const details = { mandate: this.mandate.address, vault: this.lane.CollateralVault, pool: this.lane.CreditPool };
    const lane = explainLane(call, this.#context, details);
    if (call !== 'vault' || !this.#observes) return lane;

    return async (revert, error) => {
      if (!revert) return undefined;
      const bound = await boundDraw(revert, { client: this.#client, vault: this.lane.CollateralVault, mandate: this.mandate.address });
      return lane(bound, error);
    };
  }

  async #lane(): Promise<number> {
    return this.#client.readContract({ address: this.mandate.address, abi: mandateAccountAbi, functionName: 'lane' });
  }

  async #requireCollateralLane(): Promise<void> {
    const lane = await this.#lane();
    if (lane !== COLLATERAL_LANE) throw new NotCollateralLaneError(this.mandate.address, lane);
  }

}

export function collateral(mandate: MandateAccountClient, lane?: CollateralLane): CollateralClient {
  return new CollateralClient(mandate, lane);
}
