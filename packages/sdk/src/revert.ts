import { decodeErrorResult, isHex, size, slice, toFunctionSelector } from 'viem';
import type { Abi, AbiParameter, Hex } from 'viem';
import {
  agentRegistryAbi,
  assetRegistryAbi,
  collateralVaultAbi,
  creditPoolAbi,
  escrowAbi,
  mandateAccountAbi,
  mandateAccountFactoryAbi,
  oracleRegistryAbi,
  parkAdapterAbi,
  priceGuardAbi,
  reputationAbi,
  settlementAssetAbi,
  stockSpendRouterAbi,
  treasuryParkAbi,
} from '@bursar/core';

import type { GasFailureReason } from './errors.js';

/**
 * Errors raised inside the settlement asset itself.
 *
 * `SafeERC20` re-throws token revert data verbatim, so these reach whoever called the escrow or
 * the mandate account even though neither contract declares them and neither ABI carries them.
 * Transcribed from ERC-6093, which is what a modern ERC-20 raises in place of a require string.
 */
const TOKEN_ERRORS = [
  {
    type: 'error',
    name: 'ERC20InsufficientAllowance',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'allowance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'ERC20InsufficientBalance',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'balance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'ERC20InvalidApprover', inputs: [{ name: 'approver', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidReceiver', inputs: [{ name: 'receiver', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidSender', inputs: [{ name: 'sender', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidSpender', inputs: [{ name: 'spender', type: 'address' }] },
] as const;

/**
 * Every error fragment a call through this package can come back with, in one table.
 *
 * A spend goes through the mandate account into the escrow, which reads the agent registry and
 * the reputation curve and moves the settlement asset. One `spend` can therefore revert with a
 * selector declared by any of five contracts. viem decodes against the ABI it was handed, which
 * for `spend` is the account's alone, and a selector it does not recognise reaches the caller as
 * unreadable bytes. Decoding against the union is what turns that into a name.
 */
const DEPLOYMENT_ABIS = [
  ...TOKEN_ERRORS,
  ...mandateAccountAbi,
  ...mandateAccountFactoryAbi,
  ...escrowAbi,
  ...agentRegistryAbi,
  ...reputationAbi,
  ...oracleRegistryAbi,
  ...settlementAssetAbi,
  ...assetRegistryAbi,
  ...priceGuardAbi,
  ...stockSpendRouterAbi,
  ...treasuryParkAbi,
  ...parkAdapterAbi,
  ...collateralVaultAbi,
  ...creditPoolAbi,
] as unknown as Abi;

const REVERT_ABI: Abi = DEPLOYMENT_ABIS.filter((item) => item.type === 'error');

function parameterType(parameter: AbiParameter): string {
  if ('components' in parameter && parameter.components) {
    const inner = parameter.components.map(parameterType).join(',');
    return parameter.type.replace('tuple', `(${inner})`);
  }

  return parameter.type;
}

/**
 * Selector to error name, for revert data that carries no arguments.
 *
 * `previewSpend` returns four bytes and nothing else, and a node that truncates revert data leaves
 * the same shape. Both are still enough to name the error, which is the part a caller reads.
 */
const ERROR_NAMES: ReadonlyMap<Hex, string> = new Map(
  REVERT_ABI.filter((item) => item.type === 'error').map((item) => [
    toFunctionSelector(`${item.name}(${item.inputs.map(parameterType).join(',')})`),
    item.name,
  ]),
);

/** A decoded revert: the name the Solidity declared and whatever arguments came with it. */
export type RevertInfo = {
  readonly errorName: string;
  readonly args: readonly unknown[];
};

/**
 * Decodes revert data against the union of deployment ABIs. Accepts a bare four-byte selector,
 * which is what `previewSpend` returns and what the account's own refusals carry.
 */
export function decodeRevertData(data: Hex): RevertInfo | undefined {
  if (!isHex(data) || size(data) < 4) return undefined;

  try {
    const decoded = decodeErrorResult({ abi: REVERT_ABI, data });
    return { errorName: decoded.errorName, args: decoded.args ?? [] };
  } catch {
    const name = ERROR_NAMES.get(slice(data, 0, 4));
    return name === undefined ? undefined : { errorName: name, args: [] };
  }
}

type Node = Readonly<Record<string, unknown>>;

/** Deep enough for a pool failover inside a retry inside an action, and bounded against a cycle. */
const MAX_NODES = 32;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null;
}

/**
 * Every error reachable from the one thrown, outermost first.
 *
 * There is no single shape to match on. `call` wraps the RPC error in `CallExecutionError` over
 * `ExecutionRevertedError`, `simulateContract` produces `ContractFunctionRevertedError`,
 * `writeContract` and `estimateGas` each add their own layer, the RPC pool raises its own error
 * class that viem then wraps again as unknown, and a dropped socket wraps all of it once more.
 * What is stable is that the revert data is somewhere on the chain, so walk the chain.
 *
 * `cause` is the spine. `error` and `originalError` are the two other edges providers hang the
 * original JSON-RPC payload on, and an `AggregateError` from a parallel transport holds several.
 */
function chain(error: unknown): Node[] {
  const seen = new Set<unknown>();
  const nodes: Node[] = [];
  const queue: unknown[] = [error];

  while (queue.length > 0 && nodes.length < MAX_NODES) {
    const node = queue.shift();
    if (!isNode(node) || seen.has(node)) continue;

    seen.add(node);
    nodes.push(node);
    queue.push(node.cause, node.error, node.originalError);
    if (Array.isArray(node.errors)) queue.push(...node.errors);
  }

  return nodes;
}

/** '0x' plus a four-byte selector is the shortest thing that can name an error. */
const MIN_LENGTH = 10;

function asRevertData(value: unknown): Hex | undefined {
  if (typeof value !== 'string' || !isHex(value)) return undefined;
  return value.length >= MIN_LENGTH && value.length % 2 === 0 ? value : undefined;
}

/**
 * Revert data that only ever reached the error message.
 *
 * Some nodes report `execution reverted: 0x…` and carry no structured `data` at all. Only
 * `details` is read, never `message`: viem folds the request body into `message`, and the
 * calldata in it opens with a four-byte selector that would decode as confidently as the real
 * thing. That is how a timed-out socket would come back named after a limit nobody hit.
 */
function dataInText(node: Node): Hex[] {
  const details = node.details;
  if (typeof details !== 'string' || details.length > 512) return [];
  if (!/revert/i.test(details)) return [];

  return (details.match(/0x[0-9a-fA-F]{8,}/g) ?? [])
    .slice(0, 4)
    .flatMap((match) => asRevertData(match) ?? []);
}

/** Where the hex might sit on one error, most authoritative first. */
function dataOn(node: Node): Hex[] {
  const found: Hex[] = [];
  const take = (value: unknown): void => {
    const data = asRevertData(value);
    if (data !== undefined) found.push(data);
  };

  take(node.raw);
  take(node.data);

  if (isNode(node.data)) {
    take(node.data.data);
    if (isNode(node.data.originalError)) take(node.data.originalError.data);
  }

  // The pool's RpcResponseError repeats the payload under `details`, which is a record there and
  // a string on everything viem throws.
  if (isNode(node.details)) take(node.details.data);

  return [...found, ...dataInText(node)];
}

/**
 * The name viem decoded itself, read by shape rather than by class.
 *
 * `instanceof ContractFunctionRevertedError` is only true for the copy of viem that threw, and a
 * workspace resolving two copies is ordinary. The shape is the contract worth matching.
 */
function decodedOn(node: Node): RevertInfo | undefined {
  if (!isNode(node.data)) return undefined;

  const errorName = node.data.errorName;
  if (typeof errorName !== 'string') return undefined;

  return { errorName, args: Array.isArray(node.data.args) ? node.data.args : [] };
}

/**
 * Names the contract error behind a failed call, wherever in the error it ended up.
 *
 * Only data that decodes against a deployed ABI is returned. A call that ran out of gas, a node
 * that refused the transaction and a socket that closed all arrive looking roughly like a revert
 * and carry no selector, and reporting one of those as a refusal by name would be worse than
 * reporting nothing: the caller would go looking for a limit that never fired.
 */
export function revertFrom(error: unknown): RevertInfo | undefined {
  for (const node of chain(error)) {
    const decoded = decodedOn(node);
    if (decoded) return decoded;

    for (const data of dataOn(node)) {
      const info = decodeRevertData(data);
      if (info) return info;
    }
  }

  return undefined;
}

/**
 * True when a read came back empty.
 *
 * An address holding no code answers every call with `0x`, and so does a contract that has no such
 * function, so viem raises `ContractFunctionZeroDataError` for both. Matched by name and by
 * wording, because `instanceof` holds only for the copy of viem that threw.
 */
export function returnedNoData(error: unknown): boolean {
  return chain(error).some(
    (node) =>
      node.name === 'ContractFunctionZeroDataError' ||
      (typeof node.shortMessage === 'string' && /returned no data/iu.test(node.shortMessage)),
  );
}

/**
 * True when the contract answered and the answer was no: a revert, with or without data this
 * package can name, or an empty return.
 *
 * Kept apart from `revertFrom`, which only reports what it can name. A read that treats "the
 * token has no such function" as a fact has to be sure it heard from the token, and a dropped
 * socket or a rate limit is not the token saying anything.
 */
export function contractSaidNo(error: unknown): boolean {
  if (returnedNoData(error)) return true;

  return chain(error).some(
    (node) =>
      node.name === 'ContractFunctionRevertedError' ||
      node.name === 'ExecutionRevertedError' ||
      dataOn(node).length > 0,
  );
}

/** What a node said about gas, before a balance is read and the reason is settled. */
export type GasSignal = {
  readonly reason: GasFailureReason;
  /** The limit the transaction carried, when the wording quoted it. */
  readonly gasLimit: bigint | undefined;
  /** What the node said the call needs, or the ceiling it was held to. */
  readonly gasNeeded: bigint | undefined;
  /** The sentence this was read out of, so a log line can show the node's own words. */
  readonly nodeMessage: string;
};

function isText(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * The strings one error in the chain describes a gas failure with.
 *
 * `details` is where viem puts the node's own sentence, `shortMessage` is where it puts the
 * numbers it parsed out of it, and the class name is a third statement of the same thing, so all
 * three are matched together. `message` is read only from an error carrying none of them, which
 * is a raw JSON-RPC object or a plain Error: viem folds the request body into `message`, and
 * matching on that would classify a failure by its own calldata.
 */
function gasText(node: Node): string {
  const described = [node.shortMessage, node.details].filter(isText);
  const parts = described.length > 0 ? described : [node.message].filter(isText);

  return [node.name, ...parts].filter(isText).join(' | ').slice(0, 2000);
}

function firstNumber(text: string, ...patterns: readonly RegExp[]): bigint | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1] !== undefined) return BigInt(match[1]);
  }

  return undefined;
}

/** viem's wording for the limit the transaction carried. */
const SUPPLIED = /gas \((\d+)\) provided/i;

const OVER_BLOCK =
  /exceeds (the limit allowed for the block|block gas limit)|gas_limit > env\.block\.gas_limit|intrinsic gas too high/i;

/**
 * Numbers are read per reason, never by pattern alone. Geth's insufficient-funds sentence is
 * "have 0 want 100" in wei, and the same `have`/`want` pair in its intrinsic-gas sentence is in
 * gas, so a shared regex would report a fee as a gas limit.
 */
function amounts(reason: GasFailureReason, text: string): Pick<GasSignal, 'gasLimit' | 'gasNeeded'> {
  switch (reason) {
    case 'limit-below-intrinsic':
      return {
        gasLimit: firstNumber(text, SUPPLIED, /\bhave (\d+)/i),
        gasNeeded: firstNumber(text, /\bwant (\d+)/i),
      };

    case 'limit-above-block':
      return {
        gasLimit: firstNumber(text, SUPPLIED),
        gasNeeded: firstNumber(text, /block gas limit[:\s]+\(?(\d+)/i),
      };

    case 'estimate-failed':
      return { gasLimit: undefined, gasNeeded: firstNumber(text, /allowance[:\s]+\(?(\d+)/i) };

    case 'out-of-gas':
    case 'unfunded':
      return { gasLimit: firstNumber(text, SUPPLIED), gasNeeded: undefined };
  }
}

/**
 * Geth and revm describe the same failures in different words. Robinhood Chain runs Arbitrum
 * Nitro, which is geth-derived, while every local run here is revm, so both wordings are matched,
 * in the one order that is safe.
 *
 * Two traps are load-bearing. revm reports a limit below the intrinsic cost as "intrinsic gas too
 * high -- CallGasCostMoreThanGasLimit". That is the opposite of what it reads like, and it opens
 * the same way as its block-limit error, so the suffix decides. Its estimate failure opens "Out of
 * gas: gas required exceeds allowance", so the allowance has to be tested before the plain
 * out-of-gas match or every estimate failure would be called an execution one.
 */
function classify(text: string): GasFailureReason | undefined {
  if (/insufficient funds/i.test(text)) return 'unfunded';
  if (/intrinsic gas too low|CallGasCostMoreThanGasLimit/i.test(text)) return 'limit-below-intrinsic';
  if (OVER_BLOCK.test(text)) return 'limit-above-block';
  if (/gas required exceeds allowance/i.test(text)) return 'estimate-failed';
  if (/out\s*of\s*gas/i.test(text)) return 'out-of-gas';

  return undefined;
}

/**
 * Names the gas failure behind a call, wherever in the error the node's wording ended up.
 *
 * Separate from `revertFrom` because a gas failure carries no selector: a package that only looks
 * for revert data reports it as a contract refusal with nothing to point at. That is
 * the worst answer available, because it sends a developer hunting for a condition in Solidity
 * when the fix is a number in the transaction or a balance on the signer.
 */
export function gasFailureFrom(error: unknown): GasSignal | undefined {
  for (const node of chain(error)) {
    const text = gasText(node);
    const reason = classify(text);
    if (reason === undefined) continue;

    return {
      reason,
      ...amounts(reason, text),
      nodeMessage: typeof node.details === 'string' ? node.details : text,
    };
  }

  return undefined;
}
