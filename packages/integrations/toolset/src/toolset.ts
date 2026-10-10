import { LockStatus, escrow, formatUsdg, mandateAccount, micro, usdg } from '@bursar/sdk';
import type { Decision, Lock, MandateStatus, Micro } from '@bursar/sdk';
import { getAddress } from 'viem';
import type { Account, Address, Chain, Hex, Transport, WalletClient } from 'viem';

import { agentKeyFromEnv } from './key.js';
import type { Job, LockReader, MandateClient, SpendCap, ToolArgs, ToolParameter, ToolSpec } from './types.js';

export type ToolsetOptions = {
  /** The mandate account this agent spends from. */
  readonly mandate: Address;
  /** The agent's key, or an account built elsewhere. Without one the toolset reads and quotes but cannot pay. */
  readonly account?: Account | Hex;
  readonly walletClient?: WalletClient<Transport, Chain, Account>;
  /** One endpoint or several. Left out, the chain's endpoint with a keyless fallback behind it. */
  readonly rpc?: string | readonly string[];
  /** What this agent may spend on top of the mandate's own limits. */
  readonly spendCap?: SpendCap;
  /** Seconds a provider gets to deliver when a call does not say. Defaults to ten minutes. */
  readonly deliverWithinSeconds?: number;
  /** Tool names start with this. Defaults to `bursar_`. */
  readonly prefix?: string;
  /** A client and escrow reader already opened, for tests and for callers that hold a connection. */
  readonly client?: MandateClient;
  readonly locks?: LockReader;
};

const ADDRESS = '^0x[0-9a-fA-F]{40}$';
const CAPABILITY = '^(?:(?:service|hire|rwa):)?[^\\s:]+:[^\\s:]+$';
const DIGITS = '^(?:0|[1-9][0-9]*)$';
const MAX_DELIVERY_SECONDS = 2_592_000;
const DEFAULT_DELIVERY_SECONDS = 600;

const AMOUNT_UNIT = 'USDG in six-decimal units, digits only: "1000000" is 1.00 USDG and "250000" is 0.25 USDG.';

/** An argument the caller got wrong. Its message goes back as the tool's answer. */
class ArgumentRefusal extends Error {}

const STATUS_WORDS: Readonly<Record<LockStatus, string>> = {
  [LockStatus.None]: 'not on the escrow',
  [LockStatus.Locked]: 'held in escrow',
  [LockStatus.Released]: 'paid to the provider',
  [LockStatus.TimedOut]: 'returned to the mandate',
  [LockStatus.Disputed]: 'disputed',
  [LockStatus.Cancelled]: 'cancelled',
  [LockStatus.Resolved]: 'split by a resolver',
};

function usd(value: bigint): string {
  return formatUsdg(micro(value < 0n ? 0n : value));
}

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function readAddress(name: string, value: string | null | undefined): Address {
  if (!value || !new RegExp(ADDRESS).test(value)) {
    throw new ArgumentRefusal(`${name} must be a 0x-prefixed 20-byte address.`);
  }
  return getAddress(value);
}

function readCapability(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!new RegExp(CAPABILITY).test(trimmed)) {
    throw new ArgumentRefusal('capability must be named and versioned, like "gpu.render:1".');
  }
  return trimmed;
}

function readAmount(value: string | null | undefined): Micro {
  const text = value?.trim() ?? '';
  if (/^-/.test(text)) {
    throw new ArgumentRefusal(
      'amount counts up from 1 and cannot be negative. Funds return to a mandate when a provider misses ' +
        'its deadline, never through a payment.',
    );
  }
  if (/[.,]/.test(text)) {
    throw new ArgumentRefusal(`amount must be ${AMOUNT_UNIT} Write 1.50 USDG as "1500000".`);
  }
  if (!new RegExp(DIGITS).test(text)) throw new ArgumentRefusal(`amount must be ${AMOUNT_UNIT}`);
  const atomic = BigInt(text);
  if (atomic === 0n) throw new ArgumentRefusal('amount must be at least 1, which is a millionth of a USDG.');
  return micro(atomic);
}

