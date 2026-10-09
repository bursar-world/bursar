import {
  COLLATERAL_LANE,
  collateralVaultAbi,
  creditPoolAbi,
  healthRatio,
  mandateAccountAbi,
  viemChain,
} from '@bursar/core';
import type { CollateralDeployment, RhcChain, RhcPublicClient, RwaDeployment } from '@bursar/core';
import { BaseError, ContractFunctionRevertedError, createWalletClient, custom, encodeFunctionData, erc20Abi } from 'viem';
import type { Address, Hex, WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ToolError } from './errors.js';
import { fromUint, instant, money, moneyFromUint } from './format.js';
import type { MoneyView } from './types.js';
import { refusalForName, refusalForSelector } from './reasons.js';
import type { ObjectSchema } from './schema.js';

/** Covers spread accrued between reading the debt and the repayment landing. */
const REPAY_MARGIN = 100n;

export type CollateralTierView = {
  readonly tier: number;
  readonly name: string;
  readonly sessionHaircutBps: number;
  readonly afterHoursHaircutBps: number;
};

export type CollateralPositionView = {
  readonly symbol: string;
  readonly asset: Address;
  readonly tier: number;
  readonly raw: string;
  readonly referencePrice: string;
  readonly priceUpdatedAt: string;
  readonly fresh: boolean;
  readonly haircutBps: number;
  readonly value: MoneyView;
  readonly afterHaircut: MoneyView;
};

export type CollateralView = {
  readonly mandate: Address;
  readonly lane: 'collateral' | 'other';
  readonly lineOpen: boolean;
  readonly inSession: boolean;
  readonly value: MoneyView;
  readonly afterHaircut: MoneyView;
  readonly debt: MoneyView;
  readonly headroom: MoneyView;
  /** Null when nothing is owed. */
  readonly health: number | null;
  readonly positions: readonly CollateralPositionView[];
  readonly tiers: readonly CollateralTierView[];
  readonly next: string;
};

export type CollateralTxView = {
  readonly txHash: Hex;
  readonly approveTxHash?: Hex;
  readonly amount: string;
  readonly debtAfter: MoneyView;
  readonly healthAfter: number | null;
  readonly next: string;
};

export type CollateralGateway = {
  /** Whether this server holds a key that can send the writes. */
  readonly canWrite: boolean;
  read(): Promise<CollateralView>;
  deposit(order: { asset: string; raw: bigint }): Promise<CollateralTxView>;
  repay(order: { amount: bigint | null }): Promise<CollateralTxView>;
};

export type CollateralGatewayOptions = {
  readonly client: RhcPublicClient;
  readonly chain: RhcChain;
  readonly account: Address;
  /** The local signer's key. Null with a relay or no signer: the lane's writes need a key held here. */
  readonly key: Hex | null;
  /**
   * The RWA lane of the record this server reads. Its collateral part names the vault and the credit
   * pool, and its asset list is what a symbol resolves through.
   */
  readonly rwa: RwaDeployment | null;
  /** What the credit pool lends and takes back in repayment. */
  readonly settlementAsset: Address;
};

/** Null when the record this server reads has no collateral lane. */
export function createCollateralGateway(options: CollateralGatewayOptions): CollateralGateway | null {
  const { rwa } = options;
  if (rwa?.collateral === undefined) return null;
  return gatewayFor(options, rwa.collateral, rwa);
}

