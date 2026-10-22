import { endowmentAbi, endowmentFactoryAbi, micro, viemChain } from '@bursar/core';
import type { EndowmentsDeployment, RhcChain, RhcPublicClient, RwaDeployment } from '@bursar/core';
import { BaseError, createWalletClient, custom, decodeErrorResult, encodeFunctionData, erc20Abi, formatUnits, isAddressEqual, parseEventLogs, zeroAddress } from 'viem';
import type { Address, Hex, WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ToolError } from './errors.js';
import { instantOrNull, money } from './format.js';
import type { MoneyView } from './types.js';
import type { ObjectSchema } from './schema.js';

/** How many of the newest endowments a status read looks through for ones paying this mandate. */
const SCAN = 100;
/** After this long without a draw from the agent's side, anyone can pass the endowment on. */
const QUIET_SECONDS = 180n * 24n * 60n * 60n;

export type EndowmentHoldingView = {
  readonly asset: Address;
  readonly symbol: string;
  readonly weightBps: number;
  /** Shares held, in whole-token units. */
  readonly shares: string;
};

export type EndowmentView = {
  readonly endowment: Address;
  readonly agentId: string;
  readonly accepted: boolean;
  readonly drawsIntoThisMandate: boolean;
  readonly mandate: Address | null;
  readonly paused: boolean;
  readonly holdings: readonly EndowmentHoldingView[];
  /** Everything held, at the reference prices. */
  readonly principal: MoneyView;
  readonly pricesFresh: boolean;
  /** The average of up to twelve quarterly valuations, which the draw is a share of. */
  readonly averageValue: MoneyView;
  readonly drawPerYear: MoneyView;
  readonly drawPerMonth: MoneyView;
  /** What a draw would pay now, before the protocol's share. */
  readonly availableNow: MoneyView;
  readonly protocolShareBps: number;
  readonly cash: MoneyView;
  readonly patrons: number;
  readonly given: MoneyView;
  readonly earnedBack: MoneyView;
  readonly drawn: MoneyView;
  readonly lastDrawAt: string | null;
  /** When the endowment can be passed on if the agent's side has not drawn by then. Null before acceptance. */
  readonly quietAfter: string | null;
};

export type EndowmentStatusView = {
  readonly endowments: readonly EndowmentView[];
  readonly next: string;
};

export type EndowmentDrawView = {
  readonly endowment: Address;
  readonly txHash: Hex;
  /** What reached the mandate. */
  readonly amount: MoneyView;
  /** The protocol's share of the draw. */
  readonly fee: MoneyView;
  readonly next: string;
};

export type EndowmentGateway = {
  /** Whether this server holds a key that can send a draw. */
  readonly canWrite: boolean;
  status(endowment: Address | null): Promise<EndowmentStatusView>;
  draw(endowment: Address | null): Promise<EndowmentDrawView>;
};

export type EndowmentGatewayOptions = {
  readonly client: RhcPublicClient;
  readonly chain: RhcChain;
  /** The mandate this server is bound to, which the draw is paid into. */
  readonly account: Address;
  /** The agent key. Null with a relay or no signer: a draw is sent from a key held here. */
  readonly key: Hex | null;
  readonly endowments: EndowmentsDeployment | null;
  /** The agent's ERC-8004 id, when the operator named it. Finds endowments not yet accepted. */
  readonly agentId: bigint | null;
  /** What symbols resolve through. */
  readonly rwa: RwaDeployment | null;
};

/** What each of the endowment's refusals means, and what clears it. */
const REFUSALS: Readonly<Record<string, string>> = {
  NotDrawer: 'Only the agent owner or the mandate’s agent can draw, and this server’s key is neither.',
  NotAccepted: 'The agent’s owner has not accepted this endowment yet, so nothing accrues.',
  IsFrozen: 'The draw is paused. Nothing accrues until it restarts.',
  NothingToDraw: 'Nothing has accrued since the last draw, or the endowment’s cash is used up until it sells stock to refill it.',
};

/** Null when the record this server reads has no endowment factory. */
export function createEndowmentGateway(options: EndowmentGatewayOptions): EndowmentGateway | null {
  const deployment = options.endowments;
  if (deployment === null) return null;
  return gatewayFor(options, deployment);
}

