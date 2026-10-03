/**
 * What the stock, treasury and collateral lanes say no for, in sentences.
 *
 * One table per contract, keyed by the error names in its deployed ABI, so an error added to any of
 * them is a compile error here until someone writes its sentence. The same names recur across the
 * lane because the contracts share code: every swap can raise the same four, and the park and the
 * credit pool both call a figure over its limit `MandateCapExceeded`. Which contract raised a name
 * follows from the call it came back from, so each call reads the tables in an order of its own.
 *
 * A sentence quotes the figures the revert carried. A revert that arrived as a bare selector gets
 * the same sentence without them.
 */

import type { Address, Chain, PublicClient, Transport } from 'viem';
import {
  DRAW_HALTS,
  assetRegistryAbi,
  collateralVaultAbi,
  creditPoolAbi,
  drawHaltOf,
  mandateAccountAbi,
  parkAdapterAbi,
  priceGuardAbi,
  stockSpendRouterAbi,
  treasuryParkAbi,
} from '@bursar/core';
import type { DrawHalt } from '@bursar/core';

import { formatDuration, usd } from './format.js';
import { micro } from './money.js';
import type { Refusal, RefusalOwner } from './refusals.js';
import type { RevertInfo, TokenErrorName } from './revert.js';

type ErrorName<A extends readonly unknown[]> = Extract<A[number], { type: 'error'; name: string }>['name'];

type Figures = readonly unknown[];

export type LaneContext = {
  /** A token's symbol where the lane lists it, and its address where it does not. */
  readonly symbolOf: (token: Address) => string;
};

type Reading = {
  readonly owner: RefusalOwner;
  readonly message: string | ((figures: Figures, context: LaneContext) => string);
};

type Table = Readonly<Record<string, Reading>>;

function bigintAt(figures: Figures, index: number): bigint | undefined {
  const value = figures[index];
  return typeof value === 'bigint' ? value : undefined;
}

function addressAt(figures: Figures, index: number): Address | undefined {
  const value = figures[index];
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/u.test(value) ? (value as Address) : undefined;
}

function usdAt(figures: Figures, index: number): string | undefined {
  const value = bigintAt(figures, index);
  return value === undefined ? undefined : usd(micro(value));
}

/** A feed price, eight decimals, to the cent. */
function priceAt(figures: Figures, index: number): string | undefined {
  const value = bigintAt(figures, index);
  if (value === undefined) return undefined;
  const cents = value / 1_000_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')} USD`;
}

