import {
  accessRegistryAbi,
  decodeRelayData,
  proofFromWire,
  shieldedEntrypointAbi,
  shieldedPoolAbi,
  shieldedRelayAbi,
  withdrawSignals,
  withdrawalContext,
  type RelayQuote,
  type RelayResult,
  type SolidityProof,
  type WireProof,
  type Withdrawal,
} from '@bursar/sdk';
import {
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  isAddress,
  isAddressEqual,
  isHex,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';

import type { GasDropLedger } from './drops.js';

export type RelayerConfig = {
  readonly chainId: number;
  readonly relay: Address;
  readonly pool: Address;
  readonly entrypoint: Address;
  readonly registry: Address;
  readonly scope: bigint;
  /** Where the relay fee goes. Every request must name it. */
  readonly feeRecipient: Address;
  /** The fee this relayer asks for, in basis points of the withdrawal. */
  readonly feeBps: number;
  /** Wei sent to a fresh recipient that asks for gas, once its withdrawal has landed. Zero turns gas drops off. */
  readonly gasDropWei: bigint;
  /** Gas drops allowed per rolling day, across all recipients. */
  readonly gasDropsPerDay: number;
  /** What one ETH is worth, in USDG atomic units, which is how a drop is priced into the fee. Read while drops are on. */
  readonly ethPrice: bigint;
  /** Smallest withdrawal relayed, in USDG atomic units. */
  readonly minWithdrawal: bigint;
};

/** The SDK's quote, plus what a withdrawal that asks for gas pays on top of `feeBps`. */
export type RelayerQuote = RelayQuote & {
  /** USDG atomic units for the drop and the transfer that carries it, at the current gas price. "0" with drops off. */
  readonly gasDropFee: string;
};

/** Gas a plain ETH transfer burns, which is what carries a drop. */
const TRANSFER_GAS = 21_000n;
const WEI_PER_ETH = 10n ** 18n;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export class RelayRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}

type Client = Pick<
  PublicClient,
  'readContract' | 'simulateContract' | 'waitForTransactionReceipt' | 'getBalance' | 'getCode' | 'getTransactionCount' | 'getGasPrice'
>;

/** What the relayer answers. The SDK's `RelayResult`, plus the hash of the gas transfer when one was made. */
export type RelayOutcome = RelayResult & { readonly gasDropTransactionHash?: Hex };

type Parsed = { withdrawal: Withdrawal; proof: SolidityProof; gasDrop: boolean };

function parse(body: unknown): Parsed {
  if (typeof body !== 'object' || body === null) throw new RelayRefusal(400, 'bad_request', 'The body must be a JSON object.');
  const b = body as Record<string, unknown>;
  const w = b['withdrawal'] as Record<string, unknown> | undefined;
  if (!w || typeof w['processooor'] !== 'string' || !isAddress(w['processooor']) || typeof w['data'] !== 'string' || !isHex(w['data'])) {
    throw new RelayRefusal(400, 'bad_request', 'withdrawal needs a processooor address and hex data.');
  }
  let proof: SolidityProof;
  try {
    proof = proofFromWire(b['proof'] as WireProof);
  } catch {
    throw new RelayRefusal(400, 'bad_proof', 'The proof is malformed: pA and pC hold two decimal field elements, pB is two by two, and pubSignals is a list.');
  }
  if (proof.pubSignals.length !== 8) throw new RelayRefusal(400, 'bad_proof', 'A withdrawal proof has eight public signals.');
  if (b['gasDrop'] !== undefined && typeof b['gasDrop'] !== 'boolean') {
    throw new RelayRefusal(400, 'bad_request', 'gasDrop must be true or false.');
  }
  return {
    withdrawal: { processooor: getAddress(w['processooor']), data: w['data'] },
    proof,
    gasDrop: b['gasDrop'] === true,
  };
}

function revertName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? (revert.data?.errorName ?? revert.reason ?? null) : null;
}

/**
 * Checks a withdrawal request against everything the chain will check, and a few things only a
 * relayer cares about, then submits it. Every refusal happens before a transaction is sent, so a
 * refused request never spends the note's nullifier.
 *
 * Gas is a second transaction, sent only once the withdrawal has landed: the receipt says success
 * and carries the pool's Withdrawn event for the note the proof spent. A note gets gas once, a
 * recipient gets gas once, and the day has a budget, so the float is spent on first gas for fresh
 * addresses and on nothing else.
 */
