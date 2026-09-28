import type { Address, Hex, TransactionReceipt } from 'viem';

import { explorerTx, requireSigner, writeOptions, type Connection } from './connection.js';
import { ContractRevertError, GasFailureError, TransactionRevertedError } from './errors.js';
import type { GasFailureReason } from './errors.js';
import { awaitReceipt } from './receipt.js';
import { gasFailureFrom, revertFrom, type GasSignal, type RevertInfo } from './revert.js';

/**
 * Turns a revert into the error a caller should see. Returning undefined leaves the generic
 * revert error in place, which is the right answer for a selector nothing has a better story for.
 */
export type ExplainRevert = (revert: RevertInfo | undefined, error: unknown) => Promise<Error | undefined>;

export type Call = {
  readonly to: Address;
  readonly data: Hex;
  /** Names the call in an error message. Use the contract function, not a sentence. */
  readonly action: string;
  readonly explain?: ExplainRevert;
};

export type Sent = {
  readonly hash: Hex;
  readonly blockNumber: bigint;
  /** The transaction on the explorer this deployment records. */
  readonly explorer: string;
  readonly receipt: TransactionReceipt;
};

/**
 * Runs the call against the current state and raises whatever it would revert with.
 *
 * Every write goes through here first. A revert caught in a simulation costs nothing and arrives
 * with its data intact, while the same revert found by sending costs gas and comes back as a
 * failed receipt with no reason attached.
 */
export async function preflight(connection: Connection, call: Call): Promise<void> {
  const { account } = requireSigner(connection, call.action);

  try {
    await connection.publicClient.call({ account, to: call.to, data: call.data });
  } catch (error) {
    throw await explained(connection, account.address, call, error);
  }
}

/**
 * Turns whatever a node threw into the error the caller should see.
 *
 * Order is the whole design. A decoded contract error is the most specific thing available and
 * wins; anything left over is checked for a gas failure before it falls through to the generic
 * revert, because that fall-through says the package could not name the reason and a gas failure
 * has a name. Getting this backwards is the defect that sent developers looking through Solidity
 * for a limit that never fired.
 */
async function explained(
  connection: Connection,
  sender: Address,
  call: Call,
  error: unknown,
): Promise<Error> {
  const revert = revertFrom(error);
  const specific = call.explain ? await call.explain(revert, error) : undefined;
  if (specific) return specific;
  if (revert) return new ContractRevertError(call.action, revert.errorName, error);

  const signal = gasFailureFrom(error);
  if (signal) return await gasFailure(connection, sender, call, signal, error);

  return new ContractRevertError(call.action, undefined, error);
}

/** The cheapest transaction there is. A sender that cannot pay for this cannot send anything. */
const INTRINSIC_GAS = 21_000n;

/**
 * What the sender can actually pay, read at the moment of failure.
 *
 * This runs on a path that has already failed once. A node that will not answer a balance read
 * should cost the caller the funding clause, not the whole error.
 */
async function gasSnapshot(
  connection: Connection,
  sender: Address,
): Promise<{ balanceWei?: bigint; maxFeePerGas?: bigint }> {
  const [balanceWei, maxFeePerGas] = await Promise.all([
    connection.publicClient.getBalance({ address: sender }).catch(() => undefined),
    priceOrFloor(connection),
  ]);

  return { balanceWei, maxFeePerGas };
}

/**
 * The price the send path would have used, so the cost quoted in a message is the real one.
 *
 * Estimated even where the chain publishes no fee floor. `feesFor` is allowed to return nothing
 * in that case, because viem will estimate for itself on the way out, but this number is what
 * separates a signer that cannot pay from a gas limit set too low. Without it every out-of-ETH
 * signer on Robinhood Chain is told to raise its gas limit, which is the one thing that will not
 * help.
 */
async function priceOrFloor(connection: Connection): Promise<bigint | undefined> {
  const floor = connection.chain.minFeeCap > 0n ? connection.chain.minFeeCap : undefined;

  try {
    const { maxFeePerGas } = await connection.publicClient.estimateFeesPerGas();
    if (maxFeePerGas === undefined) return floor;

    return floor !== undefined && maxFeePerGas < floor ? floor : maxFeePerGas;
  } catch {
    return floor;
  }
}

/**
 * Decides between a limit that was too low and a signer that is out of money.
 *
 * A node caps its estimate at what the sender can pay, so "gas required exceeds allowance" is the
 * identical sentence whether the call is enormous or the signer's ETH is gone. The balance is the
 * only thing that tells them apart, so it is read here and never inferred from the wording. What
 * is read is ETH: the signer's USDG says nothing about whether it can pay a fee.
 *
 * A limit the node rejected outright is left alone. That number is wrong at any balance.
 */