/** A health figure, where 1e18 is 1.0, to two places. */
function ratioAt(figures: Figures, index: number): string | undefined {
  const value = bigintAt(figures, index);
  if (value === undefined) return undefined;
  const hundredths = value / 10n ** 16n;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

function ageAt(figures: Figures, index: number): string | undefined {
  const value = bigintAt(figures, index);
  return value === undefined ? undefined : formatDuration(value);
}

function rawAt(figures: Figures, index: number): string | undefined {
  return bigintAt(figures, index)?.toString();
}

/** Basis points as a percentage, to the hundredth where it has one. */
function percentAt(figures: Figures, index: number): string | undefined {
  const value = bigintAt(figures, index);
  if (value === undefined) return undefined;
  const hundredths = (value % 100n).toString().padStart(2, '0').replace(/0+$/u, '');
  return `${value / 100n}${hundredths === '' ? '' : `.${hundredths}`}%`;
}

function tokenAt(figures: Figures, index: number, context: LaneContext, otherwise = 'This asset'): string {
  const token = addressAt(figures, index);
  return token === undefined ? otherwise : context.symbolOf(token);
}

function mandateAt(figures: Figures, index: number): string {
  const mandate = addressAt(figures, index);
  return mandate === undefined ? 'This mandate' : `Mandate ${mandate}`;
}

/** The sentence with the revert's figures in it when every one arrived, and the plain one when not. */
function figured(
  values: readonly (string | undefined)[],
  render: (values: readonly string[]) => string,
  plain: string,
): string {
  return values.every((value) => value !== undefined) ? render(values as readonly string[]) : plain;
}

const REENTRY: Reading = {
  owner: 'counterparty',
  message:
    'Something called back into the lane while one of its own calls was still running, and it refuses ' +
    'that. Nothing settled. The contract that called in owns this: report it with the transaction.',
};

const GOVERNANCE_ONLY: Reading = {
  owner: 'governance',
  message:
    'This is a governance call. The lane is administered by the timelock, and a change goes through a ' +
    'proposal with a delay on it.',
};

const PENDING_ADMIN: Reading = {
  owner: 'governance',
  message: 'Only the address the current admin named can accept the role.',
};

const TOKEN_REFUSED: Reading = {
  owner: 'token',
  message: (figures, context) =>
    `${tokenAt(figures, 0, context, 'The token')} refused a transfer this call needed, so nothing moved. An ` +
    'allowance or a balance short of the amount, a token its issuer has paused and an address it has ' +
    'frozen all come back this way. Check the allowance and the balance first; if both cover it, the ' +
    'refusal is the issuer’s and a retry will not clear it.',
};

const NOT_ELIGIBLE: Reading = {
  owner: 'governance',
  message: (figures, context) =>
    `${tokenAt(figures, 0, context)} is marked not eligible in the asset registry, so it cannot be bought, ` +
    'parked or posted as collateral. Governance sets eligibility. A position already held can still be ' +
    'sold, and still counts at its price.',
};

const NOT_FROM_FACTORY: Reading = {
  owner: 'caller',
  message: (figures) =>
    `${mandateAt(figures, 0)} was not created by a factory this lane knows, so it cannot park funds or ` +
    'open a credit line. The lane admits only accounts from its own deployment, because they share its ' +
    'caps. Create the mandate with createMandate on the same deployment.',
};

/** Every contract that trades through the pinned pools raises these four. */
const SWAP = {
  NotPoolManager: {
    owner: 'deployment',
    message:
      'A contract other than the pool manager this lane was built with called back into it to settle a ' +
      'swap, and the lane refused it. Nothing moved. Report the transaction to the operator: no caller ' +
      'can change which pool manager the lane trusts.',
  },
  NotUnlocking: {
    owner: 'deployment',
    message:
      'The pool manager called back into the lane when no swap of its own was under way, and the lane ' +
      'refused it. Nothing moved. Report the transaction to the operator.',
  },
  SwapShort: {
    owner: 'clock',
    message:
      'The pool could not fill this trade at a price the lane accepts. Either the fill came in under the ' +
      'feed price less the allowed slippage, or the pool ran out of depth part way through. Nothing ' +
      'moved. Try a smaller amount, or try again once the pool is back in line with the feed.',
  },
  SettlementShort: {
    owner: 'token',
    message:
      'The token delivered less to the pool manager than the swap owed it, as a token that takes a fee ' +
      'on transfer does, so the trade was undone. Nothing moved. Report the asset to the operator: the ' +
      'lane cannot trade it while it behaves this way.',
  },
} satisfies Record<string, Reading>;

const ROUTER: Readonly<Record<ErrorName<typeof stockSpendRouterAbi>, Reading>> = {
  AssetNotAllowed: {
    owner: 'caller',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} is not on this mandate’s purchase list, and a mandate buys only ` +
      'what its principal has listed. The principal adds it with setPolicy, under allow. Nothing was bought.',
  },
  BadSlippage: {
    owner: 'caller',
    message:
      'A slippage limit is a count of basis points under 10000, where 0 means each asset’s own band, and ' +
      'every asset named needs a flag of its own. The policy in force is unchanged.',
  },
  NotAStock: {
    owner: 'caller',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} is a treasury fund. A mandate parks it with park() and buys only ` +
      'the stocks the registry lists. Nothing was bought.',
  },
  NotPrincipal: {
    owner: 'caller',
    message:
      'Only the mandate’s principal sets which stocks it may buy and the slippage it accepts. Send ' +
      'setPolicy from the principal’s key. The policy in force is unchanged.',
  },
  SafeERC20FailedOperation: {
    owner: 'token',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context, 'The settlement asset')} refused to move this purchase out of the ` +
      'mandate, so nothing was bought. A token its issuer has paused and an address it has frozen both ' +
      'come back this way. If the mandate holds the USDG, the refusal is the issuer’s and a retry will ' +
      'not clear it.',
  },
  TradeCapExceeded: {
    owner: 'caller',
    message: (figures) =>
      figured(
        [usdAt(figures, 0), usdAt(figures, 1)],
        ([amount, cap]) =>
          `This purchase of ${amount} is over the ${cap} the registry allows in one trade of this stock.`,
        'This purchase is over the most the registry allows in one trade of this stock.',
      ) +
      ' The cap is per trade: buy less in one call, and several purchases inside it can go through ' +
      'within the mandate’s own limits.',
  },
  ReentrancyGuardReentrantCall: REENTRY,
  ...SWAP,
};

const GUARD: Readonly<Record<ErrorName<typeof priceGuardAbi>, Reading>> = {
  AccessPaused: {
    owner: 'token',
    message:
      'Robinhood’s access registry is paused, so no stock token trades or moves until it resumes. ' +
      'Nothing was sent, and no mandate setting changes this.',
  },
  BadObservationBounds: {
    owner: 'deployment',
    message:
      'The price guard’s observation bounds do not hold together: the minimum age has to be above zero, ' +
      'the maximum at least twice the minimum and at most a day, and the feed jump limit above zero and ' +
      'under 100%. The guard checks them once, when it is deployed, so nothing a caller sends reaches this. ' +
      'Report it to the operator.',
  },
  BadPrice: {
    owner: 'token',
    message: (figures, context) =>
      `The price feed for ${tokenAt(figures, 0, context, 'this asset')} returned no usable answer: zero, ` +
      'negative, or dated ahead of the chain. Nothing trades on it until the feed publishes a sound price.',
  },
  Blocked: {
    owner: 'token',
    message: (figures) =>
      `Robinhood’s access registry blocks ${addressAt(figures, 0) ?? 'this account'}, so it cannot trade ` +
      'or hold the lane’s tokens. Only Robinhood lifts a block; no mandate setting changes it.',
  },
  NotEligible: NOT_ELIGIBLE,
  NotKeeper: {
    owner: 'deployment',
    message:
      'Only a keeper the price guard’s governance named may record a reading of a pool. Readings are taken ' +
      'by the keeper service every few minutes; nothing a mandate sends changes that.',
  },
  NotAdmin: GOVERNANCE_ONLY,
  NotPendingAdmin: PENDING_ADMIN,
  NotDeployer: {
    owner: 'deployment',
    message:
      'The price guard’s first keeper is named once, by the key that deployed it, and that has been done. ' +
      'Governance names any further keeper.',
  },
  OraclePaused: {
    owner: 'token',
    message: (figures, context) =>
      `The issuer has paused the price oracle for ${tokenAt(figures, 0, context, 'this asset')}, so it ` +
      'cannot be traded until the oracle resumes. While it is paused, a position in it counts for ' +
      'nothing toward spending power or collateral.',
  },
  PoolPriceDeviation: {
    owner: 'clock',
    message: (figures, context) =>
      figured(
        [priceAt(figures, 1), priceAt(figures, 2)],
        ([pool, feed]) =>
          `The ${tokenAt(figures, 0, context, 'asset’s')} pool trades at ${pool} and its feed reads ${feed}, ` +
          'further apart than the asset’s band allows.',
        `The ${tokenAt(figures, 0, context, 'asset’s')} pool and its feed are further apart than the ` +
          'asset’s band allows.',
      ) +
      ' Nothing trades in it until the two agree again. A trade large enough to push the pool out of ' +
      'its band is refused the same way, so a smaller amount may go through.',
  },
  PriceOutsideBand: {
    owner: 'caller',
    message: (figures, context) =>
      figured(
        [priceAt(figures, 1), priceAt(figures, 2)],
        ([quoted, feed]) =>
          `This purchase was quoted at ${quoted} and the ${tokenAt(figures, 0, context, 'asset')} feed now ` +
          `reads ${feed}, further apart than the asset’s band allows.`,
        'The price this purchase was quoted at is further from the feed than the asset’s band allows.',
      ) + ' The feed moved between the quote and the send. Quote again and retry.',
  },
  StalePrice: {
    owner: 'clock',
    message: (figures, context) =>
      figured(
        [ageAt(figures, 1), ageAt(figures, 2)],
        ([age, bound]) =>
          `The ${tokenAt(figures, 0, context, 'asset')} feed last answered ${age} ago, and a trade needs ` +
          `an answer no older than ${bound}.`,
        `The ${tokenAt(figures, 0, context, 'asset')} feed has not answered recently enough to trade on.`,
      ) +
      ' Equity feeds go quiet at weekends and on market holidays. The trade can go through once the ' +
      'feed publishes again.',
  },
  TokenPaused: {
    owner: 'token',
    message: (figures, context) =>
      `The issuer has paused transfers of ${tokenAt(figures, 0, context, 'this asset')}, so it cannot be ` +
      'traded until they resume.',
  },
};

const ASSETS: Readonly<Record<ErrorName<typeof assetRegistryAbi>, Reading>> = {
  BadBounds: {
    owner: 'governance',
    message:
      'The proposed asset terms do not hold together: the trade and valuation bounds, the band, the ' +
      'haircuts or the caps are out of range. The terms in force are unchanged.',
  },
  BadPool: {
    owner: 'governance',
    message:
      'The pool named for the asset does not pair it with USDG, or it carries a hook, and the registry ' +
      'takes only a hookless pool between the asset and USDG. The terms in force are unchanged.',
  },
  FeedNot8Decimals: {
    owner: 'governance',
    message:
      'The feed named for the asset does not answer in eight decimals, which every price in the lane ' +
      'assumes. The terms in force are unchanged.',
  },
  NotAdmin: GOVERNANCE_ONLY,
  NotPendingAdmin: PENDING_ADMIN,
  NotRegistered: {
    owner: 'caller',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} is not in the asset registry, so no contract in the lane will ` +
      'trade, park or value it. The registry is keyed on the token address, and a token with the same ' +
      'name or symbol at another address is a different token.',
  },
  ZeroAddress: {
    owner: 'governance',
    message:
      'The registry was given the zero address where it needs a token or a feed. The terms in force are ' +
      'unchanged.',
  },
};

