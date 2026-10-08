import { createConfig, createStorage, cookieStorage } from 'wagmi';
import { injected, safe, walletConnect } from 'wagmi/connectors';
import { custom } from 'viem';

import { CHAIN } from '../chain/rhc';
import { rhcPool } from '../chain/client';

/**
 * Wallet configuration.
 *
 * The transport is the same paced pool every read in this app uses. A bare `http()` here would
 * work on its own and quietly compete with the rest of the tab for the endpoint's per-second meter.
 *
 * The Safe connector matters more here than it usually does: the principal on a mandate is often
 * a Safe, the contracts verify its signatures over ERC-1271, and a Safe signs without ever
 * producing a key. Nothing in this app holds or asks for one.
 */
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();

/**
 * The site this app is served from, for the wallets that show it before they sign.
 *
 * In the browser the origin is the one the reader is on, which is the only honest
 * answer. This config is also built on the server, where there is no origin to read, so the
 * deployed URL is configured and never guessed: `https://localhost` is a different site from the
 * one a phone is being asked to trust.
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.trim();

function walletMetadata() {
  const url = typeof window === 'undefined' ? SITE_URL ?? '' : window.location.origin;

  return {
    name: 'Bursar',
    description: 'Spending mandates for agents, enforced on Robinhood Chain.',
    url,
    // WalletConnect takes absolute URLs only, and a phone with no icon shows an unnamed request
    // next to an amount.
    icons: url === '' ? [] : [`${url}/brand/mark.png`],
  };
}

export function createWagmiConfig() {
  return createConfig({
    chains: [CHAIN],
    connectors: [
      injected({ shimDisconnect: true }),
      ...(projectId
        ? [
            walletConnect({
              projectId,
              showQrModal: true,
              metadata: walletMetadata(),
            }),
          ]
        : []),
      safe({ allowedDomains: [/app\.safe\.global$/, /safe\.global$/] }),
    ],
    transports: {
      [CHAIN.id]: custom(
        { request: ({ method, params }) => rhcPool().request(method, (params ?? []) as readonly unknown[]) },
        { retryCount: 0 },
      ),
    },
    // The connection survives a reload, and the server render knows about it, so the header does
    // not flash "Connect" at someone who is already connected.
    storage: createStorage({ storage: cookieStorage }),
    ssr: true,
  });
}

/**
 * One config for the process. wagmi keys its state off the config object, so building a second one
 * on a re-render drops the connection the first one was holding.
 */
let cached: ReturnType<typeof createWagmiConfig> | undefined;

export function wagmiConfig() {
  cached ??= createWagmiConfig();
  return cached;
}

export const WALLETCONNECT_CONFIGURED = projectId !== undefined && projectId !== '';