function gatewayFor(options: CollateralGatewayOptions, lane: CollateralDeployment, rwa: RwaDeployment): CollateralGateway {
  const { client, account } = options;
  const vault = lane.CollateralVault;
  const signer = options.key === null ? null : privateKeyToAccount(options.key);
  const wallet: WalletClient | null =
    signer === null
      ? null
      : createWalletClient({
          account: signer,
          chain: viemChain(options.chain),
          transport: custom({ request: client.request }, { retryCount: 0 }),
        });

  const symbolOf = (address: Address): string =>
    rwa.assets.find((a) => a.address.toLowerCase() === address.toLowerCase())?.symbol ?? address;

  function resolve(asset: string): Address {
    const wanted = asset.toLowerCase();
    const found = rwa.assets.find((a) => a.symbol.toLowerCase() === wanted || a.address.toLowerCase() === wanted);
    if (found === undefined) {
      throw new ToolError(
        'invalid_arguments',
        `${asset} is not a registered asset. Registered: ${rwa.assets.map((a) => a.symbol).join(', ')}.`,
      );
    }
    return found.address;
  }

  async function laneOf(): Promise<number> {
    return client.readContract({ address: account, abi: mandateAccountAbi, functionName: 'lane' });
  }

  async function requireCollateralLane(): Promise<void> {
    const current = await laneOf();
    if (current !== COLLATERAL_LANE) {
      throw new ToolError(
        'mandate_refused',
        `This mandate is in lane ${current}, and only lane 1 carries collateral-backed credit, so it cannot ` +
          'borrow or post collateral. Prefunded mandates spend only what they hold.',
        { revert: 'NotCollateralLane', subject: 'mandate' },
      );
    }
  }

  async function standing(): Promise<{ debt: bigint; health: number | null }> {
    const [, , debt, , healthE18] = await client.readContract({
      address: vault,
      abi: collateralVaultAbi,
      functionName: 'account',
      args: [account],
    });
    return { debt, health: healthRatio(healthE18) };
  }

  function writer(action: string): { wallet: WalletClient; signer: NonNullable<typeof signer> } {
    if (wallet === null || signer === null) {
      throw new ToolError(
        'relay_unconfigured',
        `${action} is sent from the key this server holds, and the relay has no collateral route. Set ` +
          'BURSAR_SIGNER=local with the principal or agent key, then restart it.',
      );
    }
    return { wallet, signer };
  }

  async function send(to: Address, data: Hex, action: string): Promise<Hex> {
    const { wallet, signer } = writer(action);
    try {
      await client.call({ account: signer, to, data });
      const hash = await wallet.sendTransaction({ account: signer, chain: viemChain(options.chain), to, data });
      const receipt = await client.waitForTransactionReceipt({ hash }).catch(() => {
        // Sent: a receipt that could not be read says nothing about whether it landed.
        throw new ToolError(
          'signer_unconfirmed',
          `The ${action} was signed and submitted as ${hash}, and its receipt could not be read. It may have ` +
            'landed. Look the transaction up before sending it again.',
          { txHash: hash },
        );
      });
      if (receipt.status !== 'success') throw new ToolError('call_failed', `${action} reverted on chain in ${hash}.`);
      return hash;
    } catch (error) {
      throw refused(error);
    }
  }

  async function approve(token: Address, spender: Address, amount: bigint): Promise<Hex | undefined> {
    const owner = writer('approve').signer.address;
    const allowance = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    });
    if (allowance >= amount) return undefined;
    return send(token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }), 'approve');
  }

  async function read(): Promise<CollateralView> {
    const block = await client.getBlock({ blockTag: 'latest' });
    const [[value, adjusted, debt, headroom, healthE18], positions, lineOpen, current, tiers, inSession] =
      await Promise.all([
        client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'account', args: [account] }),
        client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'positions', args: [account] }),
        client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'isLine', args: [account] }),
        laneOf(),
        client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'tiers' }),
        client.readContract({
          address: vault,
          abi: collateralVaultAbi,
          functionName: 'inSession',
          args: [block.timestamp],
        }),
      ]);
    const health = healthRatio(healthE18);
    const isCollateral = current === COLLATERAL_LANE;
    const uncounted = positions.filter((p) => p.raw > 0n && !p.fresh).map((p) => symbolOf(p.asset));
    return {
      mandate: account,
      lane: isCollateral ? 'collateral' : 'other',
      lineOpen,
      inSession,
      value: moneyFromUint(value),
      afterHaircut: moneyFromUint(adjusted),
      debt: moneyFromUint(debt),
      headroom: moneyFromUint(headroom),
      health,
      positions: positions
        .filter((p) => p.raw > 0n)
        .map((p) => ({
          symbol: symbolOf(p.asset),
          asset: p.asset,
          tier: p.tier,
          raw: p.raw.toString(),
          referencePrice: (Number(p.priceE8) / 1e8).toFixed(2),
          priceUpdatedAt: instant(p.updatedAt),
          fresh: p.fresh,
          haircutBps: p.haircutBps,
          value: moneyFromUint(p.value),
          afterHaircut: moneyFromUint(p.adjusted),
        })),
      tiers: tiers.map((t, i) => ({
        tier: i + 1,
        name: t.name,
        sessionHaircutBps: t.sessionHaircutBps,
        afterHoursHaircutBps: t.afterHoursHaircutBps,
      })),
      next: !isCollateral
        ? 'This mandate was not created for collateral-backed credit and cannot borrow. It spends what it holds.'
        : !lineOpen
          ? 'The principal has not opened a collateral line for this mandate yet.'
          : uncountedNote(uncounted) + standingNote(health, headroom),
    };
  }

  async function deposit(order: { asset: string; raw: bigint }): Promise<CollateralTxView> {
    const asset = resolve(order.asset);
    writer('deposit');
    await requireCollateralLane();
    const approveTxHash = await approve(asset, vault, order.raw);
    const txHash = await send(
      vault,
      encodeFunctionData({ abi: collateralVaultAbi, functionName: 'deposit', args: [account, asset, order.raw] }),
      'deposit',
    );
    const after = await standing();
    return {
      txHash,
      ...(approveTxHash === undefined ? {} : { approveTxHash }),
      amount: order.raw.toString(),
      debtAfter: moneyFromUint(after.debt),
      healthAfter: after.health,
      next: `Posted ${order.raw} raw ${symbolOf(asset)} as collateral for this mandate. Read mandate_collateral for the new headroom.`,
    };
  }

  async function repay(order: { amount: bigint | null }): Promise<CollateralTxView> {
    writer('repay');
    let amount = order.amount;
    if (amount === null) {
      const { debt } = await standing();
      if (debt === 0n) {
        throw new ToolError('mandate_refused', 'This mandate owes nothing, so there is nothing to repay.', {
          revert: 'NoDebt',
          subject: 'amount',
        });
      }
      amount = debt + REPAY_MARGIN;
    }
    const approveTxHash = await approve(options.settlementAsset, lane.CreditPool, amount);
    const txHash = await send(
      lane.CreditPool,
      encodeFunctionData({ abi: creditPoolAbi, functionName: 'repay', args: [account, amount] }),
      'repay',
    );
    const after = await standing();
    return {
      txHash,
      ...(approveTxHash === undefined ? {} : { approveTxHash }),
      amount: money(fromUint(amount)).usdg,
      debtAfter: moneyFromUint(after.debt),
      healthAfter: after.health,
      next:
        after.debt === 0n
          ? 'The debt is repaid. The pool took only what was owed.'
          : `The mandate still owes ${moneyFromUint(after.debt).usdg} USDG.`,
    };
  }

  return { canWrite: wallet !== null, read, deposit, repay };
}