const PARK: Readonly<Record<ErrorName<typeof treasuryParkAbi>, Reading>> = {
  ZeroAddress: {
    owner: 'deployment',
    message:
      'The park was given the zero address where it needs USDG or an admin, or an adapter was given the ' +
      'zero address for its park. Nothing can be built on it.',
  },
  BelowBuffer: {
    owner: 'caller',
    message: (figures) =>
      figured(
        [usdAt(figures, 0), usdAt(figures, 1)],
        ([held, buffer]) =>
          `After this move the mandate holds ${held}, under the ${buffer} its principal set to keep liquid.`,
        'After this move the mandate holds less USDG than its principal set it to keep liquid.',
      ) + ' Nothing was parked. Park less, or lower the buffer with setBuffer.',
  },
  MandateCapExceeded: {
    owner: 'caller',
    message: (figures) =>
      figured(
        [usdAt(figures, 0), usdAt(figures, 1)],
        ([basis, cap]) =>
          `Parking this would bring what the mandate holds in the fund to ${basis}, over the ${cap} one ` +
          'mandate may park there.',
        'Parking this would take the mandate over the most one mandate may park in the fund.',
      ) + ' Park less, or unpark first.',
  },
  NotAdmin: GOVERNANCE_ONLY,
  NotDeployer: {
    owner: 'deployment',
    message: 'Only the address that deployed the park lists its first adapters, and it does that once.',
  },
  NotFactoryAccount: NOT_FROM_FACTORY,
  NotOperator: {
    owner: 'caller',
    message:
      'Only the mandate’s principal or its agent can park, unpark or bring back its idle USDG. Send ' +
      'this from one of those keys.',
  },
  NotPendingAdmin: PENDING_ADMIN,
  NotPrincipal: {
    owner: 'caller',
    message:
      'Only the mandate’s principal sets how much USDG it keeps liquid. Send setBuffer from the ' +
      'principal’s key.',
  },
  NothingToUnpark: {
    owner: 'caller',
    message: (figures) =>
      figured(
        [usdAt(figures, 0)],
        ([short]) => `The mandate is ${short} short for this payment,`,
        'The mandate is short for this payment,',
      ) +
      ' and none of its parked positions could be sold to cover it: each was empty, priced stale, ' +
      'paused, or trading outside its band. Fund the mandate with USDG, or pay once the parked asset ' +
      'prices again.',
  },
  PositionShort: {
    owner: 'caller',
    message: (figures) =>
      figured(
        [rawAt(figures, 0), rawAt(figures, 1)],
        ([held, asked]) => `The position holds ${held} raw units and this asks to sell ${asked}.`,
        'The position holds fewer units than this asks to sell.',
      ) + ' Unpark at most what parked() reports for it.',
  },
  ReentrancyGuardReentrantCall: REENTRY,
  TotalCapExceeded: {
    owner: 'governance',
    message: (figures) =>
      figured(
        [usdAt(figures, 0), usdAt(figures, 1)],
        ([basis, cap]) =>
          `Parking this would bring everything parked in the fund, across every mandate, to ${basis}, ` +
          `over the ${cap} the lane takes in total.`,
        'Parking this would take the fund over the most the lane takes in total, across every mandate.',
      ) + ' Park less, or try again once others unpark.',
  },
  UnknownAdapter: {
    owner: 'governance',
    message: (figures) =>
      `The park takes no new money through ${addressAt(figures, 0) ?? 'that adapter'}: governance has ` +
      'disabled it, or never listed it. Money already parked through it can still be unparked.',
  },
  VaultShort: {
    owner: 'caller',
    message: (figures) =>
      figured(
        [usdAt(figures, 0), usdAt(figures, 1)],
        ([held, needed]) => `The mandate’s park vault holds ${held} and this park needs ${needed}.`,
        'The mandate’s park vault holds less USDG than this park needs.',
      ) +
      ' Nothing was parked. park() moves the USDG into the vault before it parks; a call made straight ' +
      'to the contract has to do the same.',
  },
  ZeroAmount: {
    owner: 'caller',
    message:
      'Parking or unparking zero is refused, and so is bringing back idle USDG from a vault that holds ' +
      'none. Name a positive amount.',
  },
};

