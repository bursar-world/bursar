import {
  assetRegistryAbi,
  endowmentAbi,
  endowmentFactoryAbi,
  endowmentsDeployment,
  identityRegistryAbi,
  patronMarkAbi,
  priceGuardAbi,
  rwaDeployment,
} from '@bursar/core';
import type { EndowmentsDeployment, Micro } from '@bursar/core';
import type { Abi, Address } from 'viem';
import { multicall, readContract } from 'viem/actions';

import { rhcClient } from './client';
import { CHAIN_ID, MULTICALL3, sameAddress } from './rhc';

export const ENDOWMENTS: EndowmentsDeployment | undefined = endowmentsDeployment(CHAIN_ID);

const YEAR_SECONDS = 365n * 24n * 3600n;
const SLEEVE_SECONDS = 90n * 24n * 3600n;

export type EndowmentState = {
  readonly agentId: bigint;
  readonly successorId: bigint;
  readonly mandate: Address;
  readonly accepted: boolean;
  readonly frozen: boolean;
  readonly nav: Micro;
  readonly navFresh: boolean;
  readonly averageNav: Micro;
  readonly drawPerYear: Micro;
  readonly accrued: Micro;
  readonly cash: Micro;
  readonly sleeveTarget: Micro;
  readonly given: Micro;
  readonly unattributed: Micro;
  readonly earned: Micro;
  readonly earnedToPrincipal: Micro;
  readonly drawn: Micro;
  readonly fees: Micro;
  readonly patrons: bigint;
  readonly snapshotsTaken: bigint;
  readonly createdAt: bigint;
  readonly lastDrawAt: bigint;
  readonly lastActive: bigint;
  readonly unacceptedSince: bigint;
  /** Gifts, private gifts and the earnings kept. */
  readonly contributed: Micro;
  /** Put in since the last valuation; it counts from the next one. */
  readonly pending: Micro;
  readonly everAccepted: boolean;
  /** Worth under 80% of what was put in, so the draw is stopped. */
  readonly underwater: boolean;
  readonly lastSnapshotAt: bigint;
};

export type Holding = {
  readonly asset: Address;
  readonly symbol: string;
  readonly weightBps: number;
  readonly raw: bigint;
  readonly decimals: number;
  readonly priceE8: bigint | undefined;
  readonly value: Micro | undefined;
};

export type EndowmentView = {
  readonly address: Address;
  readonly state: EndowmentState;
  readonly settlor: Address;
  readonly drawBps: number;
  readonly earnShareBps: number;
  readonly feeBps: number;
  readonly holdings: readonly Holding[];
  /** The identity's owner, who accepts the endowment and draws from it. */
  readonly owner: Address | undefined;
  readonly agentUri: string | undefined;
  /** When the figures were read, so a ticker can run the accrual forward from them. */
  readonly readAt: number;
};

/** What a stock is called in the record, which every listed stock is in. */
export function stockSymbol(asset: Address): string {
  return rwaDeployment(CHAIN_ID)?.assets.find((a) => sameAddress(a.address, asset))?.symbol ?? asset.slice(0, 8);
}

/** Every stock an endowment can hold: the record's listed stocks, by ticker. */
export function listedStocks(): readonly { readonly symbol: string; readonly address: Address }[] {
  return (rwaDeployment(CHAIN_ID)?.assets ?? [])
    .filter((a) => a.kind === 'stock')
    .map((a) => ({ symbol: a.symbol, address: a.address }))
    .sort((a, b) => (a.symbol === 'SPY' ? -1 : b.symbol === 'SPY' ? 1 : a.symbol.localeCompare(b.symbol)));
}

export async function endowmentAddresses(): Promise<readonly Address[]> {
  if (!ENDOWMENTS) return [];
  const client = rhcClient();
  const count = (await readContract(client, {
    address: ENDOWMENTS.EndowmentFactory,
    abi: endowmentFactoryAbi,
    functionName: 'count',
  })) as bigint;
  if (count === 0n) return [];
  const answers = await multicall(client, {
    multicallAddress: MULTICALL3,
    allowFailure: false,
    contracts: Array.from({ length: Number(count) }, (_, i) => ({
      address: ENDOWMENTS.EndowmentFactory,
      abi: endowmentFactoryAbi as Abi,
      functionName: 'all',
      args: [BigInt(i)],
    })),
  });
  return answers as Address[];
}

export async function readEndowments(): Promise<readonly EndowmentView[]> {
  const addresses = await endowmentAddresses();
  const views = await Promise.all(addresses.map((address) => readEndowment(address).catch(() => undefined)));
  return views.filter((view): view is EndowmentView => view !== undefined);
}