function gatewayFor(options: EndowmentGatewayOptions, deployment: EndowmentsDeployment): EndowmentGateway {
  const { client, account } = options;
  const factory = deployment.EndowmentFactory;
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
    options.rwa?.assets.find((a) => isAddressEqual(a.address, address))?.symbol ?? address;

  /** The endowment named, or every one for the configured agent and every recent one paying this mandate. */
  async function candidates(named: Address | null): Promise<Address[]> {
    if (named !== null) return [named];
    const found: Address[] = [];
    if (options.agentId !== null) {
      found.push(
        ...(await client.readContract({
          address: factory,
          abi: endowmentFactoryAbi,
          functionName: 'endowmentsOf',
          args: [options.agentId],
        })),
      );
    }
    const count = Number(await client.readContract({ address: factory, abi: endowmentFactoryAbi, functionName: 'count' }));
    const recent = await Promise.all(
      Array.from({ length: Math.min(count, SCAN) }, (_, i) =>
        client.readContract({ address: factory, abi: endowmentFactoryAbi, functionName: 'all', args: [BigInt(count - 1 - i)] }),
      ),
    );
    const paying = await Promise.all(
      recent.map(async (endowment) => {
        const mandate = await client.readContract({ address: endowment, abi: endowmentAbi, functionName: 'mandate' });
        return isAddressEqual(mandate, account) ? endowment : null;
      }),
    );
    for (const endowment of paying) {
      if (endowment !== null && !found.some((known) => isAddressEqual(known, endowment))) found.push(endowment);
    }
    return found;
  }

  async function view(endowment: Address): Promise<EndowmentView> {
    const [s, [assets, weights]] = await Promise.all([
      client.readContract({ address: endowment, abi: endowmentAbi, functionName: 'state' }),
      client.readContract({ address: endowment, abi: endowmentAbi, functionName: 'assets' }),
    ]);
    const holdings = await Promise.all(
      assets.map(async (asset, i) => {
        const [raw, decimals] = await Promise.all([
          client.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [endowment] }),
          client.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals' }),
        ]);
        return { asset, symbol: symbolOf(asset), weightBps: weights[i] ?? 0, shares: formatUnits(raw, decimals) };
      }),
    );
    const mandate = s.mandate === zeroAddress ? null : s.mandate;
    return {
      endowment,
      agentId: s.agentId.toString(),
      accepted: s.accepted,
      drawsIntoThisMandate: mandate !== null && isAddressEqual(mandate, account),
      mandate,
      paused: s.frozen,
      holdings,
      principal: money(micro(s.nav)),
      pricesFresh: s.navFresh,
      averageValue: money(micro(s.averageNav)),
      drawPerYear: money(micro(s.drawPerYear)),
      drawPerMonth: money(micro(s.drawPerYear / 12n)),
      availableNow: money(micro(s.accrued)),
      protocolShareBps: deployment.feeBps,
      cash: money(micro(s.cash)),
      patrons: Number(s.patrons),
      given: money(micro(s.given)),
      earnedBack: money(micro(s.earnedToPrincipal)),
      drawn: money(micro(s.drawn)),
      lastDrawAt: s.accepted ? instantOrNull(s.lastDrawAt) : null,
      quietAfter: s.accepted ? instantOrNull(BigInt(s.lastActive) + QUIET_SECONDS) : null,
    };
  }

  function nextFor(views: readonly EndowmentView[]): string {
    if (views.length === 0) {
      return (
        'No endowment pays this mandate. Anyone can start one for this agent from the Bursar console, and its ' +
        'owner accepts it into this mandate.'
      );
    }
    const ready = views.find((v) => v.drawsIntoThisMandate && !v.paused && BigInt(v.availableNow.micro) > 0n);
    if (ready !== undefined) {
      return `${ready.availableNow.usdg} USDG has accrued. Call endowment_draw to move it into this mandate.`;
    }
    if (views.some((v) => !v.accepted)) {
      return 'An endowment for this agent waits for its owner to accept it into this mandate. Nothing accrues until then.';
    }
    return 'Nothing has accrued since the last draw. The draw accrues every second; check back later.';
  }

  function writer(): { wallet: WalletClient; signer: NonNullable<typeof signer> } {
    if (wallet === null || signer === null) {
      throw new ToolError(
        'relay_unconfigured',
        'A draw is sent from the agent key this server holds. Set BURSAR_SIGNER=local with the agent key, then restart it.',
      );
    }
    return { wallet, signer };
  }

  async function draw(named: Address | null): Promise<EndowmentDrawView> {
    const { wallet: w, signer: from } = writer();
    let endowment = named;
    if (endowment === null) {
      const views = await Promise.all((await candidates(null)).map(view));
      const paying = views.filter((v) => v.drawsIntoThisMandate);
      if (paying.length === 0) {
        throw new ToolError('endowment_none', 'No accepted endowment pays this mandate, so there is nothing to draw.');
      }
      if (paying.length > 1) {
        throw new ToolError(
          'invalid_arguments',
          `More than one endowment pays this mandate: ${paying.map((v) => v.endowment).join(', ')}. Name the one to draw from.`,
        );
      }
      endowment = paying[0]!.endowment;
    }

    // What the draw should pay, for a receipt a node returns without its logs.
    const before = await client.readContract({ address: endowment, abi: endowmentAbi, functionName: 'state' });
    const expected = before.accrued < before.cash ? before.accrued : before.cash;

    const data = encodeFunctionData({ abi: endowmentAbi, functionName: 'draw' });
    try {
      await client.call({ account: from, to: endowment, data });
    } catch (error) {
      throw refused(error);
    }
    const hash = await w.sendTransaction({ account: from, chain: viemChain(options.chain), to: endowment, data });
    const receipt = await client.waitForTransactionReceipt({ hash }).catch(() => {
      throw new ToolError(
        'signer_unconfirmed',
        `The draw was signed and submitted as ${hash}, and its receipt could not be read. It may have landed. ` +
          'Look the transaction up before drawing again.',
        { txHash: hash },
      );
    });
    if (receipt.status !== 'success') throw new ToolError('call_failed', `The draw reverted on chain in ${hash}.`);
    const [drawn] = parseEventLogs({
      abi: endowmentAbi,
      eventName: 'Drawn',
      logs: receipt.logs.filter((log) => isAddressEqual(log.address, endowment)),
    });
    const fee = drawn?.args.fee ?? (expected * BigInt(deployment.feeBps)) / 10_000n;
    const amount = drawn?.args.amount ?? expected - fee;
    return {
      endowment,
      txHash: hash,
      amount: money(micro(amount)),
      fee: money(micro(fee)),
      next: 'The USDG is in this mandate and spends under its limits like any other funds.',
    };
  }

  return {
    canWrite: wallet !== null,
    async status(named) {
      const views = await Promise.all((await candidates(named)).map(view));
      return { endowments: views, next: nextFor(views) };
    },
    draw,
  };
}