const ADAPTER: Readonly<Record<ErrorName<typeof parkAdapterAbi>, Reading>> = {
  ZeroAddress: {
    owner: 'deployment',
    message:
      'The adapter was given the zero address where it needs its park or its asset. Nothing can be built ' +
      'on it.',
  },
  NotPark: {
    owner: 'deployment',
    message:
      'Only the treasury park moves money through its adapters, and a call straight to an adapter is ' +
      'refused. Go through the park.',
  },
  NotTreasuryAsset: {
    owner: 'deployment',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} is not registered as a treasury fund, so no park adapter can be ` +
      'built on it.',
  },
  SafeERC20FailedOperation: TOKEN_REFUSED,
  ...SWAP,
};

/** A condition a draw fails: every `DrawHalt` but `None`. */
type Halt = Exclude<DrawHalt, 'None'>;

/** The price guard's bounds on a reading of a pool, where a reader has them. */
export type ObservationBounds = {
  /** Seconds a reading ages before a draw counts it and before the next may replace it. */
  readonly minAge: bigint;
  /** Seconds past which an aged reading no longer vouches for its pool. */
  readonly maxAge: bigint;
  /** The widest move of the feed since the aged reading that a draw still counts, in basis points. */
  readonly maxFeedJumpBps: bigint;
};

/** A position a draw counts nothing for, and the first condition it fails. */
export type HaltedPosition = { readonly asset: Address; readonly halt: Halt };

/**
 * Why a draw counts nothing for a position, by the price guard's name for the first condition it
 * fails. No revert carries these: the vault answers one per asset from `drawHalt`, and a draw that
 * leaned on a position held out comes back as `HealthTooLow`. The figures are the asset and then
 * the guard's bounds, in the order `ObservationBounds` lists them.
 */
const DRAW_HALT: Readonly<Record<Halt, Reading>> = {
  NoPrice: {
    owner: 'token',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} counts for nothing toward a draw right now: its price feed has no ` +
      'usable answer. It counts again once the feed publishes a sound price.',
  },
  Paused: {
    owner: 'token',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} counts for nothing toward a draw while the token, its price oracle or ` +
      'Robinhood’s access registry is paused. It counts again when the pause lifts, and no mandate setting ' +
      'changes that.',
  },
  FeedStale: {
    owner: 'clock',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} counts for nothing toward a draw right now: its feed has not answered ` +
      'recently enough. Inside the equities session a draw needs an answer no older than the tier’s session ' +
      'bound, which is tighter than the bound a valuation uses. It counts again once the feed publishes.',
  },
  NoObservation: {
    owner: 'caller',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} counts for nothing toward a draw yet: the price guard holds no reading ` +
      'of its pool old enough to count. ' +
      figured(
        [ageAt(figures, 1)],
        ([wait]) =>
          `A draw needs the pool to have agreed with the feed at a reading taken at least ${wait} earlier. ` +
          `observe() records one, and a second call ${wait} later puts it in force.`,
        'A draw needs the pool to have agreed with the feed at an earlier reading. observe() records one, and ' +
          'a second call after the guard’s minimum age puts it in force.',
      ) +
      ' Anyone may send both.',
  },
  ObservationExpired: {
    owner: 'caller',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} counts for nothing toward a draw right now: ` +
      figured(
        [ageAt(figures, 2), ageAt(figures, 1)],
        ([longest, wait]) =>
          `the price guard’s reading of its pool is more than ${longest} old, which is as long as one vouches ` +
          `for a pool. observe() records a new one, and a second call ${wait} later puts it in force.`,
        'the price guard’s reading of its pool is older than one may be. observe() records a new one, and a ' +
          'second call after the guard’s minimum age puts it in force.',
      ) +
      ' Anyone may send both.',
  },
  ObservationOffBand: {
    owner: 'clock',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} counts for nothing toward a draw right now: at the price guard’s last ` +
      'reading its pool traded outside its band of the feed, or the feed had no answer. A reading taken with ' +
      'the two in line clears it once it has aged. observe() when the pool is back in its band, and again ' +
      figured([ageAt(figures, 1)], ([wait]) => `${wait} later.`, 'after the guard’s minimum age.'),
  },
  FeedJump: {
    owner: 'clock',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} counts for nothing toward a draw right now: ` +
      figured(
        [percentAt(figures, 3)],
        ([jump]) => `its feed has moved more than ${jump} since the price guard’s last reading of its pool.`,
        'its feed has moved further since the price guard’s last reading of its pool than the guard allows.',
      ) +
      ' The guard treats a move that size as a gap until a newer reading stands behind the price. observe(), ' +
      figured([ageAt(figures, 1)], ([wait]) => `and again ${wait} later,`, 'and again after the guard’s minimum age,') +
      ' replaces the reading.',
  },
  SpotOffBand: {
    owner: 'clock',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} counts for nothing toward a draw right now: its pool trades outside ` +
      'its band of the feed. It counts again once the two agree, and nothing a mandate sends changes that.',
  },
  Unreadable: {
    owner: 'token',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} counts for nothing toward a draw right now: its price cannot be read. ` +
      'Its feed, its token’s pause switches or its pool’s state did not answer, and the vault values a holding ' +
      'it cannot read at nothing rather than refusing the call. It counts again once they answer.',
  },
  PendingOffBand: {
    owner: 'clock',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} counts for nothing toward a draw right now: at the price check’s newest ` +
      'reading its pool was out of line with its price. It counts again once a reading taken with the two in ' +
      'line has aged, and nothing a mandate sends changes that.',
  },
};

function isHalt(value: unknown): value is Halt {
  return typeof value === 'string' && value !== 'None' && (DRAW_HALTS as readonly string[]).includes(value);
}

/** The positions a refused draw could not count, where the reading that bound it found any. */
function haltedAt(figures: Figures, index: number): readonly HaltedPosition[] {
  const value = figures[index];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is HaltedPosition =>
      typeof entry === 'object' && entry !== null && addressAt([entry.asset], 0) !== undefined && isHalt(entry.halt),
  );
}

function boundsAt(figures: Figures, index: number): ObservationBounds | undefined {
  const value = figures[index] as Partial<ObservationBounds> | undefined;
  return typeof value?.minAge === 'bigint' && typeof value.maxAge === 'bigint' && typeof value.maxFeedJumpBps === 'bigint'
    ? { minAge: value.minAge, maxAge: value.maxAge, maxFeedJumpBps: value.maxFeedJumpBps }
    : undefined;
}

function haltSentence(position: HaltedPosition, context: LaneContext, bounds: ObservationBounds | undefined): string {
  const { message } = DRAW_HALT[position.halt];
  const figures = [position.asset, bounds?.minAge, bounds?.maxAge, bounds?.maxFeedJumpBps];
  return typeof message === 'string' ? message : message(figures, context);
}

/** "SPY", "SPY and NVDA", "SGOV, SPY and NVDA". */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const VAULT: Readonly<Record<ErrorName<typeof collateralVaultAbi>, Reading>> = {
  BadParams: {
    owner: 'governance',
    message:
      'The proposed lending parameters do not hold together: the draw floor has to be at least 1.0, the ' +
      'liquidation target above 1.0 and no higher than the draw floor, and the bounty at most 10%. The ' +
      'parameters in force are unchanged.',
  },
  BadTier: {
    owner: 'governance',
    message:
      'The proposed haircut tier is out of range. Haircuts stay under 100%, the after-hours haircut is ' +
      'at least the session one, the session bound is above zero and the valuation bound at least as ' +
      'long. Tiers count from 1, and a new one can only be added at the end. Nothing changed.',
  },
  HealthTooLow: {
    owner: 'caller',
    message: (figures, context) => {
      const short = figured(
        [ratioAt(figures, 0), ratioAt(figures, 1)],
        ([health, floor]) =>
          `This would leave the line’s health at ${health}, under the ${floor} a draw or a withdrawal has ` +
          'to keep.',
        'This would leave the line’s health under the floor a draw or a withdrawal has to keep.',
      );

      const halted = haltedAt(figures, 2);
      if (halted.length === 0) {
        return (
          `${short} The check counts every position at its after-hours haircut whatever the clock says, and ` +
          'counts nothing for a position whose price is stale or paused or whose pool has left its band. ' +
          'Post more collateral, repay some of the debt, or ask for less.'
        );
      }

      // `boundDraw` found what the check left out, so the sentence names it and not the general rule.
      const bounds = boundsAt(figures, 3);
      const names = listed(halted.map((position) => context.symbolOf(position.asset)));
      return (
        `${short} ${halted.map((position) => haltSentence(position, context, bounds)).join(' ')} What does ` +
        'count is taken at its after-hours haircut whatever the clock says. The same call may pass once ' +
        `${names} ${halted.length === 1 ? 'counts' : 'count'} again. Until then post other collateral, repay ` +
        'some of the debt, or ask for less.'
      );
    },
  },
  Healthy: {
    owner: 'caller',
    message: (figures) =>
      figured(
        [ratioAt(figures, 0)],
        ([health]) => `The line’s health is ${health}, at or above 1.00,`,
        'The line’s health is at or above 1.00,',
      ) + ' so there is nothing to liquidate.',
  },
  NoLine: {
    owner: 'caller',
    message: (figures) =>
      `${mandateAt(figures, 0)} has no collateral line open, so it cannot post collateral or draw on ` +
      'credit. Its principal opens one with openLine().',
  },
  SaleHalted: {
    owner: 'clock',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} cannot be sold right now: the price check holds no reading of its pool ` +
      'that a sale may rest on. The sale waits until a reading taken with the pool and the feed in line has ' +
      'aged; nothing a mandate sends changes that.',
  },
  NotAdmin: GOVERNANCE_ONLY,
  NotCollateral: {
    owner: 'caller',
    message: (figures, context) =>
      `${tokenAt(figures, 0, context)} is not accepted as collateral: it sits in no haircut tier. ` +
      'tiers() lists what the vault takes.',
  },
  NotCollateralLane: {
    owner: 'caller',
    message: (figures) => {
      const lane = figures[1];
      return (
        `${mandateAt(figures, 0)} is in ${typeof lane === 'number' ? `lane ${lane}` : 'another lane'}. ` +
        'Only a collateral-lane mandate, lane 1, can open a line or draw on credit. Create one with lane 1 ' +
        'in its limits.'
      );
    },
  },
  NotEligible: NOT_ELIGIBLE,
  NotFactoryAccount: NOT_FROM_FACTORY,
  NotPendingAdmin: PENDING_ADMIN,
  NotPrincipal: {
    owner: 'caller',
    message:
      'Only the mandate’s principal can open its credit line or take collateral back out. Send this from ' +
      'the principal’s key.',
  },
  NothingSeized: {
    owner: 'caller',
    message: (figures, context) =>
      `The vault holds no seized ${tokenAt(figures, 0, context, 'collateral in this asset')}, so there is ` +
      'nothing to pay the pool’s lender. Collateral is seized when a line’s debt is written off, and a ' +
      'claim pays out all of it at once. seized() reads what is waiting.',
  },
  NothingToSell: {
    owner: 'caller',
    message:
      'Selling this asset would not lift the line’s health: the slice it would take rounds to nothing at ' +
      'the current price. Liquidate against another asset the line holds.',
  },
  PositionEmpty: {
    owner: 'caller',
    message: (figures, context) =>
      `The line holds less ${tokenAt(figures, 1, context, 'of this asset')} than this call takes, or none ` +
      'at all. position() lists what is posted.',
  },
  ReentrancyGuardReentrantCall: REENTRY,
  SafeERC20FailedOperation: TOKEN_REFUSED,
  ZeroAddress: {
    owner: 'caller',
    message: 'The vault was given the zero address where it needs a real one. Nothing moved.',
  },
  ZeroAmount: {
    owner: 'caller',
    message: 'A deposit or a withdrawal of zero is refused. Name a positive amount.',
  },
  ...SWAP,
};