function settledReason(signal: GasSignal, balanceWei?: bigint, maxFeePerGas?: bigint): GasFailureReason {
  if (signal.reason === 'limit-below-intrinsic' || signal.reason === 'limit-above-block') {
    return signal.reason;
  }

  if (balanceWei === undefined || maxFeePerGas === undefined || maxFeePerGas <= 0n) {
    return signal.reason;
  }

  // Never below the intrinsic cost. A node that caps its estimate at what the sender can pay
  // reports an allowance of zero for an empty signer, and taking that at face value would price
  // the retry at nothing and call an empty account funded.
  const quoted = signal.gasLimit ?? signal.gasNeeded ?? INTRINSIC_GAS;
  const needed = quoted > INTRINSIC_GAS ? quoted : INTRINSIC_GAS;

  return balanceWei < needed * maxFeePerGas ? 'unfunded' : signal.reason;
}

async function gasFailure(
  connection: Connection,
  sender: Address,
  call: Call,
  signal: GasSignal,
  error: unknown,
): Promise<GasFailureError> {
  const { balanceWei, maxFeePerGas } = await gasSnapshot(connection, sender);

  return new GasFailureError(
    {
      reason: settledReason(signal, balanceWei, maxFeePerGas),
      action: call.action,
      sender,
      balanceWei,
      maxFeePerGas,
      gasLimit: signal.gasLimit,
      gasNeeded: signal.gasNeeded,
      nodeMessage: signal.nodeMessage,
    },
    error,
  );
}

type Fees = { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };

/**
 * A chain that enforces a floor on `maxFeePerGas` publishes it as `minFeeCap`, and an estimate
 * taken during a quiet block can land under it: such a transaction is refused outright rather
 * than mined late, so the floor is applied here. Robinhood Chain sets none, and the branch below
 * falls straight through to viem's own estimate.
 */
async function feesFor(connection: Connection): Promise<Fees> {
  const floor = connection.chain.minFeeCap;
  if (floor <= 0n) return {};

  const fees = await connection.publicClient.estimateFeesPerGas();
  if (fees.maxFeePerGas === undefined) return {};

  return {
    maxFeePerGas: fees.maxFeePerGas < floor ? floor : fees.maxFeePerGas,
    ...(fees.maxPriorityFeePerGas === undefined
      ? {}
      : { maxPriorityFeePerGas: fees.maxPriorityFeePerGas }),
  };
}

/** Simulates, sends, and waits for a mined success. Anything short of that throws. */
export async function sendCall(connection: Connection, call: Call): Promise<Sent> {
  const signer = requireSigner(connection, call.action);
  const { walletClient, account } = signer;

  await preflight(connection, call);

  let hash: Hex;

  try {
    hash = await walletClient.sendTransaction({
      // The deployment's chain, never the wallet's own. viem checks it against the chain the
      // wallet is on before signing, so a wallet switched to another network refuses here.
      ...writeOptions(signer, connection.chain),
      to: call.to,
      data: call.data,
      ...(await feesFor(connection)),
    });
  } catch (error) {
    // Broadcasting estimates gas first. The two failures a caller cannot see coming, an estimate
    // the node rejects and a fee it cannot cover, surface here and not as a receipt.
    throw await explained(connection, account.address, call, error);
  }

  const receipt = await mined(connection, account.address, call, hash);

  return { hash, blockNumber: receipt.blockNumber, explorer: explorerTx(connection, hash), receipt };
}

async function mined(
  connection: Connection,
  sender: Address,
  call: Call,
  hash: Hex,
): Promise<TransactionReceipt> {
  try {
    return await awaitReceipt(connection, hash, call.action);
  } catch (error) {
    if (!(error instanceof TransactionRevertedError)) throw error;
    throw (await outOfGasOnChain(connection, sender, call, hash, error)) ?? error;
  }
}

/**
 * A reverted receipt carries no reason, and exactly one cause can be read off it anyway: a
 * transaction that consumed its entire limit ran out of gas. Every other revert hands back what
 * it did not use, so `gasUsed` landing on the limit is the signature.
 *
 * Both reads are best effort. If the node will not answer them the plain revert stands, which is
 * what the caller would have got anyway.
 */
async function outOfGasOnChain(
  connection: Connection,
  sender: Address,
  call: Call,
  hash: Hex,
  cause: unknown,
): Promise<GasFailureError | undefined> {
  try {
    const [receipt, transaction] = await Promise.all([
      connection.publicClient.getTransactionReceipt({ hash }),
      connection.publicClient.getTransaction({ hash }),
    ]);

    if (receipt.gasUsed < transaction.gas) return undefined;

    const { balanceWei, maxFeePerGas } = await gasSnapshot(connection, sender);

    return new GasFailureError(
      {
        reason: 'out-of-gas',
        action: call.action,
        sender,
        balanceWei,
        maxFeePerGas: maxFeePerGas ?? transaction.maxFeePerGas,
        gasLimit: transaction.gas,
        hash,
      },
      cause,
    );
  } catch {
    return undefined;
  }
}