export class Relayer {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: Client,
    private readonly wallet: WalletClient & { account: Account },
    private readonly chain: Chain,
    readonly config: RelayerConfig,
    private readonly drops: GasDropLedger,
    private readonly log: (line: string) => void = () => undefined,
  ) {
    if (!this.dropsOn) return;
    // The daily budget is the only bound on what the float gives away, and one that starts over
    // with each restart is no bound. The price is what lets a withdrawal pay for its own drop.
    if (drops.path === null) {
      throw new Error(
        'Gas drops are on and the ledger of drops is kept in memory, where a restart opens a fresh daily budget. ' +
          'Set RELAYER_DATA_DIR to a directory that outlives the process, or turn drops off with RELAYER_GAS_DROP_ETH=0.',
      );
    }
    if (config.ethPrice <= 0n) {
      throw new Error(
        'Gas drops are on, so each drop has to be priced into the relay fee. Set RELAYER_ETH_PRICE_USDG to what one ETH ' +
          'is worth in USDG, or turn drops off with RELAYER_GAS_DROP_ETH=0.',
      );
    }
  }

  private get dropsOn(): boolean {
    return this.config.gasDropWei > 0n && this.config.gasDropsPerDay > 0;
  }

  async quote(): Promise<RelayerQuote> {
    const gasPrice = this.dropsOn ? await this.client.getGasPrice() : 0n;
    return {
      relay: this.config.relay,
      feeRecipient: this.config.feeRecipient,
      feeBps: this.config.feeBps,
      gasDropWei: this.config.gasDropWei.toString(),
      chainId: this.config.chainId,
      gasDropFee: (this.dropsOn ? this.dropCost(gasPrice) : 0n).toString(),
    };
  }

  /** What a drop costs in USDG: the ETH handed over, and the transfer that carries it at `gasPrice`. */
  private dropCost(gasPrice: bigint): bigint {
    return ceilDiv((this.config.gasDropWei + TRANSFER_GAS * gasPrice) * this.config.ethPrice, WEI_PER_ETH);
  }

  private budgetSpent(): boolean {
    return this.drops.countToday() >= this.config.gasDropsPerDay;
  }

  async check(body: unknown): Promise<Parsed & { recipient: Address }> {
    const parsed = parse(body);
    const { withdrawal, proof } = parsed;
    const c = this.config;
    if (!isAddressEqual(withdrawal.processooor, c.relay)) {
      throw new RelayRefusal(400, 'wrong_processooor', `The withdrawal must name the relay contract ${c.relay} as processooor.`);
    }
    let data;
    try {
      data = decodeRelayData(withdrawal.data);
    } catch {
      throw new RelayRefusal(400, 'bad_relay_data', 'withdrawal.data is not (recipient, feeRecipient, relayFeeBPS).');
    }
    if (!isAddressEqual(data.feeRecipient, c.feeRecipient)) {
      throw new RelayRefusal(400, 'wrong_fee_recipient', `The fee recipient must be ${c.feeRecipient}.`);
    }
    // The relay refuses these on chain too. Paid to one of them, a withdrawal would sit with no note
    // behind it and nothing that could ever pay it out again.
    if ([c.relay, c.pool, c.entrypoint].some((contract) => isAddressEqual(data.recipient, contract))) {
      throw new RelayRefusal(
        400,
        'bad_recipient',
        'A withdrawal cannot pay the relay, the pool or the Entrypoint. Name the address that should receive the funds.',
      );
    }
    if (data.relayFeeBPS < BigInt(c.feeBps)) {
      throw new RelayRefusal(400, 'fee_too_low', `This relayer asks ${c.feeBps} basis points.`);
    }
    const signals = withdrawSignals(proof);
    if (signals.withdrawnValue < c.minWithdrawal) {
      throw new RelayRefusal(400, 'below_minimum', `The smallest withdrawal relayed is ${c.minWithdrawal} atomic USDG.`);
    }
    if (parsed.gasDrop && this.dropsOn) {
      // A withdrawal pays for the ETH it is handed, so a run of fresh addresses earns the float what
      // it spends. The transfer's gas is quoted at the moment's price and not held to here: it is a
      // fraction of a percent of the drop, and the price can move between the quote and the proof.
      const value = signals.withdrawnValue;
      const drop = this.dropCost(0n);
      const paid = (value * data.relayFeeBPS) / 10_000n;
      const owed = (value * BigInt(c.feeBps)) / 10_000n + drop;
      if (paid < owed) {
        const needed = ceilDiv(owed * 10_000n, value);
        throw new RelayRefusal(
          400,
          'fee_too_low',
          `A withdrawal that asks for gas pays for the drop: ${c.feeBps} basis points plus ${drop} atomic USDG, which is ` +
            `${needed} basis points of this one. Ask for gas at ${needed} basis points, or withdraw without it at ${c.feeBps}.`,
        );
      }
    }
    if (signals.context !== withdrawalContext(withdrawal, c.scope)) {
      throw new RelayRefusal(400, 'context_mismatch', 'The proof was made for a different withdrawal or pool.');
    }

    const [recipientBlocked, feeBlocked, spent, aspRoot] = await Promise.all([
      this.client.readContract({ address: c.registry, abi: accessRegistryAbi, functionName: 'isBlocked', args: [data.recipient] }),
      this.client.readContract({ address: c.registry, abi: accessRegistryAbi, functionName: 'isBlocked', args: [data.feeRecipient] }),
      this.client.readContract({ address: c.pool, abi: shieldedPoolAbi, functionName: 'nullifierHashes', args: [signals.existingNullifierHash] }),
      this.client.readContract({ address: c.entrypoint, abi: shieldedEntrypointAbi, functionName: 'latestRoot' }),
    ]);
    if (recipientBlocked || feeBlocked) {
      throw new RelayRefusal(403, 'recipient_blocked', 'The access registry blocks this recipient. Nothing was sent and the note is untouched.');
    }
    if (spent) throw new RelayRefusal(409, 'already_spent', 'This note has already been withdrawn.');
    if (signals.ASPRoot !== aspRoot) {
      throw new RelayRefusal(409, 'stale_association_set', 'The association set changed since this proof was made. Prove again against the latest set.');
    }
    // Said before anything is sent, so a client that wanted gas can choose to withdraw without it.
    if (parsed.gasDrop && c.gasDropWei > 0n && this.budgetSpent()) {
      throw new RelayRefusal(429, 'gas_drops_exhausted', 'No gas drops left today. Retry without gas, or tomorrow.');
    }
    return { ...parsed, recipient: data.recipient };
  }

  async relay(body: unknown): Promise<RelayOutcome> {
    const checked = await this.check(body);
    const run = this.queue.then(() => this.submit(checked));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async submit(checked: Parsed & { recipient: Address }): Promise<RelayOutcome> {
    const p = checked.proof;
    let request;
    try {
      ({ request } = await this.client.simulateContract({
        account: this.wallet.account,
        chain: this.chain,
        address: this.config.relay,
        abi: shieldedRelayAbi,
        functionName: 'relay',
        args: [
          checked.withdrawal,
          {
            pA: [p.pA[0], p.pA[1]],
            pB: [
              [p.pB[0][0], p.pB[0][1]],
              [p.pB[1][0], p.pB[1][1]],
            ],
            pC: [p.pC[0], p.pC[1]],
            pubSignals: p.pubSignals as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
          },
        ],
      }));
    } catch (error) {
      const name = revertName(error);
      throw new RelayRefusal(400, 'would_revert', name ? `The pool would refuse this withdrawal: ${name}.` : 'The pool would refuse this withdrawal.');
    }
    const hash = await this.wallet.writeContract(request);
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new RelayRefusal(502, 'reverted', `The relay transaction ${hash} reverted.`);
    const drop = checked.gasDrop ? await this.dropGas(checked, hash, receipt) : null;
    return {
      transactionHash: hash,
      gasDropWei: (drop?.wei ?? 0n).toString(),
      ...(drop ? { gasDropTransactionHash: drop.hash } : {}),
    };
  }

  /**
   * First gas for the recipient, after its withdrawal landed. Null when nothing was sent: the
   * receipt does not show the note being spent, the note or the recipient already had gas, the
   * day's budget is gone, or the recipient is not fresh (code, a nonce, or a balance of its own).
   * A transfer that cannot be made is logged and costs the withdrawal nothing.
   */
  private async dropGas(checked: Parsed & { recipient: Address }, relayHash: Hex, receipt: TransactionReceipt): Promise<{ wei: bigint; hash: Hex } | null> {
    const c = this.config;
    if (c.gasDropWei === 0n) return null;
    const note = withdrawSignals(checked.proof).existingNullifierHash;
    const { recipient } = checked;
    if (!this.withdrew(receipt, note)) {
      this.log(`relay ${relayHash} landed without a Withdrawn event for nullifier ${note}; no gas sent to ${recipient}`);
      return null;
    }
    if (this.drops.hasNote(note) || this.drops.hasRecipient(recipient) || this.budgetSpent()) return null;
    const [code, balance, nonce] = await Promise.all([
      this.client.getCode({ address: recipient }),
      this.client.getBalance({ address: recipient }),
      this.client.getTransactionCount({ address: recipient }),
    ]);
    if ((code !== undefined && code !== '0x') || nonce > 0 || balance >= c.gasDropWei) return null;

    let hash: Hex;
    try {
      hash = await this.wallet.sendTransaction({ account: this.wallet.account, chain: this.chain, to: recipient, value: c.gasDropWei });
    } catch (error) {
      this.log(`gas drop to ${recipient} after relay ${relayHash} was not sent: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    this.drops.record({ note, recipient, wei: c.gasDropWei, hash });
    try {
      const sent = await this.client.waitForTransactionReceipt({ hash });
      if (sent.status !== 'success') {
        this.log(`gas drop ${hash} to ${recipient} reverted`);
        return null;
      }
    } catch (error) {
      this.log(`gas drop ${hash} to ${recipient} has no receipt yet: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    return { wei: c.gasDropWei, hash };
  }

  /** Whether the receipt carries the pool's Withdrawn event for the note the proof spent. */
  private withdrew(receipt: TransactionReceipt, note: bigint): boolean {
    const logs = parseEventLogs({ abi: shieldedPoolAbi, eventName: 'Withdrawn', logs: receipt.logs ?? [], strict: true });
    return logs.some((log) => isAddressEqual(log.address, this.config.pool) && log.args._spentNullifier === note);
  }
}