const POOL: Readonly<Record<ErrorName<typeof creditPoolAbi>, Reading>> = {
  BadRates: {
    owner: 'governance',
    message:
      'The proposed caps or rates do not hold together: both caps above zero with the per-mandate cap ' +
      'inside the total, and the base rate and the slope together at most 50% a year. The settings in ' +
      'force are unchanged.',
  },
  BuybackStakingMismatch: {
    owner: 'deployment',
    message:
      'The credit pool was deployed against a buyback and a staking pool that do not belong together, so ' +
      'it could not turn a loss into a stake slash. Nothing a caller sends reaches this. Report it to the ' +
      'operator.',
  },
  InsufficientCash: {
    owner: 'counterparty',
    message: (figures) =>
      figured(
        [usdAt(figures, 0), usdAt(figures, 1)],
        ([cash, needed]) => `The credit pool has ${cash} free to lend and this needs ${needed}.`,
        'The credit pool has less free to lend than this needs.',
      ) +
      ' It lends only what its lender has put in and borrowers have paid back, and the draw goes ' +
      'through once the pool is funded or other lines repay.',
  },
  MandateCapExceeded: {
    owner: 'caller',
    message: (figures) =>
      figured(
        [usdAt(figures, 0), usdAt(figures, 1)],
        ([debt, cap]) =>
          `This draw would bring the mandate’s debt to ${debt}, over the ${cap} one mandate may owe the pool.`,
        'This draw would take the mandate’s debt over the most one mandate may owe the pool.',
      ) + ' Repay some of it, or spend less on credit.',
  },
  NoDebt: {
    owner: 'caller',
    message: (figures) => `${mandateAt(figures, 0)} owes the credit pool nothing, so there is nothing to repay.`,
  },
  NotAdmin: GOVERNANCE_ONLY,
  NotDeployer: {
    owner: 'deployment',
    message: 'Only the address that deployed the credit pool binds it to its vault, and it does that once.',
  },
  NotLender: {
    owner: 'caller',
    message: 'Only the pool’s lender can take unlent USDG back out of it.',
  },
  NotPendingAdmin: PENDING_ADMIN,
  NotVault: {
    owner: 'deployment',
    message:
      'Only the collateral vault opens or writes off debt in the credit pool. A draw happens inside a ' +
      'mandate’s own spend, and nothing borrows from the pool directly.',
  },
  NothingToSweep: {
    owner: 'caller',
    message: 'The pool holds no paid spread to send to stakers yet.',
  },
  ReentrancyGuardReentrantCall: REENTRY,
  SafeERC20FailedOperation: TOKEN_REFUSED,
  TotalCapExceeded: {
    owner: 'governance',
    message: (figures) =>
      figured(
        [usdAt(figures, 0), usdAt(figures, 1)],
        ([debt, cap]) =>
          `This draw would bring what the pool has lent across every mandate to ${debt}, over the ${cap} ` +
          'it lends in total.',
        'This draw would take the pool over the most it lends in total, across every mandate.',
      ) + ' It goes through once other lines repay, or governance raises the cap.',
  },
  ZeroAddress: {
    owner: 'governance',
    message: 'The credit pool was given the zero address where it needs a real one. Nothing changed.',
  },
  ZeroAmount: {
    owner: 'caller',
    message: 'Repaying, funding or borrowing zero is refused. Name a positive amount.',
  },
};

