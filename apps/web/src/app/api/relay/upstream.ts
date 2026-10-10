import { NextResponse } from 'next/server';
import { isAddress, isHex } from 'viem';

import { ADDRESSES, CHAIN_ID } from '@/chain/rhc';
import { RELAY_API, sourceChainById } from '@/relay';

/**
 * Relay, reached through this app so the deployment's key stays on the server.
 *
 * Relay quotes without a key, and a key is what unlocks deposit addresses on Solana and a rate
 * limit of this app's own. `RELAY_API_KEY` carries no `NEXT_PUBLIC_` prefix on purpose: a key in
 * client JavaScript is a key given to everyone who opens the page. Without one the routes still
 * forward, and Relay answers as it answers anyone.
 *
 * The forward is narrow by construction. Only a quote into this deployment's settlement asset on
 * this chain is passed on, built here from the fields it needs, so the route cannot be used to
 * quote or track anything else.
 */
export const RELAY_KEY_ENV = 'RELAY_API_KEY';

const TIMEOUT_MS = 12_000;

export function relayBase(): string {
  const configured = process.env['RELAY_API_BASE']?.trim();
  return (configured === undefined || configured === '' ? RELAY_API : configured).replace(/\/+$/, '');
}

export function relayHeaders(): Record<string, string> {
  const key = process.env[RELAY_KEY_ENV]?.trim();
  return { accept: 'application/json', ...(key === undefined || key === '' ? {} : { 'x-api-key': key }) };
}

/** The quote body this app forwards, or the reason it will not. */
export function allowedQuote(body: unknown): { readonly body: Record<string, unknown> } | { readonly refused: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { refused: 'The quote has to be a JSON object.' };
  const asked = body as Record<string, unknown>;

  const originChainId = asked['originChainId'];
  if (typeof originChainId !== 'number' || sourceChainById(originChainId) === undefined) {
    return { refused: 'originChainId names a chain this console does not fund from.' };
  }
  if (asked['destinationChainId'] !== CHAIN_ID) return { refused: `destinationChainId has to be ${CHAIN_ID}.` };

  const destinationCurrency = asked['destinationCurrency'];
  if (typeof destinationCurrency !== 'string' || destinationCurrency.toLowerCase() !== ADDRESSES.usdg.toLowerCase()) {
    return { refused: 'destinationCurrency has to be the settlement asset.' };
  }

  const originCurrency = asked['originCurrency'];
  const source = sourceChainById(originChainId);
  if (typeof originCurrency !== 'string' || originCurrency.toLowerCase() !== source?.usdc.address.toLowerCase()) {
    return { refused: `originCurrency has to be USDC on ${source?.name ?? 'the source chain'}.` };
  }

  const recipient = asked['recipient'];
  if (typeof recipient !== 'string' || !isAddress(recipient)) return { refused: 'recipient has to be a 20-byte address.' };

  const user = asked['user'];
  if (typeof user !== 'string' || user === '' || user.length > 64) return { refused: 'user has to be the depositing address.' };

  const amount = asked['amount'];
  if (typeof amount !== 'string' || !/^\d{1,30}$/.test(amount) || amount === '0') return { refused: 'amount has to be a positive integer of atomic units.' };

  const depositAddress = asked['useDepositAddress'];
  if (depositAddress !== undefined && typeof depositAddress !== 'boolean') return { refused: 'useDepositAddress has to be a boolean.' };

  return {
    body: {
      user,
      recipient,
      originChainId,
      destinationChainId: CHAIN_ID,
      originCurrency,
      destinationCurrency,
      amount,
      tradeType: 'EXACT_INPUT',
      ...(depositAddress === true ? { useDepositAddress: true } : {}),
    },
  };
}

export function isRequestId(value: string | null): value is `0x${string}` {
  return value !== null && isHex(value) && value.length === 66;
}

/** One request out, Relay's own body back, under Relay's own status. */
export async function forward(path: string, init: RequestInit): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${relayBase()}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
  } catch (caught) {
    const timedOut = caught instanceof Error && caught.name === 'TimeoutError';
    return NextResponse.json(
      { message: timedOut ? 'Relay did not answer in time.' : 'Relay could not be reached.', errorCode: timedOut ? 'TIMEOUT' : 'UNREACHABLE' },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  const text = await upstream.text();
  return new Response(text === '' ? '{}' : text, {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function refused(reason: string, status = 400): Response {
  return NextResponse.json({ message: reason, errorCode: 'REFUSED_HERE' }, { status, headers: { 'cache-control': 'no-store' } });
}
