/**
 * The agent key hand-off.
 *
 * A private mandate's agent signs from a stealth address. The owner's console computes that
 * address's private key from the owner's spending and viewing keys and exports it, together with
 * the mandate and the readable terms the agent proves against, as one JSON file. The agent runtime
 * (the SDK or the MCP server) reads the file and needs nothing else.
 *
 * The file is a secret: it spends from the mandate within its terms, and it reveals the terms.
 */

import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { readTermsDocument, type TermsDocument } from './committed.js';
import { InvalidArgumentError } from './errors.js';

export const AGENT_HANDOFF_KIND = 'bursar.agent-key';

export type AgentHandoff = {
  readonly kind: typeof AGENT_HANDOFF_KIND;
  readonly v: 1;
  readonly chainId: number;
  readonly mandate: Address;
  readonly agent: Address;
  readonly privateKey: Hex;
  readonly terms: TermsDocument;
  /** First block to read the mandate's events from. */
  readonly fromBlock: number;
};

export function agentHandoff(args: {
  chainId: number;
  mandate: Address;
  privateKey: Hex;
  terms: TermsDocument;
  fromBlock: number | bigint;
}): AgentHandoff {
  return {
    kind: AGENT_HANDOFF_KIND,
    v: 1,
    chainId: args.chainId,
    mandate: getAddress(args.mandate),
    agent: privateKeyToAccount(args.privateKey).address,
    privateKey: args.privateKey,
    terms: args.terms,
    fromBlock: Number(args.fromBlock),
  };
}

export function agentHandoffFileName(mandate: Address): string {
  return `bursar-agent-key-${mandate.slice(2, 10).toLowerCase()}.json`;
}

/**
 * Reads a hand-off file, checking that the key really is the named agent's, so a file edited by
 * hand or pasted into the wrong runtime fails here rather than at the first spend.
 */
export function readAgentHandoff(input: string | unknown): AgentHandoff {
  const fail = (message: string): never => {
    throw new InvalidArgumentError('handoff', message, {});
  };
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      fail('The agent key file is not JSON.');
    }
  }
  if (typeof value !== 'object' || value === null) return fail('The agent key file is not an object.');
  const r = value as Record<string, unknown>;
  if (r['kind'] !== AGENT_HANDOFF_KIND || r['v'] !== 1) fail('This is not a Bursar agent key file.');
  const { chainId, mandate, agent, privateKey, terms, fromBlock } = r;
  if (typeof chainId !== 'number' || !Number.isInteger(chainId)) fail('The file names no chain.');
  if (typeof mandate !== 'string' || !isAddress(mandate, { strict: false })) fail('The file names no mandate.');
  if (typeof agent !== 'string' || !isAddress(agent, { strict: false })) fail('The file names no agent.');
  if (typeof privateKey !== 'string' || !isHex(privateKey) || privateKey.length !== 66) fail('The file holds no private key.');
  if (typeof fromBlock !== 'number' || !Number.isInteger(fromBlock) || fromBlock < 0) fail('The file names no start block.');
  let t: TermsDocument;
  try {
    t = readTermsDocument(terms);
  } catch (error) {
    return fail(`The file holds no usable terms: ${error instanceof Error ? error.message : String(error)}`);
  }
  const derived = privateKeyToAccount(privateKey as Hex).address;
  if (derived.toLowerCase() !== (agent as string).toLowerCase()) fail('The private key in the file is not the agent it names.');
  return {
    kind: AGENT_HANDOFF_KIND,
    v: 1,
    chainId: chainId as number,
    mandate: getAddress(mandate as string),
    agent: derived,
    privateKey: privateKey as Hex,
    terms: t,
    fromBlock: fromBlock as number,
  };
}