type PurchaseErrorName = Extract<ErrorName<typeof mandateAccountAbi>, 'RouterNotSet' | 'InsufficientOutput'>;

/** The account's own refusals on the way into a purchase, other than its spending limits. */
const PURCHASE: Readonly<Record<PurchaseErrorName, Reading>> = {
  RouterNotSet: {
    owner: 'caller',
    message:
      'This mandate names no stock router, so it cannot buy. Its principal points it at the ' +
      'deployment’s router with useRouter().',
  },
  InsufficientOutput: {
    owner: 'caller',
    message:
      'The mandate received fewer tokens than the least it accepts for this purchase, measured on its own ' +
      'balance, so the purchase was undone. Quote again and retry.',
  },
};

const TOKEN: Readonly<Record<TokenErrorName, Reading>> = {
  ERC20InsufficientAllowance: {
    owner: 'caller',
    message:
      'The sending address has approved less of the token than this call pulls, so nothing moved. This ' +
      'package approves before it pulls, so an allowance spent or lowered in between reads this way. Try ' +
      'again.',
  },
  ERC20InsufficientBalance: {
    owner: 'caller',
    message: (figures) =>
      `${addressAt(figures, 0) ?? 'The sending address'} holds less of the token than this call moves, so ` +
      'nothing moved. Top it up and try again.',
  },
  ERC20InvalidApprover: {
    owner: 'caller',
    message: 'The token refused an approval from the zero address. Nothing moved.',
  },
  ERC20InvalidReceiver: {
    owner: 'caller',
    message: 'The token refused a transfer to the zero address. Nothing moved. Name a real recipient.',
  },
  ERC20InvalidSender: {
    owner: 'caller',
    message: 'The token refused a transfer from the zero address. Nothing moved.',
  },
  ERC20InvalidSpender: {
    owner: 'caller',
    message: 'The token refused an approval for the zero address. Nothing moved.',
  },
};

