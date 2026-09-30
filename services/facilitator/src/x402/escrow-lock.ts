import {
  canonicalNetwork,
  capabilityId,
  createRhcClient,
  deploymentsForChain,
  escrowAbi,
  mandateAccountAbi,
  mandateAccountFactoryAbi,
} from '@bursar/core';
import type { RhcChain, RpcProvider } from '@bursar/core';
import { parseEventLogs } from 'viem';
import type { Address, Hex } from 'viem';

import { requiredAmount } from './contract.js';
import type {
  PaymentPayload,
  PaymentRequirements,
  PaymentScheme,
  SettleResult,
  SupportedResponse,
  VerifyResult,
} from './contract.js';

/**
 * The mandate lane of x402: a payment the mandate account made through its own `spend`.
 *
 * The `exact` scheme redeems a signature from a wallet, and a contract cannot sign one, so the
 * funds on that lane are the agent's and nothing on chain counts them against the mandate's daily
 * or monthly window. On this lane the agent's mandate calls `spend`, which checks every limit,
 * debits both windows and moves the quoted amount into an escrow lock payable to the merchant, in
 * one transaction. The payment the client sends back is a pointer to that lock.
 *
 * Verifying is reading the lock: open, paid by a mandate account from this deployment's factory,
 * payable to the merchant the offer names, for the amount it names, under its capability, and
 * committed to the request it is redeemed against. The commitment is the request-bound nonce, so
 * a lock opened for one request cannot be redeemed against another.
 *
 * Settling broadcasts nothing. The money already left the mandate when the lock landed; the
 * merchant takes it by releasing the lock once it has served the call, with its own key, the way
 * every escrow payment is collected.
 */

export const ESCROW_SCHEME = 'escrow';

/** The reasons this lane refuses a payment for. Each is a 402 a client can act on. */
export const ESCROW_REASON = {
  payload: 'invalid_escrow_payload',
  scheme: 'unsupported_scheme',
  network: 'invalid_network',
  escrow: 'escrow_not_recognised',
  asset: 'invalid_asset',
  notLocked: 'escrow_lock_not_open',
  payer: 'escrow_payer_not_a_mandate',
  payee: 'escrow_payee_mismatch',
  amount: 'escrow_amount_mismatch',
  capability: 'escrow_capability_mismatch',
  commit: 'escrow_commit_mismatch',
  deadline: 'escrow_deadline_too_close',
  transaction: 'escrow_transaction_mismatch',
  unreadable: 'escrow_state_unreadable',
} as const;

/** What the client sends: the lock its mandate opened, and the transaction that opened it. */
export type LockReference = {
  readonly escrow: Address;
  readonly id: bigint;
  readonly mandate: Address;
  readonly transaction: Hex;
  readonly inputCommit: Hex;
};

export type EscrowLock = {
  readonly payer: Address;
  readonly payee: Address;
  readonly capabilityId: Hex;
  readonly inputCommit: Hex;
  readonly amount: bigint;
  readonly deadline: bigint;
  readonly status: number;
};

/** The chain reads this lane needs. A test passes a double. */
export type EscrowChain = {
  lock(escrow: Address, id: bigint): Promise<EscrowLock>;
  /** The escrow a mandate account locks into, and the principal that owns it. */
  mandate(account: Address): Promise<{ readonly escrow: Address; readonly principal: Address }>;
  /** Every account the factory created for a principal. */
  accountsOf(factory: Address, principal: Address): Promise<readonly Address[]>;
  /** The ids of the `Locked` events `escrow` emitted in a successful transaction. */
  lockedIn(transaction: Hex, escrow: Address): Promise<readonly bigint[]>;
  now(): Promise<bigint>;
};

export type EscrowDeployment = {
  readonly escrow: Address;
  readonly factory: Address;
  readonly asset: Address;
};