function refused(error: unknown): unknown {
  if (!(error instanceof BaseError)) return error;
  const holder = error.walk((e) => typeof (e as { data?: unknown }).data === 'string') as { data?: string } | null;
  const data = holder?.data;
  if (typeof data !== 'string' || data.length < 10) return error;
  try {
    const { errorName } = decodeErrorResult({ abi: endowmentAbi, data: data as Hex });
    const message = REFUSALS[errorName];
    if (message === undefined) return error;
    return new ToolError('endowment_refused', message, { revert: errorName });
  } catch {
    return error;
  }
}

const ENDOWMENT_PROPERTY = {
  type: 'string',
  description: 'One endowment by address. Leave it out to use the ones paying this mandate.',
  pattern: '^0x[0-9a-fA-F]{40}$',
  patternMessage: 'endowment must be a 0x-prefixed 20-byte address',
} as const;

export const ENDOWMENT_TOOLS: readonly {
  readonly name: string;
  readonly writes: boolean;
  readonly description: string;
  readonly inputSchema: ObjectSchema;
}[] = [
  {
    name: 'endowment_status',
    writes: false,
    description:
      "Read the endowments that fund this mandate's agent: the stocks the principal is held in and how many " +
      'shares of each, what the principal is worth at the reference prices, the yearly and monthly draw (a ' +
      'share of the average of up to twelve quarterly valuations, held between 3% and 6% of the principal and stopped while it is worth under 80% of what was put in), what has ' +
      'accrued and can be drawn now, how many patrons have given, and what the agent has earned back into ' +
      'the principal. An endowment the agent owner has not accepted yet is listed with nothing accruing. ' +
      'Nothing is spent.',
    inputSchema: { type: 'object', properties: { endowment: ENDOWMENT_PROPERTY } },
  },
  {
    name: 'endowment_draw',
    writes: true,
    description:
      'Move what has accrued in this agent\'s endowment into this mandate, less the protocol\'s share. The ' +
      'principal stays invested; only the draw moves, and it then spends under the mandate\'s limits like ' +
      'any other funds. Drawing also shows the endowment the agent is active: after 180 days without a draw ' +
      'from the agent\'s side it can be passed to a successor. Refused when nothing has accrued.',
    inputSchema: { type: 'object', properties: { endowment: ENDOWMENT_PROPERTY } },
  },
];

function named(args: Record<string, unknown>): Address | null {
  return args['endowment'] === undefined ? null : (String(args['endowment']) as Address);
}

export const ENDOWMENT_HANDLERS: Readonly<
  Record<string, (gateway: EndowmentGateway, args: Record<string, unknown>) => Promise<unknown>>
> = {
  endowment_status: (gateway, args) => gateway.status(named(args)),
  endowment_draw: (gateway, args) => gateway.draw(named(args)),
};