/**
 * The tables each kind of call reads, in the order that settles a name more than one contract uses.
 * A spend and a purchase read the credit pool before the park: a short balance inside either reaches
 * the park only through `unparkFor`, which raises nothing but its own shortfall.
 */
const CALLS = {
  buy: [PURCHASE, ROUTER, GUARD, ASSETS, POOL, VAULT, PARK, TOKEN],
  policy: [ROUTER],
  park: [PARK, ADAPTER, GUARD, ASSETS, TOKEN],
  vault: [VAULT, POOL, GUARD, ASSETS, TOKEN],
  repay: [POOL, TOKEN],
  spend: [POOL, VAULT, PARK],
} as const satisfies Record<string, readonly Table[]>;

export type LaneCall = keyof typeof CALLS;

/**
 * The sentence for a revert on one of the lane's calls, or null when none of the contracts that
 * call reaches declares the name.
 */
export function laneRefusal(revert: RevertInfo, call: LaneCall, context: LaneContext): Refusal | null {
  for (const table of CALLS[call] as readonly Table[]) {
    const reading = table[revert.errorName];
    if (reading === undefined) continue;

    const message = typeof reading.message === 'string' ? reading.message : reading.message(revert.args, context);
    return { code: revert.errorName, owner: reading.owner, message };
  }

  return null;
}

/** Each contract's table, for the suite that holds them to the ABIs. */
export const LANE_TABLES = { ROUTER, GUARD, ASSETS, PARK, ADAPTER, VAULT, POOL, PURCHASE, TOKEN, DRAW_HALT } as const;

/**
 * The sentence for the condition a draw against `asset` fails, under the price guard's own name
 * for it, or null when the draw counts the position. `halt` is what the vault's `drawHalt`
 * answers, as a name or as the number it comes back as.
 */
