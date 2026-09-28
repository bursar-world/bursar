import { renderToStaticMarkup } from 'react-dom/server';
import type { Address } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { State } from 'wagmi';

/**
 * What the server and the first client render agree the connected account is.
 *
 * A wallet that has already granted this site reconnects on its own as soon as the page's
 * JavaScript runs, and that can land between the document hydrating and a page's own subtree
 * hydrating. Every surface that reads the account through wagmi directly then hydrates against a
 * store that moved underneath it, and React answers by throwing the server's markup away and
 * reporting a hydration error. It was reproducible on ten of the eighteen routes, on a production
 * build, with a wallet holding the site and no cookie.
 *
 * `renderToStaticMarkup` runs no effects, which is exactly the render being protected here: the
 * server's, and the client's first pass. Both have to answer with the cookie whatever the live
 * wallet is doing.
 */

const COOKIE_ACCOUNT = '0x877c349EFb5926082C413833E8055F0991185c61' as Address;
const WALLET_ACCOUNT = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374' as Address;

const live = vi.hoisted(() => ({
  current: { address: undefined as Address | undefined, isConnected: false, connector: undefined, status: 'disconnected', chainId: 4663 },
}));

vi.mock('wagmi', () => ({ useAccount: () => live.current }));

const { ServerAccountProvider, useWalletAccount } = await import('@/wallet/account');

function connectedState(address: Address): State {
  return {
    chainId: 4663,
    current: 'injected',
    connections: new Map([['injected', { accounts: [address], chainId: 4663, connector: { id: 'injected' } }]]),
    status: 'connected',
  } as unknown as State;
}

function render(state: State | undefined) {
  function Probe() {
    const account = useWalletAccount();
    return <span>{`${account.address ?? 'none'}|${account.isConnected}|${account.chainId ?? 'none'}`}</span>;
  }

  return renderToStaticMarkup(
    <ServerAccountProvider state={state}>
      <Probe />
    </ServerAccountProvider>,
  );
}

beforeEach(() => {
  live.current = { address: undefined, isConnected: false, connector: undefined, status: 'disconnected', chainId: 4663 };
});

describe('the account a surface reads before it has mounted', () => {
  it('is the one the cookie carried, so the server and the first client pass agree', () => {
    expect(render(connectedState(COOKIE_ACCOUNT))).toContain(COOKIE_ACCOUNT);
  });

  it('ignores a wallet that reconnected itself between the two renders', () => {
    live.current = { address: WALLET_ACCOUNT, isConnected: true, connector: undefined, status: 'connected', chainId: 4663 };

    const markup = render(connectedState(COOKIE_ACCOUNT));

    expect(markup).toContain(COOKIE_ACCOUNT);
    expect(markup).not.toContain(WALLET_ACCOUNT);
  });

  it('answers no account where the request carried no connection, whatever the wallet says', () => {
    live.current = { address: WALLET_ACCOUNT, isConnected: true, connector: undefined, status: 'connected', chainId: 4663 };

    expect(render(undefined)).toContain('none|false');
  });

  it('answers no account for a cookie that names no current connection', () => {
    const state = { chainId: 4663, current: undefined, connections: new Map(), status: 'disconnected' } as unknown as State;

    expect(render(state)).toContain('none|false');
  });

  it('carries the chain the connection was on, so the network prompt does not flicker', () => {
    expect(render(connectedState(COOKIE_ACCOUNT))).toContain('|4663');
  });
});