function formatHeadroom(micro: bigint): string {
  return moneyFromUint(micro).usdg;
}

/** A posted position that counts for nothing right now, named, because the figures above leave it out. */
function uncountedNote(symbols: readonly string[]): string {
  if (symbols.length === 0) return '';
  return (
    `${symbols.join(' and ')} ${symbols.length === 1 ? 'counts' : 'count'} for nothing right now: the price is ` +
    "stale, the token, its oracle or Robinhood's access registry is paused, or its trading pool is out of line " +
    'with its reference price. '
  );
}

/**
 * Draws are measured with every position at its after-hours haircut, whatever the clock says, so the
 * room to draw can sit below what health suggests during the session. Health is the liquidation
 * trigger and uses the haircut that applies now.
 */
function standingNote(health: number | null, headroom: bigint): string {
  if (health === null) {
    return (
      `Nothing is owed. A spend the mandate's USDG cannot cover draws up to ${formatHeadroom(headroom)} USDG on ` +
      'credit, measured with every position at its after-hours haircut.'
    );
  }
  return (
    `Health ${health.toFixed(4)}. A draw has to leave it at or above 1.25 with every position at its ` +
    `after-hours haircut, which leaves ${formatHeadroom(headroom)} USDG to draw now. Below 1.0 anyone can ` +
    'sell part of the collateral to repay, once its price is fresh and its trading pool agrees with it; ' +
    'until then the sale waits. Repay with mandate_collateral_repay.'
  );
}

