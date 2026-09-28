import { createPublicClient, custom } from 'viem';
import { describe, expect, it } from 'vitest';

import { RHC_MAINNET, viemChain } from '@bursar/core';
import type { RhcPublicClient } from '@bursar/core';

import { createMandateChain } from '../src/chain.js';
import { ChainUnavailableError } from '../src/errors.js';
import type { Address } from '../src/document.js';

/**
 * What a caller is told when a chain read does not come back.
 *
 * An address with no contract at it is the shape a pasted or wrong-network `MANDATE_ACCOUNT`
 * takes, and it is the one failure here that an operator fixes by editing a variable. The answer
 * has to say that, in this service's own words: a transport library's message, with its stack of
 * wrappers and its documentation link, is written for whoever is debugging that library.
 */

const EMPTY: Address = '0x0000000000000000000000000000000000000001';

/** A node answering `eth_call` the way every node answers a call to an address with no code. */
function nodeWithNoContract(): RhcPublicClient {
  return createPublicClient({
    chain: viemChain(RHC_MAINNET),
    transport: custom(
      {
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_chainId') return `0x${RHC_MAINNET.chainId.toString(16)}`;
          if (method === 'eth_call') return '0x';
          throw new Error(`this node does not answer ${method}`);
        },
      },
      { retryCount: 0 },
    ),
  });
}

/** A node that is reachable and refuses the call, which is what an endpoint in trouble looks like. */
function nodeThatFails(): RhcPublicClient {
  return createPublicClient({
    chain: viemChain(RHC_MAINNET),
    transport: custom(
      {
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_chainId') return `0x${RHC_MAINNET.chainId.toString(16)}`;
          throw new Error('connect ECONNREFUSED 127.0.0.1:8545');
        },
      },
      { retryCount: 0 },
    ),
  });
}

describe('a chain read that cannot be answered', () => {
  it('names the address and the chain rather than forwarding the library that noticed', async () => {
    const chain = createMandateChain(nodeWithNoContract());

    const failure = await chain.readAccount(EMPTY).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ChainUnavailableError);
    const error = failure as ChainUnavailableError;
    expect(error.code).toBe('underwriter_chain_unavailable');
    expect(error.message).toContain(EMPTY);
    expect(error.message).toContain(RHC_MAINNET.name);
    expect(error.message).toContain(String(RHC_MAINNET.chainId));
    expect(error.message).toContain('Either nothing is deployed there');
    expect(error.details).toEqual({ what: `MandateAccount ${EMPTY}`, address: EMPTY, chainId: RHC_MAINNET.chainId });
  });

  it('names the chain when the endpoint itself will not answer', async () => {
    const chain = createMandateChain(nodeThatFails());

    const error = (await chain
      .readAccount(EMPTY)
      .catch((cause: unknown) => cause)) as ChainUnavailableError;

    // A chain that did not answer and an address with nothing at it are fixed by different people.
    // Both say which chain, because the first thing to rule out is an endpoint on the wrong one.
    expect(error.code).toBe('underwriter_chain_unavailable');
    expect(error.message).toContain(RHC_MAINNET.name);
    expect(error.message).toContain(String(RHC_MAINNET.chainId));
    expect(error.message).not.toContain('Either nothing is deployed there');
    expect(error.details).toMatchObject({ chainId: RHC_MAINNET.chainId });
  });

  it('keeps no library text in anything a customer is shown', async () => {
    const chain = createMandateChain(nodeWithNoContract());

    const error = (await chain.readAccount(EMPTY).catch((cause: unknown) => cause)) as ChainUnavailableError;

    const shown = JSON.stringify({ detail: error.message, details: error.details });
    expect(shown).not.toContain('viem.sh');
    expect(shown).not.toContain('Docs:');
    expect(shown).not.toContain('returned no data');
    // The original is kept where an operator reading a log can still find it.
    expect(String((error as { cause?: unknown }).cause)).toContain('0x');
  });
});
