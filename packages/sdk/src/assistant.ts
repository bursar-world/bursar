import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';

/**
 * The message an owner signs to connect a hosted assistant to a mandate.
 *
 * A hosted MCP endpoint holds an agent key on the owner's behalf, so handing one out has to be the
 * owner's decision and nobody else's. The console builds this text, the wallet signs it as a plain
 * message, and the host rebuilds the same text from the fields and checks the signature against
 * the mandate's principal. Nothing in it is a transaction: no gas, no funds, no approval.
 *
 * The nonce makes each signature good for one connection, and the timestamp bounds how long a
 * signature stays usable, so one that leaks later opens nothing.
 */

export const ASSISTANT_CONNECT_VERSION = 1;

/** Labels are shown back in the console and in connector lists, so they are short and one line. */
export const ASSISTANT_LABEL_MAX_CHARS = 40;

export type AssistantConnectFields = {
  readonly mandate: Address;
  readonly owner: Address;
  readonly chainId: number;
  /** Sixteen random bytes, fresh for every signature. */
  readonly nonce: Hex;
  /** When the owner signed, as an ISO 8601 instant. */
  readonly issuedAt: string;
  /** What the owner calls this connection: "ChatGPT", "Claude on my laptop". Optional. */
  readonly label?: string;
};

export type AssistantDisconnectFields = AssistantConnectFields & {
  /** The connection being cut, as the host named it. */
  readonly connection: string;
};

export function assistantConnectMessage(fields: AssistantConnectFields): string {
  return [
    'Bursar: connect an assistant',
    '',
    'Sign to let a hosted assistant spend from this mandate as its agent. This signature sends no',
    'transaction, moves no funds and costs no gas. The limits on the mandate bound what the',
    'assistant can do.',
    '',
    ...lines(fields),
  ].join('\n');
}

export function assistantDisconnectMessage(fields: AssistantDisconnectFields): string {
  return [
    'Bursar: disconnect an assistant',
    '',
    'Sign to cut this connection. The host stops answering its token at once. This signature sends',
    'no transaction, moves no funds and costs no gas.',
    '',
    `Connection: ${fields.connection}`,
    ...lines(fields),
  ].join('\n');
}

function lines(fields: AssistantConnectFields): string[] {
  const label = fields.label === undefined ? undefined : checkLabel(fields.label);
  return [
    `Mandate: ${getAddress(fields.mandate)}`,
    `Owner: ${getAddress(fields.owner)}`,
    `Chain: ${fields.chainId}`,
    `Nonce: ${checkNonce(fields.nonce)}`,
    `Issued: ${checkInstant(fields.issuedAt)}`,
    ...(label === undefined || label === '' ? [] : [`Label: ${label}`]),
    `Version: ${ASSISTANT_CONNECT_VERSION}`,
  ];
}

/** A label the message can carry: trimmed, one line, at most forty characters. Empty is allowed. */
export function checkLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length > ASSISTANT_LABEL_MAX_CHARS) {
    throw new RangeError(`A connection label is at most ${ASSISTANT_LABEL_MAX_CHARS} characters.`);
  }
  if (/[\r\n\t]/u.test(trimmed) || /[^\x20-\x7e -￿]/u.test(trimmed)) {
    throw new RangeError('A connection label is one line of printable text.');
  }
  return trimmed;
}

function checkNonce(nonce: Hex): Hex {
  if (!/^0x[0-9a-f]{32}$/u.test(nonce)) throw new RangeError('The nonce is sixteen bytes of lowercase hex.');
  return nonce;
}

function checkInstant(instant: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(instant) || Number.isNaN(Date.parse(instant))) {
    throw new RangeError('The issue time is an ISO 8601 instant in UTC.');
  }
  return instant;
}