export function drawHaltRefusal(
  halt: DrawHalt | number,
  asset: Address,
  context: LaneContext,
  bounds?: ObservationBounds,
): Refusal | null {
  const name = typeof halt === 'number' ? drawHaltOf(halt) : halt;
  if (!isHalt(name)) return null;

  return { code: name, owner: DRAW_HALT[name].owner, message: haltSentence({ asset, halt: name }, context, bounds) };
}

/** Where a draw on credit went: the pool it asked, if the lane has one, and the mandate that drew. */
export type CreditDraw = {
  readonly client: PublicClient<Transport, Chain>;
  readonly pool: Address | undefined;
  readonly mandate: Address;
};

/** Where a health check ran: the vault that made it, and the line it was made for. */
export type DrawnLine = {
  readonly client: PublicClient<Transport, Chain>;
  readonly vault: Address;
  readonly mandate: Address;
};

/** The guard's bounds, through the vault that reads it. Undefined when they cannot be read. */
export async function observationBounds(
  client: PublicClient<Transport, Chain>,
  vault: Address,
): Promise<ObservationBounds | undefined> {
  try {
    const guard = await client.readContract({ address: vault, abi: collateralVaultAbi, functionName: 'guard' });
    const read = { address: guard, abi: priceGuardAbi } as const;
    const [minAge, maxAge, maxFeedJumpBps] = await Promise.all([
      client.readContract({ ...read, functionName: 'MIN_OBSERVATION_AGE' }),
      client.readContract({ ...read, functionName: 'MAX_OBSERVATION_AGE' }),
      client.readContract({ ...read, functionName: 'MAX_FEED_JUMP_BPS' }),
    ]);
    return { minAge, maxAge, maxFeedJumpBps };
  } catch {
    return undefined;
  }
}

/**
 * What a draw or a withdrawal refused on health was not allowed to count.
 *
 * From v4 the vault counts a position toward a draw only while the price guard's draw rule passes
 * it, so `HealthTooLow` comes back both when the collateral is short and when a position that
 * would have carried the debt is held out. Read against the vault's `drawHalt`, the refusal carries
 * each position held out and the condition it fails, with the guard's bounds beside them. A vault
 * from before v4 answers no halt, and its own words stand.
 */
export async function boundDraw(revert: RevertInfo, line: DrawnLine): Promise<RevertInfo> {
  if (revert.errorName !== 'HealthTooLow') return revert;

  const read = { address: line.vault, abi: collateralVaultAbi } as const;
  let halted: HaltedPosition[];
  try {
    const positions = await line.client.readContract({ ...read, functionName: 'positions', args: [line.mandate] });
    const held = positions.filter((position) => position.raw > 0n);
    const halts = await Promise.all(
      held.map((position) => line.client.readContract({ ...read, functionName: 'drawHalt', args: [position.asset] })),
    );
    halted = held.flatMap((position, index) => {
      const halt = drawHaltOf(halts[index] ?? 0);
      return isHalt(halt) ? [{ asset: position.asset, halt }] : [];
    });
  } catch {
    return revert;
  }

  if (halted.length === 0) return revert;
  return {
    errorName: revert.errorName,
    args: [revert.args[0], revert.args[1], halted, await observationBounds(line.client, line.vault)],
  };
}

/**
 * The limit a refused draw on credit actually ran into.
 *
 * The credit pool checks its cash before either of its caps, so a draw that is over a cap as well
 * comes back as `InsufficientCash`, and lending the pool more would not let it through. Read
 * against the caps, the refusal names the limit that holds however much cash the pool has: the
 * mandate's own cap first, then the pool's total, and the cash only when neither cap is in the way.
 * The figures are the ones the pool would have raised for that cap.
 *
 * A draw the vault refused on health is read the way `boundDraw` reads it, against the vault the
 * pool names.
 */
export async function boundCredit(revert: RevertInfo, draw: CreditDraw): Promise<RevertInfo> {
  if (draw.pool === undefined) return revert;

  if (revert.errorName === 'HealthTooLow') {
    const vault = await draw.client
      .readContract({ address: draw.pool, abi: creditPoolAbi, functionName: 'vault' })
      .catch(() => undefined);
    return vault === undefined ? revert : boundDraw(revert, { client: draw.client, vault, mandate: draw.mandate });
  }

  const needed = revert.errorName === 'InsufficientCash' ? revert.args[1] : undefined;
  if (typeof needed !== 'bigint') return revert;

  const read = { address: draw.pool, abi: creditPoolAbi } as const;
  let caps: readonly [bigint, bigint, bigint, bigint];
  try {
    caps = await Promise.all([
      draw.client.readContract({ ...read, functionName: 'debtOf', args: [draw.mandate] }),
      draw.client.readContract({ ...read, functionName: 'perMandateCap' }),
      draw.client.readContract({ ...read, functionName: 'totalDebt' }),
      draw.client.readContract({ ...read, functionName: 'totalDebtCap' }),
    ]);
  } catch {
    // The pool's own words stand when its caps cannot be read. They are true, only not the whole story.
    return revert;
  }

  const [debt, mandateCap, lent, totalCap] = caps;
  if (debt + needed > mandateCap) return { errorName: 'MandateCapExceeded', args: [debt + needed, mandateCap] };
  if (lent + needed > totalCap) return { errorName: 'TotalCapExceeded', args: [lent + needed, totalCap] };
  return revert;
}