export async function readEndowment(address: Address): Promise<EndowmentView> {
  const client = rhcClient();
  const at = (functionName: string) => ({ address, abi: endowmentAbi as Abi, functionName }) as const;
  const [state, assets, settlor, drawBps, earnShareBps, feeBps, registry, guard] = (await multicall(client, {
    multicallAddress: MULTICALL3,
    allowFailure: false,
    contracts: [
      at('state'),
      at('assets'),
      at('settlor'),
      at('drawBps'),
      at('earnShareBps'),
      at('feeBps'),
      at('registry'),
      at('guard'),
    ],
  })) as [EndowmentState, readonly [readonly Address[], readonly number[]], Address, number, number, number, Address, Address];

  const [tokens, weights] = assets;
  const perAsset = await multicall(client, {
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: tokens.flatMap((asset) => [
      { address: asset, abi: ERC20_BALANCE, functionName: 'balanceOf', args: [address] } as const,
      { address: registry, abi: assetRegistryAbi as Abi, functionName: 'get', args: [asset] } as const,
      { address: guard, abi: priceGuardAbi as Abi, functionName: 'valuationPrice', args: [asset] } as const,
    ]),
  });

  const holdings: Holding[] = tokens.map((asset, i) => {
    const raw = (perAsset[i * 3]?.result as bigint | undefined) ?? 0n;
    const decimals = Number((perAsset[i * 3 + 1]?.result as { decimals?: number } | undefined)?.decimals ?? 18);
    const price = perAsset[i * 3 + 2]?.result as readonly [bigint, bigint, boolean] | undefined;
    const priceE8 = price?.[0] === 0n ? undefined : price?.[0];
    return {
      asset,
      symbol: stockSymbol(asset),
      weightBps: Number(weights[i] ?? 0),
      raw,
      decimals,
      priceE8,
      value: priceE8 === undefined ? undefined : ((raw * priceE8) / 10n ** BigInt(decimals + 2) as Micro),
    };
  });

  let owner: Address | undefined;
  let agentUri: string | undefined;
  if (ENDOWMENTS) {
    const identity = await multicall(client, {
      multicallAddress: MULTICALL3,
      allowFailure: true,
      contracts: [
        { address: ENDOWMENTS.IdentityRegistry, abi: identityRegistryAbi, functionName: 'ownerOf', args: [state.agentId] } as const,
        { address: ENDOWMENTS.IdentityRegistry, abi: identityRegistryAbi, functionName: 'tokenURI', args: [state.agentId] } as const,
      ],
    });
    owner = identity[0]?.result as Address | undefined;
    agentUri = identity[1]?.result as string | undefined;
  }

  return {
    address,
    state,
    settlor,
    drawBps: Number(drawBps),
    earnShareBps: Number(earnShareBps),
    feeBps: Number(feeBps),
    holdings,
    owner,
    agentUri,
    readAt: Date.now(),
  };
}

/** Where the principal came from, and what the market did to it since. */
export function sources(view: EndowmentView): {
  readonly patrons: bigint;
  readonly earnedBack: bigint;
  readonly paidOut: bigint;
  readonly market: bigint;
} {
  const s = view.state;
  const patrons = s.given + s.unattributed;
  const paidOut = s.drawn + s.fees;
  return { patrons, earnedBack: s.earnedToPrincipal, paidOut, market: s.nav - patrons - s.earnedToPrincipal + paidOut };
}

/**
 * The draw owed `seconds` after the read, the way the contract accrues it: the year's draw spread
 * evenly, owed for at most ninety days.
 */
export function accruedAfter(view: EndowmentView, seconds: number): bigint {
  const s = view.state;
  if (!s.accepted || s.frozen) return 0n;
  const elapsedAtRead = BigInt(Math.floor(view.readAt / 1000)) - s.lastDrawAt;
  let elapsed = elapsedAtRead + BigInt(Math.max(0, Math.floor(seconds)));
  if (elapsed > SLEEVE_SECONDS) elapsed = SLEEVE_SECONDS;
  if (elapsed < 0n) elapsed = 0n;
  return (s.drawPerYear * elapsed) / YEAR_SECONDS;
}

export type PatronMark = { readonly endowment: Address; readonly patron: Address; readonly at: bigint; readonly founding: boolean };

export async function readMark(id: bigint): Promise<PatronMark | undefined> {
  if (!ENDOWMENTS) return undefined;
  try {
    return (await readContract(rhcClient(), {
      address: ENDOWMENTS.PatronMark,
      abi: patronMarkAbi,
      functionName: 'markOf',
      args: [id],
    })) as PatronMark;
  } catch {
    return undefined;
  }
}

/** A readable name for an agent from its card, when the card is reachable; otherwise its number. */
export async function agentName(agentId: bigint, uri: string | undefined): Promise<string> {
  const fallback = `Agent #${agentId.toString()}`;
  if (uri === undefined || uri === '') return fallback;
  try {
    let card: unknown;
    if (uri.startsWith('data:')) {
      const comma = uri.indexOf(',');
      const body = uri.slice(comma + 1);
      card = JSON.parse(uri.slice(0, comma).includes('base64') ? atob(body) : decodeURIComponent(body));
    } else {
      const url = uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri;
      if (!url.startsWith('https://')) return fallback;
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) return fallback;
      card = await response.json();
    }
    const name = (card as { name?: unknown }).name;
    return typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 60) : fallback;
  } catch {
    return fallback;
  }
}

const ERC20_BALANCE = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
