import type { Micro } from '@bursar/core';
import type { Address, Hex } from 'viem';
import type { Wei } from '../money';
import type { ProviderHealth } from '../chain/client';
import type { AssetRead, ChainSnapshot, MandateRead, PermissionRead, ProviderRead } from '../chain/reader';

/**
 * Five states, reported separately and never merged.
 *
 * A payment can fail for a reason the mandate cannot see. The issuer of the settlement asset can
 * block an address or pause the token, and a transfer then reverts whatever the balance says and
 * whatever the mandate allows. A product that answers "ready" to all of that is lying to whoever
 * has to fix it, and the five answers have five different owners: the asset belongs to the token
 * issuer, the mandate and its funding to the principal, the permissions to whoever wrote the
 * allowlist, connectivity to this deployment.
 *
 * There is no combined status on this type. A screen that reduces these to one light
 * has thrown away the only thing that tells a treasurer who to call.
 */
export type StateKey = 'asset' | 'mandate' | 'permission' | 'funding' | 'connectivity';

export type StateLevel =
  /** Everything this state covers is clear. */
  | 'ok'
  /** Usable now, and something here will stop working if it is left alone. */
  | 'attention'
  /** A payment will not go through until this is resolved. */
  | 'blocked'
  /** The reading could not be taken. Not the same as clear. */
  | 'unknown'
  /** Nothing was asked of this state, so it has nothing to report. */
  | 'not-applicable';

export type ActionOwner = 'principal' | 'agent' | 'provider' | 'operator' | 'token-issuer';

/**
 * What to do about a state, and whether this app can do any of it.
 *
 * `link` and `retry` are the only two kinds a surface can turn into something pressable: a `link`
 * carries the href it goes to, and a `retry` asks for the reading to be taken again. Everything
 * else is an instruction to a person, which is rendered as one. Bold text that looks like a
 * control and answers nothing is worse than a plain sentence.
 */
export type NextAction = {
  /** Imperative, and something the reader can do. */
  readonly label: string;
  readonly owner: ActionOwner;
  readonly kind: 'link' | 'retry' | 'transaction' | 'fund' | 'wait' | 'contact';
  /** Required by `link`, which is what makes a link a link. */
  readonly href?: string;
  /** Set where the fix is a clock running out, with nobody to chase. */
  readonly waitUntil?: Date;
};

/** One finding inside a state. Readable on its own, because each has its own fix. */
export type Check = {
  readonly id: string;
  readonly label: string;
  readonly level: StateLevel;
  readonly detail: string;
};

export type StateReport<K extends StateKey, Facts> = {
  readonly key: K;
  readonly label: string;
  readonly level: StateLevel;
  /** One line, in the words a customer would use. */
  readonly headline: string;
  /** What it means and what follows from it. */
  readonly detail: string;
  readonly nextAction: NextAction | null;
  readonly checks: readonly Check[];
  readonly facts: Facts;
  readonly checkedAt: Date | null;
  /** The reading is older than it should be. The numbers are real; the moment is not now. */
  readonly stale: boolean;
};

export type AssetFacts = {
  readonly token: Address;
  readonly paused: boolean | undefined;
  /** The address that holds the pause and the blocklist. The token exposes one for both. */
  readonly controller: Address | undefined;
  /** Address, lowercased, to whether the token blocks its funds from moving. */
  readonly blocked: Readonly<Record<string, boolean | undefined>>;
  readonly blockedAddresses: readonly Address[];
};

export type MandateFacts = {
  readonly account: MandateRead | undefined;
  readonly perCallRemaining: Micro | undefined;
  readonly dailyRemaining: Micro | undefined;
  readonly monthlyRemaining: Micro | undefined;
  readonly dailyResetsAt: Date | undefined;
  readonly monthlyResetsAt: Date | undefined;
  readonly validUntil: Date | undefined;
  readonly live: boolean | undefined;
};

export type PermissionFacts = {
  readonly merchant: Address | undefined;
  readonly merchantAllowed: boolean | undefined;
  readonly capability: string | undefined;
  readonly capabilityId: Hex | undefined;
  readonly capabilityAllowed: boolean | undefined;
  readonly preview: PermissionRead['preview'];
  /** Set when a merchant was named and the registry has an opinion about it. */
  readonly provider: ProviderRead | undefined;
};

export type FundingFacts = {
  readonly mandate: Address | undefined;
  /** What pays providers. USDG, six decimals. */
  readonly mandateBalance: Micro | undefined;
  readonly gasPayer: Address | undefined;
  /**
   * What pays transaction fees: the signer's ETH, in wei.
   *
   * A different asset from the one above, which is the whole reason it is typed differently. An
   * account can hold a year of USDG and not have the ETH to send one transaction, and the two
   * shortages have nothing to say about each other.
   */
  readonly gasBalance: Wei | undefined;
  /** One mandate-governed escrow round trip, priced in ETH. */
  readonly roundTripFee: Wei;
  /** Deploying a mandate account, priced in ETH. */
  readonly deployFee: Wei;
};

export type ConnectivityFacts = {
  readonly chainId: number;
  readonly providers: readonly ProviderHealth[];
  readonly reachable: number;
  readonly blockNumber: bigint | undefined;
  /** Blocks between the furthest ahead and the furthest behind endpoint. */
  readonly headSpread: bigint | undefined;
};

export type AssetState = StateReport<'asset', AssetFacts>;
export type MandateState = StateReport<'mandate', MandateFacts>;
export type PermissionState = StateReport<'permission', PermissionFacts>;
export type FundingState = StateReport<'funding', FundingFacts>;
export type ConnectivityState = StateReport<'connectivity', ConnectivityFacts>;

export type AnyState = AssetState | MandateState | PermissionState | FundingState | ConnectivityState;

export type SystemState = {
  readonly asset: AssetState;
  readonly mandate: MandateState;
  readonly permission: PermissionState;
  readonly funding: FundingState;
  readonly connectivity: ConnectivityState;
  /** The five, in reading order, for a surface that renders them as a list. */
  readonly all: readonly AnyState[];
  /**
   * The states that will stop a payment right now. A filter, not a summary: each entry still
   * carries its own explanation and its own next action, and a caller that needs one sentence
   * should quote the first entry. A combined one would belong to nobody.
   */
  readonly blockers: readonly AnyState[];
  readonly snapshot: ChainSnapshot | undefined;
  readonly assetRead: AssetRead | undefined;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: unknown;
  readonly refresh: () => void;
};