function readSeconds(value: string | null | undefined, fallback: number): number {
  const text = value?.trim();
  if (!text) return fallback;
  if (!new RegExp(DIGITS).test(text)) throw new ArgumentRefusal('deliverWithinSeconds must be a whole number of seconds.');
  const seconds = Number(text);
  if (seconds < 1 || seconds > MAX_DELIVERY_SECONDS) {
    throw new ArgumentRefusal(`deliverWithinSeconds must be between 1 and ${MAX_DELIVERY_SECONDS}.`);
  }
  return seconds;
}

function readId(value: string | null | undefined): bigint | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (!/^[1-9][0-9]*$/.test(text)) throw new ArgumentRefusal('settlementId must be a positive whole number.');
  return BigInt(text);
}

/** Free text is committed as `{ text }`; a JSON object is committed as written. */
function readInput(value: string | null | undefined): unknown {
  const text = value?.trim();
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') return parsed;
  } catch {
    // Plain text, committed below.
  }
  return { text };
}

function stateOf(status: MandateStatus, now: Date): string {
  if (status.revoked) return 'revoked';
  if (status.paused) return 'paused';
  const t = BigInt(Math.floor(now.getTime() / 1000));
  if (t < status.limits.validFrom) return 'not open yet';
  if (status.limits.validUntil !== 0n && t > status.limits.validUntil) return 'expired';
  return 'active';
}

/** An error's message, with the first line of what caused it when that adds a fact. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (!(cause instanceof Error)) return error.message;
  const detail = ((cause as { shortMessage?: string }).shortMessage ?? cause.message).split('\n')[0]?.trim();
  return detail && !error.message.includes(detail) ? `${error.message} (${detail})` : error.message;
}

function failure(error: unknown): string {
  return `The call failed: ${describe(error)}`;
}

/**
 * Four tools over one Bursar mandate: inspect, quote, pay and settlements. Strings in, strings
 * out, so every agent framework can carry them. One instance is one agent: it keeps that agent's
 * spend against its cap and the table of what it has paid for.
 */
export class BursarToolset {
  readonly mandate: Address;
  readonly cap: SpendCap;
  readonly prefix: string;

  readonly #canSign: boolean;
  readonly #deliverWithinSeconds: number;
  readonly #open: () => Promise<{ client: MandateClient; locks: LockReader }>;
  readonly #jobs = new Map<bigint, Job>();
  #opened: Promise<{ client: MandateClient; locks: LockReader }> | undefined;
  #spent: Micro = micro(0n);

  constructor(options: ToolsetOptions) {
    if ((options.client === undefined) !== (options.locks === undefined)) {
      throw new Error('Pass client and locks together, or neither.');
    }
    this.mandate = readAddress('mandate', options.mandate);
    this.cap = options.spendCap ?? {};
    this.prefix = options.prefix ?? 'bursar_';
    this.#deliverWithinSeconds = options.deliverWithinSeconds ?? DEFAULT_DELIVERY_SECONDS;
    this.#canSign = Boolean(options.account ?? options.walletClient ?? options.client);

    const { client, locks, account, walletClient, rpc } = options;
    this.#open = client && locks
      ? () => Promise.resolve({ client, locks })
      : async () => {
          const opened = await mandateAccount(this.mandate, {
            ...(account === undefined ? {} : { account }),
            ...(walletClient === undefined ? {} : { walletClient }),
            ...(rpc === undefined ? {} : { rpc }),
          });
          return { client: opened, locks: await escrow(opened.connection, opened.escrow) };
        };
  }

  /** What this agent has spent through this toolset. Refunds are not credited back. */
  get spent(): Micro {
    return this.#spent;
  }

  /** Every payment this toolset made, newest first. */
  get jobs(): readonly Job[] {
    return [...this.#jobs.values()].reverse();
  }

  #connection(): Promise<{ client: MandateClient; locks: LockReader }> {
    this.#opened ??= this.#open();
    return this.#opened;
  }

