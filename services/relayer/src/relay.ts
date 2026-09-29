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
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';

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
  /** Wei sent to a fresh recipient that asks for gas. Zero turns gas drops off. */
  readonly gasDropWei: bigint;
  /** Gas drops allowed per rolling hour, across all requests. */
  readonly gasDropsPerHour: number;
  /** Smallest withdrawal relayed, in USDG atomic units. */
  readonly minWithdrawal: bigint;
};

export class RelayRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}

type Client = Pick<PublicClient, 'readContract' | 'simulateContract' | 'waitForTransactionReceipt' | 'getBalance' | 'getCode'>;

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
  } catch (error) {
    throw new RelayRefusal(400, 'bad_proof', error instanceof Error ? error.message : 'The proof is malformed.');
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
 */
export class Relayer {
  private readonly drops: number[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: Client,
    private readonly wallet: WalletClient & { account: Account },
    private readonly chain: Chain,
    readonly config: RelayerConfig,
    private readonly now: () => number = Date.now,
  ) {}

  quote(): RelayQuote {
    return {
      relay: this.config.relay,
      feeRecipient: this.config.feeRecipient,
      feeBps: this.config.feeBps,
      gasDropWei: this.config.gasDropWei.toString(),
      chainId: this.config.chainId,
    };
  }

  private dropsLeft(): number {
    const hourAgo = this.now() - 3_600_000;
    while (this.drops.length > 0 && this.drops[0]! < hourAgo) this.drops.shift();
    return this.config.gasDropsPerHour - this.drops.length;
  }

  /** Gas goes only to a recipient that looks fresh: no code and less than one drop already. */
  private async gasDropFor(recipient: Address, asked: boolean): Promise<bigint> {
    if (!asked || this.config.gasDropWei === 0n) return 0n;
    const [code, balance] = await Promise.all([
      this.client.getCode({ address: recipient }),
      this.client.getBalance({ address: recipient }),
    ]);
    if (code !== undefined && code !== '0x') return 0n;
    if (balance >= this.config.gasDropWei) return 0n;
    if (this.dropsLeft() <= 0) throw new RelayRefusal(429, 'gas_drops_exhausted', 'No gas drops left this hour. Retry without gas, or later.');
    return this.config.gasDropWei;
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
    if (data.relayFeeBPS < BigInt(c.feeBps)) {
      throw new RelayRefusal(400, 'fee_too_low', `This relayer asks ${c.feeBps} basis points.`);
    }
    const signals = withdrawSignals(proof);
    if (signals.withdrawnValue < c.minWithdrawal) {
      throw new RelayRefusal(400, 'below_minimum', `The smallest withdrawal relayed is ${c.minWithdrawal} atomic USDG.`);
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
    return { ...parsed, recipient: data.recipient };
  }

  async relay(body: unknown): Promise<RelayResult> {
    const checked = await this.check(body);
    const run = this.queue.then(() => this.submit(checked));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async submit(checked: Parsed & { recipient: Address }): Promise<RelayResult> {
    const value = await this.gasDropFor(checked.recipient, checked.gasDrop);
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
        value,
      }));
    } catch (error) {
      const name = revertName(error);
      throw new RelayRefusal(400, 'would_revert', name ? `The pool would refuse this withdrawal: ${name}.` : 'The pool would refuse this withdrawal.');
    }
    const hash = await this.wallet.writeContract(request);
    if (value > 0n) this.drops.push(this.now());
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new RelayRefusal(502, 'reverted', `The relay transaction ${hash} reverted.`);
    return { transactionHash: hash, gasDropWei: value.toString() };
  }
}
