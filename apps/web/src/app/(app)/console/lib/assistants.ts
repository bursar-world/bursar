import type { AssistantConnectFields } from '@bursar/sdk';
import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';

/**
 * The console's side of a hosted assistant connection.
 *
 * The host is reached through this app's own API routes, which hold its address and pass the
 * request on. Everything below is the wire shape of its answers and the few pure helpers the
 * panel needs: the fields the owner signs, and the sentences the screen repeats about custody.
 */

export type ConnectorSettings = {
  readonly endpoint: string;
  readonly endpointWithToken: string;
  readonly chatgpt: { readonly name: string; readonly url: string; readonly authentication: string; readonly steps: readonly string[] };
  readonly claude: { readonly name: string; readonly url: string; readonly steps: readonly string[] };
  readonly claudeCode: { readonly command: string };
  readonly gemini: { readonly settings: string; readonly steps: readonly string[] };
};

export type PublicConnection = {
  readonly id: string;
  readonly chainId: number;
  readonly mandate: Address;
  readonly owner: Address;
  readonly agent: Address;
  readonly label: string | null;
  readonly status: 'active' | 'revoked';
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
};

export type CreatedConnection = {
  readonly connection: PublicConnection;
  readonly token: string;
  readonly settings: ConnectorSettings;
};

/** What the host, or the route in front of it, answered when it did not answer with the thing asked for. */
export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HostError';
  }
}

/** Hosted connections are off on a deployment that names no host. The panel says so and offers nothing. */
export function hostUnavailable(error: unknown): boolean {
  return error instanceof HostError && error.code === 'unconfigured';
}

export const CUSTODY_LINE =
  'The host keeps this agent’s key and signs with it when your assistant pays. The limits on this mandate are what bound it: the amount per payment, the budget per period, the payees and the capabilities you allowed. Pause the mandate or revoke the agent here and the assistant can spend nothing.';

export const TOKEN_ONCE_LINE = 'Shown once. Copy it into your assistant now; the host keeps only a fingerprint of it.';

export function connectFields(input: { readonly mandate: Address; readonly owner: Address; readonly chainId: number; readonly label?: string }): AssistantConnectFields {
  const nonce = new Uint8Array(16);
  globalThis.crypto.getRandomValues(nonce);
  const label = input.label?.trim();
  return {
    mandate: getAddress(input.mandate),
    owner: getAddress(input.owner),
    chainId: input.chainId,
    nonce: `0x${Array.from(nonce, (byte) => byte.toString(16).padStart(2, '0')).join('')}` as Hex,
    issuedAt: new Date().toISOString(),
    ...(label === undefined || label === '' ? {} : { label }),
  };
}

async function answer<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HostError('malformed', 'The host answered with something that is not JSON.', response.status);
  }
  if (!response.ok) {
    const failure = body as { error?: string; detail?: string };
    throw new HostError(failure.error ?? 'host_failed', failure.detail ?? 'The host refused the request.', response.status);
  }
  return body as T;
}

export async function listConnections(mandate: Address): Promise<readonly PublicConnection[]> {
  const response = await fetch(`/api/assistants?mandate=${mandate}`, { cache: 'no-store' });
  return (await answer<{ connections: readonly PublicConnection[] }>(response)).connections;
}

export async function createConnection(fields: AssistantConnectFields, signature: Hex): Promise<CreatedConnection> {
  const response = await fetch('/api/assistants', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...fields, signature }),
  });
  return answer<CreatedConnection>(response);
}

export async function revokeConnection(id: string, fields: AssistantConnectFields, signature: Hex): Promise<PublicConnection> {
  const response = await fetch(`/api/assistants/${id}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...fields, signature }),
  });
  return (await answer<{ connection: PublicConnection }>(response)).connection;
}