  #capRefusal(amount: Micro): string | undefined {
    const { perCall, total } = this.cap;
    if (perCall !== undefined && amount > perCall) {
      return `Refused by this agent's cap: one call may spend at most ${usd(perCall)} and this one asks for ${usd(amount)}.`;
    }
    if (total !== undefined && this.#spent + amount > total) {
      return (
        `Refused by this agent's cap: it may spend ${usd(total)} in total, has spent ${usd(this.#spent)}, ` +
        `and this call asks for ${usd(amount)}.`
      );
    }
    return undefined;
  }

  #capLine(): string {
    const { perCall, total } = this.cap;
    if (perCall === undefined && total === undefined) return 'This agent has no cap of its own beyond the mandate.';
    const parts: string[] = [];
    if (perCall !== undefined) parts.push(`${usd(perCall)} per call`);
    if (total !== undefined) parts.push(`${usd(total)} in total, ${usd(this.#spent)} spent, ${usd(total - this.#spent)} left`);
    return `This agent's cap: ${parts.join('; ')}.`;
  }

  #refusal(decision: Decision): string {
    if (decision.reason === 'approval-required') {
      return (
        `${decision.message} This toolset carries no approval, so ask the principal to raise the threshold ` +
        'or pay less than it.'
      );
    }
    return decision.message;
  }

  async inspect(): Promise<string> {
    const { client, locks } = await this.#connection();
    const status = await client.status();
    const now = new Date();
    const { limits, remaining } = status;
    const lines = [
      `Mandate ${status.address} on Robinhood Chain (chain 4663): ${stateOf(status, now)}.`,
      `Balance ${usd(status.balance)}. Limits: ${usd(limits.perCallCap)} per call, ${usd(limits.dailyCap)} a day, ` +
        `${usd(limits.monthlyCap)} a month. Left: ${usd(remaining.daily)} today (resets in ` +
        `${duration(remaining.dailyResetsAt.getTime() - now.getTime())}), ${usd(remaining.monthly)} this month ` +
        `(resets in ${duration(remaining.monthlyResetsAt.getTime() - now.getTime())}). ` +
        `Spends of ${usd(limits.approvalThreshold)} and above need the principal's signature.`,
    ];
    if (status.total !== null) lines.push(`Lifetime budget: ${usd(status.total.remaining)} left of ${usd(status.total.cap)}.`);
    lines.push(
      `The escrow locks no payment under ${usd(locks.terms.minLock)}; deliveries from ${locks.terms.minTtl} to ` +
        `${locks.terms.maxTtl} seconds.`,
      this.#capLine(),
      this.#canSign
        ? `Agent ${status.agent} signs; this toolset can pay.`
        : `Agent ${status.agent}. This toolset holds no key, so it reads and quotes but cannot pay.`,
      `Amounts are ${AMOUNT_UNIT}`,
    );
    return lines.join('\n');
  }

  async quote(args: ToolArgs): Promise<string> {
    const provider = readAddress('provider', args.provider);
    const capability = readCapability(args.capability);
    const amount = readAmount(args.amount);
    const capped = this.#capRefusal(amount);
    if (capped) return capped;

    const { client } = await this.#connection();
    const decision = await client.preview({ to: provider, amount, capability });
    if (!decision.allowed) return this.#refusal(decision);

    const balance = await client.balance();
    if (balance < amount) {
      return (
        `The limits allow ${usd(amount)} to ${provider} for ${capability}, but the mandate holds ${usd(balance)}. ` +
        'Ask the principal to fund it before paying.'
      );
    }
    return (
      `Allowed: ${usd(amount)} to ${provider} for ${capability}. After it, ${usd(decision.remaining.daily - amount)} ` +
      `is left today and ${usd(decision.remaining.monthly - amount)} this month. Pay it with ${this.prefix}pay.`
    );
  }

  async pay(args: ToolArgs): Promise<string> {
    const provider = readAddress('provider', args.provider);
    const capability = readCapability(args.capability);
    const amount = readAmount(args.amount);
    const input = readInput(args.input);
    const ttlSeconds = readSeconds(args.deliverWithinSeconds, this.#deliverWithinSeconds);
    if (!this.#canSign) {
      return 'This toolset holds no agent key, so it can read the mandate and quote spends but not pay. Open it with the agent account to pay.';
    }
    const capped = this.#capRefusal(amount);
    if (capped) return capped;

    const { client } = await this.#connection();
    const decision = await client.preview({ to: provider, amount, capability });
    if (!decision.allowed) return this.#refusal(decision);

    let receipt;
    try {
      receipt = await client.pay({
        to: provider,
        amount,
        capability,
        ttlSeconds,
        ...(input === undefined ? {} : { input }),
      });
    } catch (error) {
      return `The payment did not go through: ${describe(error)}`;
    }

    this.#spent = micro(this.#spent + amount);
    this.#jobs.set(receipt.escrowId, {
      settlementId: receipt.escrowId,
      provider,
      capability,
      amount,
      hash: receipt.hash,
      explorer: receipt.explorer,
      deadline: receipt.deadline,
      paidAt: new Date(),
    });

    return [
      `Paid ${usd(amount)} to ${provider} for ${capability}. Settlement ${receipt.escrowId} is held in escrow until ` +
        `${iso(receipt.deadline)}: the provider is paid when it delivers by then, and the funds return to the mandate if it does not.`,
      `Transaction ${receipt.hash} (${receipt.explorer}).`,
      `Left: ${usd(receipt.remaining.daily)} today, ${usd(receipt.remaining.monthly)} this month. ${this.#capLine()}`,
    ].join('\n');
  }

  async settlements(args: ToolArgs): Promise<string> {
    const id = readId(args.settlementId);
    const { locks } = await this.#connection();
    if (id !== undefined) {
      const lock = await locks.get(id);
      if (lock.status === LockStatus.None) return `No settlement ${id} on the escrow.`;
      return this.#line(id, lock);
    }
    if (this.#jobs.size === 0) return 'This agent has paid for nothing yet through this toolset.';
    const lines = await Promise.all(this.jobs.map(async (job) => this.#line(job.settlementId, await locks.get(job.settlementId))));
    return lines.join('\n');
  }

  #line(id: bigint, lock: Lock): string {
    const job = this.#jobs.get(id);
    const capability = job?.capability ?? lock.capabilityId;
    const when = lock.status === LockStatus.Locked
      ? ` until ${iso(new Date(Number(lock.deadline) * 1000))}`
      : lock.releasedAt > 0n ? ` at ${iso(new Date(Number(lock.releasedAt) * 1000))}` : '';
    const tx = job ? ` · ${job.explorer}` : '';
    return `#${id} · ${usd(lock.amount)} to ${lock.payee} for ${capability} · ${STATUS_WORDS[lock.status]}${when}${tx}`;
  }

  /** The four tools, named with this toolset's prefix, for an adapter to wrap. */
  tools(): readonly ToolSpec[] {
    const guard = (fn: (args: ToolArgs) => Promise<string>) => async (args: ToolArgs) => {
      try {
        return await fn(args);
      } catch (error) {
        return error instanceof ArgumentRefusal ? error.message : failure(error);
      }
    };
    const provider: ToolParameter = {
      name: 'provider',
      description: 'The provider being paid, as a 0x address.',
      required: true,
      pattern: ADDRESS,
    };
    const capability: ToolParameter = {
      name: 'capability',
      description: 'What is being bought, named and versioned: "gpu.render:1". The mandate allows each one by name.',
      required: true,
      pattern: CAPABILITY,
    };
    const amount: ToolParameter = {
      name: 'amount',
      description: `${AMOUNT_UNIT} A decimal point is not accepted.`,
      required: true,
      pattern: DIGITS,
    };
    return [
      {
        name: `${this.prefix}inspect`,
        description:
          'Read the spending mandate this agent is bound to: the per-call cap, the daily and monthly budgets ' +
          'and what is left in each, the amount at and above which the principal has to sign, the balance, ' +
          "whether the mandate is active, the escrow's smallest payment, and this agent's own cap. Nothing is " +
          'spent. Start here when you do not know what you are allowed to buy.',
        parameters: [],
        writes: false,
        call: guard(() => this.inspect()),
      },
      {
        name: `${this.prefix}quote`,
        description:
          'Ask the mandate what it would decide about one spend before making it. The answer says whether the ' +
          'spend would settle and, when it would not, which limit stopped it. Nothing moves and nothing is charged.',
        parameters: [provider, capability, amount],
        writes: false,
        call: guard((args) => this.quote(args)),
      },
      {
        name: `${this.prefix}pay`,
        description:
          'Pay a provider for one job from the mandate. The amount is locked in escrow and goes to the ' +
          'provider when it delivers before the deadline; if it does not, the funds return to the mandate. The ' +
          'contract enforces the limits, so a spend outside them does not settle whatever this tool is told. The ' +
          'mandate is asked first, and a spend it would refuse is not sent. The reply carries a settlement id; ' +
          `follow it with ${this.prefix}settlements.`,
        parameters: [
          provider,
          capability,
          amount,
          {
            name: 'input',
            description:
              'What the provider is being paid to do. Plain text, or a JSON object. It is committed with the ' +
              'payment, so both sides can prove what was asked.',
            required: false,
          },
          {
            name: 'deliverWithinSeconds',
            description:
              'How long the provider has to deliver before the funds return to the mandate. Defaults to ' +
              `${this.#deliverWithinSeconds}. The escrow bounds it, and ${this.prefix}inspect reports the range.`,
            required: false,
            pattern: DIGITS,
          },
        ],
        writes: true,
        call: guard((args) => this.pay(args)),
      },
      {
        name: `${this.prefix}settlements`,
        description:
          'List what this agent has paid for, newest first, with where each payment stands: held in escrow ' +
          'while the provider works, paid to the provider, returned to the mandate, disputed, or split by a ' +
          'resolver. Pass a settlementId to read one payment, including one made elsewhere. Nothing is spent.',
        parameters: [
          {
            name: 'settlementId',
            description: `The settlement id from ${this.prefix}pay. Leave it out to list this agent's payments.`,
            required: false,
            pattern: '^[1-9][0-9]*$',
          },
        ],
        writes: false,
        call: guard((args) => this.settlements(args)),
      },
    ];
  }
}

export function createToolset(options: ToolsetOptions): BursarToolset {
  return new BursarToolset(options);
}

/**
 * A toolset from the environment: `BURSAR_MANDATE`, the agent key as `agentKeyFromEnv` reads it,
 * `BURSAR_RPC` (comma separated), and the agent's cap as `BURSAR_SPEND_CAP` and
 * `BURSAR_SPEND_CAP_PER_CALL` in USDG, written as "0.50".
 */
export function toolsetFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ToolsetOptions> = {}): BursarToolset {
  const mandate = overrides.mandate ?? env.BURSAR_MANDATE?.trim();
  if (!mandate) throw new Error('BURSAR_MANDATE is not set. It is the mandate account the agent spends from.');
  const account = agentKeyFromEnv(env);
  const rpc = env.BURSAR_RPC?.split(',').map((s) => s.trim()).filter(Boolean);
  const total = env.BURSAR_SPEND_CAP?.trim();
  const perCall = env.BURSAR_SPEND_CAP_PER_CALL?.trim();
  const spendCap: SpendCap = {
    ...(total ? { total: usdg(total) } : {}),
    ...(perCall ? { perCall: usdg(perCall) } : {}),
  };
  return new BursarToolset({
    mandate: mandate as Address,
    ...(account === undefined ? {} : { account }),
    ...(rpc && rpc.length > 0 ? { rpc } : {}),
    spendCap,
    ...overrides,
  });
}