export type EscrowLockSchemeOptions = {
  readonly chainId: number;
  readonly chain: EscrowChain;
  /**
   * Defaults to every deployment the chain still reads: the set that answers for it and each set it
   * supersedes, whose mandates can still pay through their own escrow.
   */
  readonly deployments?: readonly EscrowDeployment[];
  /** Seconds the merchant needs after verify to serve and release. Defaults to 60. */
  readonly minRemainingSeconds?: number;
};

/** Lock status `Locked` in `IEscrow.LockStatus`. */
const LOCKED = 1;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** The lock a payload points at, or null when it does not carry one in the expected shape. */
export function lockReference(payload: PaymentPayload): LockReference | null {
  const raw = payload.payload?.['lock'];
  if (!raw || typeof raw !== 'object') return null;
  const lock = raw as Record<string, unknown>;
  const { escrow, mandate, transaction, inputCommit, id } = lock;
  if (typeof escrow !== 'string' || !ADDRESS.test(escrow)) return null;
  if (typeof mandate !== 'string' || !ADDRESS.test(mandate)) return null;
  if (typeof transaction !== 'string' || !HASH.test(transaction)) return null;
  if (typeof inputCommit !== 'string' || !HASH.test(inputCommit)) return null;
  if (typeof id !== 'string' || !/^\d{1,78}$/.test(id)) return null;
  return {
    escrow: escrow as Address,
    id: BigInt(id),
    mandate: mandate as Address,
    transaction: transaction.toLowerCase() as Hex,
    inputCommit: inputCommit.toLowerCase() as Hex,
  };
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export function createEscrowLockScheme(options: EscrowLockSchemeOptions): PaymentScheme {
  const network = `eip155:${options.chainId}`;
  const minRemaining = BigInt(options.minRemainingSeconds ?? 60);
  const deployments =
    options.deployments ??
    deploymentsForChain(options.chainId).map((d) => ({
      escrow: d.contracts.Escrow,
      factory: d.contracts.MandateAccountFactory,
      asset: d.settlementAsset,
    }));

  const refuse = (invalidReason: string, payer?: Address): VerifyResult =>
    payer === undefined ? { isValid: false, invalidReason } : { isValid: false, invalidReason, payer };

  async function verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult> {
    if (requirements.scheme !== ESCROW_SCHEME) return refuse(ESCROW_REASON.scheme);
    if (canonicalNetwork(String(requirements.network ?? '')) !== network) return refuse(ESCROW_REASON.network);

    const reference = lockReference(payload);
    if (!reference) return refuse(ESCROW_REASON.payload);
    const payer = reference.mandate;

    const deployment = deployments.find((d) => same(d.escrow, reference.escrow));
    if (!deployment) return refuse(ESCROW_REASON.escrow, payer);
    if (!same(String(requirements.asset ?? ''), deployment.asset)) return refuse(ESCROW_REASON.asset, payer);

    const amount = requiredAmount(requirements);
    const payTo = String(requirements.payTo ?? '');
    if (amount === null || amount <= 0n || !ADDRESS.test(payTo)) return refuse(ESCROW_REASON.payload, payer);

    try {
      const lock = await options.chain.lock(reference.escrow, reference.id);
      if (lock.status !== LOCKED) return refuse(ESCROW_REASON.notLocked, payer);
      if (!same(lock.payer, reference.mandate)) return refuse(ESCROW_REASON.payer, payer);
      if (!same(lock.payee, payTo)) return refuse(ESCROW_REASON.payee, payer);
      if (lock.amount !== amount) return refuse(ESCROW_REASON.amount, payer);
      if (!same(lock.inputCommit, reference.inputCommit)) return refuse(ESCROW_REASON.commit, payer);

      const label = requirements.extra?.['capability'];
      if (typeof label === 'string' && !same(lock.capabilityId, capabilityId(label))) {
        return refuse(ESCROW_REASON.capability, payer);
      }

      if (lock.deadline <= (await options.chain.now()) + minRemaining) return refuse(ESCROW_REASON.deadline, payer);

      // Only a mandate account's `spend` locks from a mandate account, and `spend` is what debits
      // the windows. So the payer has to be one this deployment's factory made, locking into the
      // escrow the lock is in.
      const account = await options.chain.mandate(reference.mandate);
      if (!same(account.escrow, reference.escrow)) return refuse(ESCROW_REASON.payer, payer);
      const accounts = await options.chain.accountsOf(deployment.factory, account.principal);
      if (!accounts.some((entry) => same(entry, reference.mandate))) return refuse(ESCROW_REASON.payer, payer);

      const ids = await options.chain.lockedIn(reference.transaction, reference.escrow);
      if (!ids.includes(reference.id)) return refuse(ESCROW_REASON.transaction, payer);
    } catch {
      return refuse(ESCROW_REASON.unreadable, payer);
    }

    return { isValid: true, payer, method: ESCROW_SCHEME, amount };
  }

  return {
    supported(): SupportedResponse {
      return { kinds: [{ x402Version: 2, scheme: ESCROW_SCHEME, network }] };
    },
    verify,
    async settle(payload, requirements): Promise<SettleResult> {
      const verdict = await verify(payload, requirements);
      const reference = lockReference(payload);
      if (!verdict.isValid || !reference) {
        return {
          success: false,
          settled: false,
          broadcast: false,
          errorReason: verdict.isValid ? ESCROW_REASON.payload : verdict.invalidReason,
          payer: verdict.payer ?? '',
          transaction: '',
          network,
        };
      }
      return {
        success: true,
        settled: true,
        broadcast: false,
        payer: verdict.payer,
        transaction: reference.transaction,
        network,
        method: ESCROW_SCHEME,
      };
    },
  };
}

/** The chain reads above, over the deployment's RPC providers. */
export function createEscrowChain(input: {
  readonly chain: RhcChain;
  readonly providers?: readonly RpcProvider[];
}): EscrowChain {
  const { client } = createRhcClient({ chain: input.chain, ...(input.providers ? { providers: input.providers } : {}) });
  return {
    async lock(escrow, id) {
      const lock = await client.readContract({ address: escrow, abi: escrowAbi, functionName: 'getLock', args: [id] });
      return {
        payer: lock.payer,
        payee: lock.payee,
        capabilityId: lock.capabilityId,
        inputCommit: lock.inputCommit,
        amount: lock.amount,
        deadline: lock.deadline,
        status: lock.status,
      };
    },
    async mandate(account) {
      const [escrow, principal] = await Promise.all([
        client.readContract({ address: account, abi: mandateAccountAbi, functionName: 'escrow' }),
        client.readContract({ address: account, abi: mandateAccountAbi, functionName: 'principal' }),
      ]);
      return { escrow, principal };
    },
    async accountsOf(factory, principal) {
      return client.readContract({
        address: factory,
        abi: mandateAccountFactoryAbi,
        functionName: 'accountsOf',
        args: [principal],
      });
    },
    async lockedIn(transaction, escrow) {
      const receipt = await client.getTransactionReceipt({ hash: transaction });
      if (receipt.status !== 'success') return [];
      return parseEventLogs({ abi: escrowAbi, eventName: 'Locked', logs: receipt.logs })
        .filter((log) => same(log.address, escrow))
        .map((log) => log.args.id);
    },
    async now() {
      return (await client.getBlock()).timestamp;
    },
  };
}

/**
 * One scheme in front of two: offers named `escrow` go to the mandate lane, everything else to
 * the `exact` scheme, which refuses what it does not recognise in its own words.
 */
export function routeSchemes(exact: PaymentScheme, escrow: PaymentScheme): PaymentScheme {
  const pick = (requirements: PaymentRequirements) =>
    requirements.scheme === ESCROW_SCHEME ? escrow : exact;
  return {
    async supported() {
      const [left, right] = await Promise.all([exact.supported(), escrow.supported()]);
      return { ...left, kinds: [...left.kinds, ...right.kinds] };
    },
    verify: (payload, requirements, options) => pick(requirements).verify(payload, requirements, options),
    settle: (payload, requirements, options) => pick(requirements).settle(payload, requirements, options),
  };
}