/** Names a vault, pool or guard revert with the sentence this server holds for it. */
function refused(error: unknown): unknown {
  if (!(error instanceof BaseError)) return error;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  const name = reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
  const refusal = name === undefined ? selectorRefusal(error) : refusalForName(name);
  if (refusal === null) return error;
  return new ToolError('mandate_refused', refusal.message, { revert: refusal.code, subject: refusal.subject });
}

/** A raw call carries only the revert data; the selector is enough to name it. */
function selectorRefusal(error: BaseError): ReturnType<typeof refusalForSelector> {
  const holder = error.walk((e) => typeof (e as { data?: unknown }).data === 'string') as { data?: string } | null;
  const data = holder?.data;
  if (typeof data !== 'string' || data.length < 10) return null;
  const found = refusalForSelector(data.slice(0, 10) as Hex);
  return found === null || found.code.startsWith('0x') ? null : found;
}

const ASSET_PROPERTY = {
  type: 'string',
  description: 'The token to post, by symbol ("SGOV", "SPY", "NVDA", "AAPL") or token address.',
  pattern: '^(?:[A-Za-z]{1,10}|0x[0-9a-fA-F]{40})$',
  patternMessage: 'asset must be a ticker symbol or a 0x address',
} as const;

export const COLLATERAL_TOOLS: readonly {
  readonly name: string;
  readonly writes: boolean;
  readonly description: string;
  readonly inputSchema: ObjectSchema;
}[] = [
  {
    name: 'mandate_collateral',
    writes: false,
    description:
      "Read this mandate's collateral-backed credit: the stock and treasury tokens posted, what they count " +
      'for after the haircut, the debt, how much more it can draw, and its health (after-haircut collateral ' +
      'over debt; null when nothing is owed). How much more it can draw is measured with every position at ' +
      'its after-hours haircut, whatever the time. A position counts for nothing while its price is stale, ' +
      "its token, its oracle or Robinhood's access registry is paused, or its trading pool is out of line " +
      'with its reference price. Also lists the published haircut tiers and whether the US market session ' +
      'is open, since the after-hours haircut is wider. Nothing is spent.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mandate_collateral_deposit',
    writes: true,
    description:
      'Post a registered stock or treasury token from this server\'s key as collateral for the mandate. The ' +
      'mandate has to be one created for collateral-backed credit, with a line open. The amount is in raw ' +
      'token units (18 decimals for the Robinhood tokens).',
    inputSchema: {
      type: 'object',
      required: ['asset', 'raw'],
      properties: {
        asset: ASSET_PROPERTY,
        raw: {
          type: 'string',
          description: 'Raw token units, digits only: "1000000000000000000" is one whole token.',
          pattern: '^[1-9][0-9]*$',
          patternMessage: 'raw must be a positive whole number of raw token units',
        },
      },
    },
  },
  {
    name: 'mandate_collateral_repay',
    writes: true,
    description:
      "Repay the mandate's credit from this server's key in USDG. Leave out the amount to repay all of it; " +
      'the pool takes no more than is owed.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: {
          type: 'string',
          description: 'USDG in six-decimal atomic units, digits only: "20000" is 0.02 USDG.',
          pattern: '^[1-9][0-9]*$',
          patternMessage: 'amount must be USDG in six-decimal atomic units, digits only',
        },
      },
    },
  },
];

export const COLLATERAL_HANDLERS: Readonly<
  Record<string, (gateway: CollateralGateway, args: Record<string, unknown>) => Promise<unknown>>
> = {
  mandate_collateral: (gateway) => gateway.read(),
  mandate_collateral_deposit: (gateway, args) =>
    gateway.deposit({ asset: String(args['asset']), raw: BigInt(String(args['raw'])) }),
  mandate_collateral_repay: (gateway, args) =>
    gateway.repay({ amount: args['amount'] === undefined ? null : BigInt(String(args['amount'])) }),
};
